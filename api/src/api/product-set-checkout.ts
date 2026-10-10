import crypto from 'crypto';
import { db, Tx } from '../infra/db';

type Exec = { query: Tx['query'] };
import { getPaymentProvider } from '../payments';
import { toMinorUnits } from '../payments/money';
import { BlockingEvent, blockingEvents, LockEvent } from '../domain/billingEventEditLock';
import { normaliseProviderStatus } from '../domain/providerPaymentStatus';
import { BillingEventLineRow, lineFromSimulation, linesTotal } from '../domain/billingEventLines';
import { planScheduledEvents } from './product-set-configuration';
import { PLAN_SCHEDULE_KEY } from '../domain/scheduleAllocation';

/**
 * #1325 PR 2d — the editing lock's SQL half, and the checkout of a ProductSet.
 *
 * `domain/billingEventEditLock.ts` decides; this reads the chain's events and
 * their latest attempts, and writes the initial obligation and its payment
 * request. Like `plan-checkout.ts` it writes the **initial real Billing Event
 * before the money moves**, so the ledger already shows the charge pending and
 * the payment webhook settles that event rather than appending a second one —
 * and it is that same webhook, through `activateWithEvents()`, that activates
 * the set. A return from the hosted page activates nothing.
 */

/** The unresolved, past-due events of the owner's **active** chain, if any. */
export async function loadEditLock(gymId: string, ownerMemberId: number, today: string): Promise<BlockingEvent[]> {
  const { rows } = await db.query<any>(
    `SELECT be.id, be.billing_date, be.is_scheduled,
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
        AND ps.root_product_set_id = (
              SELECT a.root_product_set_id FROM product_sets a
               WHERE a.gym_id = ? AND a.owner_member_id = ? AND a.status = 'active' LIMIT 1)
        AND be.event_type NOT IN ('status_changed')`,
    [gymId, ownerMemberId, gymId, ownerMemberId],
  );
  const events: LockEvent[] = rows.map((r: any) => ({
    id: Number(r.id),
    billingDate: r.billing_date instanceof Date ? r.billing_date.toISOString().slice(0, 10) : String(r.billing_date ?? '').slice(0, 10) || null,
    isScheduled: Number(r.is_scheduled) === 1,
    latestAttempt: Number(r.attempts) > 0
      ? { method: (r.method ?? 'provider') as 'provider' | 'cash' | 'waive', providerStatus: normaliseProviderStatus(r.provider_status), status: String(r.attempt_status) }
      : null,
  }));
  return blockingEvents(events, today);
}

export interface InitialCharge {
  amount: number;
  lines: BillingEventLineRow[];
  scheduleKey: string | null;
}

/** What the version's first obligation is: every line dated on its start date. */
export async function initialCharge(gymId: string, productSetId: number, startsAt: string, exec: Exec = db): Promise<InitialCharge | null> {
  const planned = await planScheduledEvents(gymId, productSetId, startsAt, 1, exec);
  const first = planned.filter((e) => e.date === startsAt);
  if (first.length === 0) return null;
  const lines = first.flatMap((e) => e.lines.map((l) => lineFromSimulation(l)));
  const planEvent = first.find((e) => e.scheduleKey === PLAN_SCHEDULE_KEY);
  return { amount: linesTotal(lines), lines, scheduleKey: planEvent ? PLAN_SCHEDULE_KEY : null };
}

async function writeLines(tx: Tx, gymId: string, eventId: number, lines: BillingEventLineRow[]) {
  for (const l of lines) {
    await tx.query(
      `INSERT INTO billing_event_lines
         (gym_id, billing_event_id, kind, product_id, item_name, item_type, quantity, regular_unit_price,
          treatment_action, treatment_value, promotion_name, prorated_days, period_days,
          tax_rate_percent, tax_behavior, amount_excl_tax, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, eventId, l.kind, l.product_id, l.item_name, l.item_type, l.quantity, l.regular_unit_price,
        l.treatment_action, l.treatment_value, l.promotion_name, l.prorated_days, l.period_days,
        l.tax_rate_percent, l.tax_behavior, l.amount_excl_tax, l.amount],
    );
  }
}

/**
 * Writes the initial `payment_recorded` event of a ProductSet with its lines
 * (idempotent: an unpaid one is reused) and returns its id.
 */
export async function ensureInitialEvent(tx: Tx, input: {
  gymId: string; productSetId: number; memberId: number; startsAt: string; charge: InitialCharge; chargeTypeId: number | null;
}): Promise<number> {
  const { rows: existing } = await tx.query<{ id: number }>(
    `SELECT be.id FROM billing_events be
      WHERE be.gym_id = ? AND be.product_set_id = ? AND be.event_type = 'payment_recorded'
        AND NOT EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.billing_event_id = be.id AND pr.status = 'completed')
      ORDER BY be.id DESC LIMIT 1 FOR UPDATE`,
    [input.gymId, input.productSetId]);
  if (existing[0]) return Number(existing[0].id);

  const { rows: setRows } = await tx.query<{ root_product_set_id: number }>(
    'SELECT root_product_set_id FROM product_sets WHERE id = ?', [input.productSetId]);
  let scheduleId: number | null = null;
  if (input.charge.scheduleKey) {
    const { rows } = await tx.query<{ id: number }>(
      'SELECT id FROM product_set_schedules WHERE root_product_set_id = ? AND schedule_key = ?',
      [setRows[0].root_product_set_id, input.charge.scheduleKey]);
    scheduleId = rows[0] ? Number(rows[0].id) : null;
  }
  const { insertId } = await tx.query(
    `INSERT INTO billing_events
       (gym_id, member_id, event_type, source, amount, charge_type_id, product_set_id, schedule_id,
        period_start, billing_date, is_scheduled)
     VALUES (?, ?, 'payment_recorded', 'customer', ?, ?, ?, ?, ?, ?, 0)`,
    [input.gymId, input.memberId, input.charge.amount.toFixed(2), input.chargeTypeId, input.productSetId,
      scheduleId, input.startsAt, input.startsAt],
  );
  await writeLines(tx, input.gymId, insertId, input.charge.lines);
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
}): Promise<{ paymentRequestId: number; billingEventId: number; checkoutUrl: string }> {
  const { rows: ct } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  const chargeTypeId = ct[0]?.id ?? null;

  const orderId = crypto.randomUUID();
  const pageToken = crypto.randomUUID();
  const pageTokenExpires = new Date(Date.now() + 10 * 60 * 1000);
  const result = await getPaymentProvider().createPaymentRequest({
    orderId,
    amount: toMinorUnits(input.charge.amount),
    currency: 'EUR',
    description: 'Membership',
    memberEmail: input.memberEmail,
    okUrl: process.env.PAYMENT_OK_URL ?? '',
    koUrl: process.env.PAYMENT_KO_URL ?? '',
    notificationUrl: process.env.PAYMENT_NOTIFICATION_URL ?? '',
  });

  const out = await db.transaction(async (tx) => {
    const billingEventId = await ensureInitialEvent(tx, {
      gymId: input.gymId, productSetId: input.productSetId, memberId: input.memberId,
      startsAt: input.startsAt, charge: input.charge, chargeTypeId,
    });
    const { rows: prev } = await tx.query<{ n: number }>(
      'SELECT COALESCE(MAX(attempt), 0) AS n FROM payment_requests WHERE billing_event_id = ?', [billingEventId]);
    const { insertId } = await tx.query(
      `INSERT INTO payment_requests
         (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider,
          provider_order, provider_ref, page_token, page_token_expires, consent_given_at, source, attempt, method)
       VALUES (?, ?, ?, 'EUR', ?, ?, 'pending', 'monei', ?, ?, ?, ?, UTC_TIMESTAMP(), 'customer', ?, 'provider')`,
      [input.gymId, input.memberId, input.charge.amount.toFixed(2), chargeTypeId, billingEventId,
        orderId, result.providerOrderId, pageToken, pageTokenExpires, Number(prev[0]?.n ?? 0) + 1],
    );
    await tx.query('UPDATE product_sets SET payment_request_id = ? WHERE id = ?', [insertId, input.productSetId]);
    return { paymentRequestId: Number(insertId), billingEventId };
  });

  const checkoutUrl = `${process.env.PAYMENT_PAGE_URL ?? 'https://pay.vdicube.com'}/checkout?token=${pageToken}`;
  return { ...out, checkoutUrl };
}
