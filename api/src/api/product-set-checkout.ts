import { planSnapshotInheritedSql } from './plan-snapshot-lines';
import { productSetAssignmentSql } from '../domain/planAssignments';
import { recordPaymentAttempt } from './payment-attempt';
import { AttemptMethod } from '../domain/paymentAttemptMethod';
import { payerCheckoutUrl } from './checkout-url';
import crypto from 'crypto';
import { db, Tx } from '../infra/db';

type Exec = { query: Tx['query'] };
import { getPaymentProvider } from '../payments';
import { toMinorUnits } from '../payments/money';
import { BlockingEvent, blockingEvents, LockEvent } from '../domain/billingEventEditLock';
import { normaliseProviderStatus } from '../domain/providerPaymentStatus';
import { setCartLiveSql } from '../domain/cartExpiry';
import { staffProductDraftSql } from './editable-draft';
import { BillingEventLineRow, lineFromSimulation, linesTotal } from '../domain/billingEventLines';
import { planScheduledEvents } from './product-set-configuration';
import { PLAN_SCHEDULE_KEY } from '../domain/scheduleAllocation';
import type { SimulationLine } from '../domain/billingSimulation';
import { scheduleOwnerOfSetSql } from '../domain/scheduleOwner';
import { chargeableSetPurchases, linkSetPurchasesToEvent, purchaseChargeLine } from './set-purchases';
import { cartChargeLine, cartPurchasesForCharge, joinCartPurchasesToEvent } from './cart-checkout';
import { purchaseName, purchaseOfSet, stampEventPurchase } from './purchases';
import { writeEventLines } from './billing-event-lines-writer';
import { initialEventNameFor } from './billing-event-name';
import { loadInitialChargeTaxRates } from './initial-charge-taxes';
import { initialLineTaxRate, withLineTax } from '../domain/initialChargeTaxes';
import { applyInitialPaymentWaivers, initialPaymentLineKeys, lineWaivable } from '../domain/initialPaymentWaiver';
import { loadInitialPaymentWaivers } from './initial-payment-waivers';

/**
 * #1325 PR 2d — the editing lock's SQL half, and the checkout of a ProductSet.
 *
 * `domain/billingEventEditLock.ts` decides; this reads the owner's events and
 * their latest attempts, and writes the initial obligation and its payment
 * request. Like `plan-checkout.ts` it writes the **initial real Billing Event
 * before the money moves**, so the ledger already shows the charge pending and
 * the payment webhook settles that event rather than appending a second one —
 * and it is that same webhook, through `activateWithEvents()`, that activates
 * the set. A return from the hosted page activates nothing.
 */

/**
 * The unresolved, past-due events of an owner who holds an **active** Product
 * Set, if any. #2125 M5d-2: every Product Set of the owner (their whole
 * history), not one chain — there is no chain identity any more.
 */
export async function loadEditLock(gymId: string, ownerMemberId: number, today: string): Promise<BlockingEvent[]> {
  const { rows } = await db.query<any>(
    `SELECT be.id, be.billing_date, be.is_scheduled, be.event_type, be.cancelled_at,
            (SELECT pr.method FROM payment_requests pr WHERE pr.billing_event_id = be.id
              ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS method,
            (SELECT pr.provider_status FROM payment_requests pr WHERE pr.billing_event_id = be.id
              ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS provider_status,
            (SELECT pr.status FROM payment_requests pr WHERE pr.billing_event_id = be.id
              ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS attempt_status,
            (SELECT COUNT(*) FROM payment_requests pr WHERE pr.billing_event_id = be.id) AS attempts
       FROM billing_events be
       JOIN product_sets ps ON ps.id = be.product_set_id
      WHERE be.gym_id = ? AND ps.owner_member_id = ?
        AND EXISTS (SELECT 1 FROM product_sets a
                     WHERE a.gym_id = ? AND a.owner_member_id = ? AND a.status = 'active')
        AND be.event_type NOT IN ('status_changed')`,
    [gymId, ownerMemberId, gymId, ownerMemberId],
  );
  const events: LockEvent[] = rows.map((r: any) => ({
    id: Number(r.id),
    billingDate: r.billing_date instanceof Date ? r.billing_date.toISOString().slice(0, 10) : String(r.billing_date ?? '').slice(0, 10) || null,
    isScheduled: Number(r.is_scheduled) === 1,
    eventType: String(r.event_type),
    cancelled: r.cancelled_at != null,
    latestAttempt: Number(r.attempts) > 0
      ? { method: (r.method ?? 'provider') as AttemptMethod, providerStatus: normaliseProviderStatus(r.provider_status), status: String(r.attempt_status) }
      : null,
  }));
  return blockingEvents(events, today);
}

/**
 * #2811 — the lock asked by a route that opens the member's Draft for editing
 * (`POST /product-sets/draft`, its Members App twin, a recurring Product added by
 * staff). A Draft that already exists is always editable: the lock guards opening a
 * **new** one and committing one (Save & Pay, activation), never an edit of a Draft
 * the member already holds. So the lock is empty while the owner holds a live plain
 * Draft (the one `ensureRecurringDraft()` reuses: no linked assignment, not expired).
 */
export async function loadEditLockForDraftEdit(
  gymId: string, ownerMemberId: number, today: string, opts: { staff?: boolean } = {},
): Promise<BlockingEvent[]> {
  // #2858/#2891: for staff, any live Draft of the owner is one they keep editing (`staffProductDraftSql()`).
  const { rows } = await db.query<any>(
    `SELECT ps.id FROM product_sets ps
      WHERE ps.gym_id = ? AND ps.owner_member_id = ?
        AND ${opts.staff ? staffProductDraftSql('ps') : `${setCartLiveSql('ps')} AND ${productSetAssignmentSql('ps')} IS NULL`}
      LIMIT 1`,
    [gymId, ownerMemberId]);
  if (rows.length > 0) return [];
  return loadEditLock(gymId, ownerMemberId, today);
}

async function carriesInheritedNativePlans(gymId: string, productSetId: number, exec: Exec): Promise<boolean> {
  const { rows } = await exec.query(
    `SELECT SUM(${planSnapshotInheritedSql('s', 'psj.product_set_id')}) AS inherited,
            SUM(NOT ${planSnapshotInheritedSql('s', 'psj.product_set_id')}) AS added
       FROM product_set_plan_snapshots psj JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id
      WHERE s.gym_id = ? AND psj.product_set_id = ? AND psj.entitlement_only = 0`, [gymId, productSetId]);
  // A version that adds a plan beside running ones holds both kinds; a plain clone is all inherited.
  return Number(rows[0]?.inherited ?? 0) > 0 && Number(rows[0]?.added ?? 0) > 0;
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

export interface InitialCharge {
  amount: number;
  /** The same lines in the simulation's own shape (#1867), for the Draft forecast. */
  simulationLines: SimulationLine[];
  lines: BillingEventLineRow[];
  scheduleKey: string | null;
  /**
   * #2949 stage 5: the standalone cart purchases (no Product Set carries them) this charge includes,
   * with the amount each was charged at; the initial event joins exactly these.
   */
  cartPurchases?: Array<{ id: number; amount: number; product_name: string }>;
  /**
   * #3046: the date the first payment falls due when the version's lines start after its own
   * start date (a Product added to a Draft later). Absent means the start date.
   */
  billingDate?: string;
  /** #3167: every date whose engine events this charge covers (the forecast shows them once, here). */
  coveredDates?: string[];
}

/**
 * #3046 — the events a version's first payment covers: those on its start date, plus, for a
 * schedule with nothing on that date, its earliest event if it already fell due today. A line
 * added to a Draft after it was created starts today, not on the Draft's own start date, and
 * must still be charged (a yearly Product in a plan-less Draft was missing from the payment).
 */
export function firstCycleEvents<T extends { date: string; scheduleKey: string | null }>(
  planned: T[], startsAt: string, today: string,
): T[] {
  const onStart = planned.filter((e) => e.date === startsAt);
  const covered = new Set(onStart.map((e) => e.scheduleKey ?? '~'));
  const late: T[] = [];
  for (const e of planned) {
    const key = e.scheduleKey ?? '~';
    if (e.date <= startsAt || e.date > today || covered.has(key)) continue;
    covered.add(key);
    late.push(e);
  }
  return [...onStart, ...late];
}

/** What the version's first obligation is: every line dated on its start date. */
export async function initialCharge(
  gymId: string, productSetId: number, startsAt: string, exec: Exec = db,
  /**
   * #1521 — a version that replaces a running one (a recurring Product added to
   * a member who already holds a plan) owes only what is **new** relative to it:
   * the plan's fee and every line the previous version already carried belong to
   * a payment that was made, so they are not asked for again. A line whose
   * quantity grew owes the added units alone.
   */
  opts: {
    previousProductSetId?: number | null;
    /** #2949 stage 5: include the owner's standalone cart purchases (default); a plan preview does not. */
    includeCart?: boolean;
    /**
     * #3284 stage 2: apply the cart's stored Initial Payment waivers (default). Only the waive
     * route asks for the charge as priced, to judge a new waiver against it.
     */
    applyWaivers?: boolean;
  } = {},
): Promise<InitialCharge | null> {
  // #2125 stage 14: a version that adds a plan beside the running ones carries them as inherited
  // native snapshots; what it owes now is the added plan alone, never the plans already paid.
  const addsAPlan = opts.previousProductSetId == null && await carriesInheritedNativePlans(gymId, productSetId, exec);
  const planned = await planScheduledEvents(gymId, productSetId, startsAt, 1, exec, { newPlansOnly: addsAPlan });
  const today = todayUtc();
  let first = firstCycleEvents(planned, startsAt, today);
  // #3167: a recurring Product added to a first version whose plan starts later starts today, on
  // its own; its first stretch (prorated, or a whole year) is due now, beside the plan's first cycle.
  if (opts.previousProductSetId == null && !addsAPlan) {
    first = [...await linesDueBeforeStart(exec, gymId, productSetId, startsAt, today), ...first];
  }

  if (opts.previousProductSetId != null) {
    // #2899: the fee of a plan this version *adds* (one the previous version does not carry) is
    // owed now, as it is for a first version; only an inherited plan's fee was already paid.
    // `newPlansOnly` is the one answer to "which plans are new" (`planSnapshotInheritedSql()`).
    const added = (await planScheduledEvents(gymId, productSetId, startsAt, 1, exec, { newPlansOnly: true }))
      .filter((e) => e.date === startsAt);
    const addedFees = new Map<string, SimulationLine[]>();
    for (const e of added) {
      const fees = e.lines.filter((l) => l.kind === 'membership_fee');
      if (fees.length > 0) addedFees.set(`${e.scheduleKey ?? '~'}|${e.date}`, fees);
    }
    const previous = await planScheduledEvents(gymId, opts.previousProductSetId, startsAt, 1, exec);
    // #3165: a recurring line is recognised across versions by its purchase (`line_ref`, #1865),
    // never by its Product: a second line of a Product the member already holds is a new
    // obligation, owed in full. A plan's own Product lines carry no `line_ref` and match by Product.
    const carried = new Map<string, number>();
    for (const e of previous.filter((p) => p.date === startsAt)) {
      for (const l of e.lines) {
        const key = carriedLineKey(l);
        if (key != null) carried.set(key, (carried.get(key) ?? 0) + Number(l.quantity));
      }
    }
    first = first
      .map((e) => ({
        ...e,
        lines: e.lines.flatMap((l) => {
          // The plan's own fee is the previous version's, never this payment's.
          if (l.kind === 'membership_fee' || l.product_id == null) return [];
          const had = carried.get(carriedLineKey(l)!) ?? 0;
          const quantity = Number(l.quantity);
          if (quantity <= had) return [];
          if (had === 0) return [l];
          const ratio = (quantity - had) / quantity;
          return [{
            ...l,
            quantity: quantity - had,
            actual_charge: Math.round(Number(l.actual_charge) * ratio * 100) / 100,
          }];
        }),
      }))
      .map((e) => {
        const key = `${e.scheduleKey ?? '~'}|${e.date}`;
        const fees = addedFees.get(key);
        addedFees.delete(key);
        return fees ? { ...e, lines: [...fees, ...e.lines] } : e;
      })
      .filter((e) => e.lines.length > 0);
    // An added plan's fee on a schedule the rest of the version has nothing on that day.
    for (const e of added) {
      const fees = addedFees.get(`${e.scheduleKey ?? '~'}|${e.date}`);
      if (fees) first.push({ ...e, lines: fees });
    }
  }
  // #2746: the one-time Products in the cart are paid by the same initial payment, at their frozen amount.
  const chargeable = await chargeableSetPurchases(exec, gymId, productSetId);
  const setPurchaseIds = chargeable.map((p) => p.id);
  const setPurchases = chargeable.map(purchaseChargeLine);
  // #2949 stage 5: and so are the owner's standalone cart purchases, so one Save & Pay pays the whole cart.
  const cart = opts.includeCart === false ? [] : await cartPurchasesForCharge(exec, gymId, productSetId);
  const purchases = [...setPurchases, ...cart.map(cartChargeLine)];
  if (first.length === 0 && purchases.length === 0) return null;
  // #2947: every line states the rate it is charged at and its net, after its discounts.
  const engineLines = first.flatMap((e) => e.lines);
  const taxRates = await loadInitialChargeTaxRates(exec, gymId, productSetId,
    engineLines.map((l) => l.product_id).filter((id): id is number => id != null));
  const priced = [
    ...engineLines.map((l) => withLineTax(lineFromSimulation(l), initialLineTaxRate(l, taxRates))),
    ...purchases.map((p) => withLineTax(p.line, initialLineTaxRate({ ...p.line, frozen_rate: p.line.tax_rate_percent }, taxRates))),
  ];
  // #3284 stage 2: every line's stable identity, then the staff waivers stored on the cart.
  const keys = initialPaymentLineKeys([
    ...engineLines.map((l) => ({
      kind: l.kind, assignmentId: l.user_membership_id, productId: l.product_id,
      assignedMemberId: l.assigned_member_id ?? null, lineRef: l.line_ref ?? null,
    })),
    ...[...setPurchaseIds, ...cart.map((p) => p.id)].map((id) => ({ kind: 'product' as const, purchaseId: id })),
  ]);
  const keyed = priced.map((l, i) => ({ ...l, line_key: keys[i] }));
  const lines = opts.applyWaivers === false
    ? keyed.map((l) => ({ ...l, waived: false, waivable: lineWaivable(l) }))
    : applyInitialPaymentWaivers(keyed, await loadInitialPaymentWaivers(exec, gymId, productSetId));
  const planEvent = first.find((e) => e.scheduleKey === PLAN_SCHEDULE_KEY);
  return {
    amount: linesTotal(lines), lines,
    simulationLines: [...first.flatMap((e) => e.lines), ...purchases.map((p) => p.simulation)],
    scheduleKey: planEvent && opts.previousProductSetId == null ? PLAN_SCHEDULE_KEY : null,
    cartPurchases: cart.map((p) => ({ id: p.id, amount: p.amount, product_name: p.product_name })),
    ...(earliestDate(first) != null && earliestDate(first) !== startsAt ? { billingDate: earliestDate(first)! } : {}),
    coveredDates: [...new Set(first.map((e) => e.date))].sort(),
  };
}

/** #3165 — what identifies a line across versions for the replacement delta. */
function carriedLineKey(l: SimulationLine): string | null {
  if (l.line_ref != null) return `ref:${l.line_ref}`;
  return l.product_id != null ? `product:${l.product_id}` : null;
}

const earliestDate = (events: Array<{ date: string }>): string | null =>
  events.length > 0 ? events.map((e) => e.date).sort()[0] : null;

/**
 * #3167 — the events of a first version dated before its own start date and due by today: the
 * first stretch of a recurring Product line that starts before the plan does. Lines start today
 * (`addService()`), so this is that stretch alone; a later date of the line's schedule is a
 * scheduled obligation, never part of the initial payment.
 */
async function linesDueBeforeStart(exec: Exec, gymId: string, productSetId: number, startsAt: string, today: string) {
  const { rows } = await exec.query<{ earliest: unknown }>(
    `SELECT MIN(s.starts_at) AS earliest
       FROM product_set_periodical_snapshots lnk
       JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
      WHERE s.gym_id = ? AND lnk.product_set_id = ? AND s.ends_at IS NULL`,
    [gymId, productSetId]);
  const raw = rows[0]?.earliest;
  if (raw == null) return [];
  const earliest = (raw instanceof Date ? raw.toISOString() : String(raw)).slice(0, 10);
  if (earliest >= startsAt) return [];
  const planned = await planScheduledEvents(gymId, productSetId, earliest, MAX_EARLY_CYCLES, exec);
  return planned.filter((e) => e.date < startsAt && e.date <= today);
}

/** Enough cycles for the stretch before a plan's start to be projected in full. */
const MAX_EARLY_CYCLES = 60;

export async function writeLines(tx: Tx, gymId: string, eventId: number, lines: BillingEventLineRow[]) {
  await writeEventLines(tx, gymId, eventId, lines);
}

/**
 * Writes the initial `payment_recorded` event of a ProductSet with its lines
 * (idempotent: an unpaid one is reused) and returns its id.
 */
export async function ensureInitialEvent(tx: Tx, input: {
  gymId: string; productSetId: number; memberId: number; startsAt: string; charge: InitialCharge; chargeTypeId: number | null;
  /** #1182: the plain-text actor snapshot written as `created_by`. */
  actor: string | null;
}): Promise<number> {
  const { rows: existing } = await tx.query<{ id: number }>(
    `SELECT be.id FROM billing_events be
      WHERE be.gym_id = ? AND be.product_set_id = ? AND be.event_type = 'payment_recorded'
        AND NOT EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.billing_event_id = be.id AND pr.status = 'completed')
      ORDER BY be.id DESC LIMIT 1 FOR UPDATE`,
    [input.gymId, input.productSetId]);
  if (existing[0]) {
    // #3251 stage 2: the checkout's initial event is its cart's.
    await stampEventPurchase(tx, input.gymId, Number(existing[0].id), await purchaseOfSet(tx, input.gymId, input.productSetId));
    await linkSetPurchasesToEvent(tx, input.gymId, input.productSetId, Number(existing[0].id));
    await joinCartPurchasesToEvent(tx, {
      gymId: input.gymId, productSetId: input.productSetId, billingEventId: Number(existing[0].id),
      purchases: input.charge.cartPurchases ?? [], actor: input.actor,
    });
    return Number(existing[0].id);
  }

  let scheduleId: number | null = null;
  if (input.charge.scheduleKey) {
    const { rows } = await tx.query<{ id: number }>(
      `SELECT id FROM product_set_schedules WHERE ${scheduleOwnerOfSetSql()} AND schedule_key = ?`,
      [input.productSetId, input.charge.scheduleKey]);
    scheduleId = rows[0] ? Number(rows[0].id) : null;
  }
  // #2940: the event's name, decided once from what this version adds or modifies.
  const name = await initialEventNameFor(tx, input.gymId, input.productSetId, input.startsAt,
    (input.charge.cartPurchases ?? []).map((p) => p.product_name));
  if (scheduleId != null) {
    // #2887 follow-up: a checkout cancelled before it was paid (#2747) keeps its
    // initial event as history, but that event billed nothing, so it holds no
    // period of the member's shared schedule. Without releasing it, a new Save &
    // Pay the same period answered 500 on `billing_events_schedule_period_key`.
    // A paid event (a refund's cancellation included) keeps its slot.
    await tx.query(
      `UPDATE billing_events be SET be.schedule_id = NULL
        WHERE be.gym_id = ? AND be.schedule_id = ? AND be.period_start = ? AND be.cancelled_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM payment_requests pr
                           WHERE pr.billing_event_id = be.id AND pr.status = 'completed')`,
      [input.gymId, scheduleId, input.startsAt]);
  }
  const { insertId } = await tx.query(
    `INSERT INTO billing_events
       (gym_id, member_id, event_type, name, source, amount, charge_type_id, product_set_id, schedule_id,
        period_start, billing_date, is_scheduled, created_by)
     VALUES (?, ?, 'payment_recorded', ?, 'customer', ?, ?, ?, ?, ?, ?, 0, ?)`,
    [input.gymId, input.memberId, name, input.charge.amount.toFixed(2), input.chargeTypeId, input.productSetId,
      scheduleId, input.startsAt, input.charge.billingDate ?? input.startsAt, input.actor],
  );
  await writeLines(tx, input.gymId, insertId, input.charge.lines);
  // #3251 stage 2: the checkout's initial event is its cart's.
  await stampEventPurchase(tx, input.gymId, Number(insertId), await purchaseOfSet(tx, input.gymId, input.productSetId));
  // #2746: each one-time Product of the cart reaches its payment through this event.
  await linkSetPurchasesToEvent(tx, input.gymId, input.productSetId, insertId);
  // #2949 stage 5: and so does every standalone cart purchase the charge included (pending_payment now).
  await joinCartPurchasesToEvent(tx, {
    gymId: input.gymId, productSetId: input.productSetId, billingEventId: insertId,
    purchases: input.charge.cartPurchases ?? [], actor: input.actor,
  });
  return insertId;
}

/**
 * Save & Pay: the version becomes `pending_payment`, its initial event and a
 * payment request linked to it are written, and the hosted checkout URL is
 * returned. The Active version and its future events are untouched; nothing is
 * activated until the trusted webhook confirms the money.
 */
export async function createProductSetCheckout(input: {
  gymId: string; productSetId: number; memberId: number; memberEmail: string; startsAt: string; charge: InitialCharge;
  /** #1182: who caused the checkout (staff request actor, or the member). */
  actor: string | null;
  /** #1480: the caller's language, only when the caller is the member paying. */
  requestLocale?: string | null;
}): Promise<{ paymentRequestId: number; billingEventId: number; checkoutUrl: string }> {
  const { rows: ct } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  const chargeTypeId = ct[0]?.id ?? null;

  const orderId = crypto.randomUUID();
  const pageToken = crypto.randomUUID();
  const pageTokenExpires = new Date(Date.now() + 10 * 60 * 1000);
  // #3288: the payment's description is the canonical name of the purchase (the set's cart) it
  // charges, the very string its initial Billing Event carries (`stampEventPurchase()`); a version
  // no checkout made keeps the generic one.
  const description = (await purchaseName(db, input.gymId, await purchaseOfSet(db, input.gymId, input.productSetId)))
    ?? 'Membership';
  const result = await getPaymentProvider().createPaymentRequest({
    orderId,
    amount: toMinorUnits(input.charge.amount),
    currency: 'EUR',
    description,
    memberEmail: input.memberEmail,
    okUrl: process.env.PAYMENT_OK_URL ?? '',
    koUrl: process.env.PAYMENT_KO_URL ?? '',
    notificationUrl: process.env.PAYMENT_NOTIFICATION_URL ?? '',
  });

  const out = await db.transaction(async (tx) => {
    const billingEventId = await ensureInitialEvent(tx, {
      gymId: input.gymId, productSetId: input.productSetId, memberId: input.memberId,
      startsAt: input.startsAt, charge: input.charge, chargeTypeId, actor: input.actor,
    });
    const { rows: prev } = await tx.query<{ n: number }>(
      'SELECT COALESCE(MAX(attempt), 0) AS n FROM payment_requests WHERE billing_event_id = ?', [billingEventId]);
    const { insertId } = await tx.query(
      `INSERT INTO payment_requests
         (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider,
          provider_order, provider_ref, page_token, page_token_expires, consent_given_at, source, attempt, method, created_by)
       VALUES (?, ?, ?, 'EUR', ?, ?, 'pending', 'monei', ?, ?, ?, ?, UTC_TIMESTAMP(), 'customer', ?, 'provider', ?)`,
      [input.gymId, input.memberId, input.charge.amount.toFixed(2), chargeTypeId, billingEventId,
        orderId, result.providerOrderId, pageToken, pageTokenExpires, Number(prev[0]?.n ?? 0) + 1, input.actor],
    );
    await recordPaymentAttempt(tx, insertId);
    await tx.query('UPDATE product_sets SET payment_request_id = ? WHERE id = ?', [insertId, input.productSetId]);
    return { paymentRequestId: Number(insertId), billingEventId };
  });

  const checkoutUrl = await payerCheckoutUrl({
    gymId: input.gymId, memberId: input.memberId, pageToken, requestLocale: input.requestLocale,
  });
  return { ...out, checkoutUrl };
}

/**
 * What committing `set` asks for **today** — the one answer Save & Pay, the
 * free activation and the "Review your changes" preview all use, so the figure a
 * member is shown is the figure charged (#1537). A version that replaces a
 * running one owes only what is new relative to it, dated today; a first
 * version owes its first cycle from its own start date.
 */
export async function commitCharge(gymId: string, set: any, exec: Exec = db, opts: { applyWaivers?: boolean } = {}) {
  const nextVersion = set.previous_product_set_id != null;
  const startsAt = nextVersion
    ? todayUtc()
    : (set.starts_at instanceof Date ? set.starts_at.toISOString() : String(set.starts_at)).slice(0, 10);
  const charge = await initialCharge(gymId, Number(set.id), startsAt, exec, {
    previousProductSetId: nextVersion ? Number(set.previous_product_set_id) : null,
    applyWaivers: opts.applyWaivers,
  });
  return { startsAt, charge };
}

