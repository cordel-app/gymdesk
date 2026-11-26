/**
 * #3442 — **Pay now** on a Billing Event: the I/O half over the pure
 * `domain/billingEventPayNow.ts`.
 *
 * Staff collect an existing Failed, Pending payment or Scheduled event now, with
 * a method chosen in the modal:
 *
 *   members_app   a hosted checkout raised as an attempt on **this** event (a
 *                 still-valid unopened link is reused rather than duplicated);
 *                 the provider's webhook settles it, never this call.
 *   cash / card   a staff-confirmed settlement on this event, no provider call:
 *                 a scheduled obligation leaves the schedule as paid, and the
 *                 initial event of a Pending Payment Product Set activates it in
 *                 the same transaction (what the webhook does on a paid checkout).
 *
 * Every decision is taken under the event's row lock, with `chargeGuard()` over
 * every earlier attempt, so a paid event is never charged again and concurrent
 * submissions settle once. No Billing Event is ever created here.
 */
import crypto from 'crypto';
import { Tx, db } from '../infra/db';
import { getPaymentProvider } from '../payments';
import { toMinorUnits } from '../payments/money';
import { chargeGuard } from '../domain/chargeGuard';
import { AttemptMethod, ManualPaymentMethod } from '../domain/paymentAttemptMethod';
import { eventAssignmentSql } from '../domain/billingEventOwnership';
import { ANCHOR_PLAN_SNAPSHOT_VALUE_SQL } from '../domain/planAssignments';
import { ledgerEventStatus } from '../domain/memberPaymentView';
import { BillingEventStatus } from '../domain/billingEventStatus';
import { purchaseCartExpiredSql } from '../domain/cartExpiry';
import {
  PayNowBlock, PendingAttempt, payNowBlock, payNowOffered, reusableCheckout, unopenedPendingAttempts,
} from '../domain/billingEventPayNow';
import { recordPaymentAttempt } from './payment-attempt';
import { resolvePayerFor } from './payer-resolution';
import { payerCheckoutUrl } from './checkout-url';
import { paymentDescriptionForEvent } from './purchases';
import { activateWithEvents } from './product-set-configuration';

export interface PayNowFailure { status: number; error: string; message?: string }

interface PayNowContext {
  id: number;
  gym_id: string;
  member_id: number;
  user_membership_id: number | null;
  product_set_id: number | null;
  set_status: string | null;
  event_type: string;
  amount: string | null;
  charge_type_id: number | null;
  is_scheduled: number;
  cancelled: number;
  expired: number;
  latest_tx_status: string | null;
  completed_attempts: number;
  cart_status: string | null;
  cart_clock_expired: number;
  member_email: string | null;
}

async function loadContext(exec: Pick<Tx, 'query'>, gymId: string, billingEventId: number): Promise<PayNowContext | null> {
  const { rows } = await exec.query<PayNowContext>(
    `SELECT be.id, be.gym_id, be.member_id, ${eventAssignmentSql()} AS user_membership_id,
            be.product_set_id, ps.status AS set_status, be.event_type, be.amount, be.charge_type_id,
            be.is_scheduled, (be.cancelled_at IS NOT NULL) AS cancelled, (be.expired_at IS NOT NULL) AS expired,
            (SELECT pr.status FROM payment_requests pr WHERE pr.billing_event_id = be.id
              ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS latest_tx_status,
            (SELECT COUNT(*) FROM payment_requests pr
              WHERE pr.billing_event_id = be.id AND pr.status = 'completed'
                AND COALESCE(pr.transaction_type, 'payment') <> 'refund') AS completed_attempts,
            pu.status AS cart_status,
            (pu.id IS NOT NULL AND ${purchaseCartExpiredSql('pu')}) AS cart_clock_expired,
            m.email AS member_email
       FROM billing_events be
       LEFT JOIN product_sets ps ON ps.id = be.product_set_id AND ps.gym_id = be.gym_id
       LEFT JOIN purchases pu ON pu.id = be.purchase_id AND pu.gym_id = be.gym_id
       LEFT JOIN members m ON m.id = be.member_id
      WHERE be.id = ? AND be.gym_id = ?`,
    [billingEventId, gymId],
  );
  return rows[0] ?? null;
}

function statusOf(ev: PayNowContext): BillingEventStatus | null {
  return ledgerEventStatus(ev.event_type, ev.latest_tx_status, Number(ev.cancelled) === 1, Number(ev.is_scheduled) === 1);
}

/** The eligibility a read reports, from a row the reader already holds. */
export function payNowFlags(row: {
  status: BillingEventStatus | null; eventType: string; cancelled: boolean; hasCompletedAttempt: boolean;
  linked: boolean; amount: number; cartStatus: string | null; eventExpired: boolean; cartClockExpired: boolean;
}): { can_pay_now: boolean; pay_now_block: PayNowBlock | null } {
  const offered = payNowOffered(row);
  return {
    can_pay_now: offered,
    pay_now_block: offered ? payNowBlock({
      status: row.status, cartStatus: row.cartStatus, eventExpired: row.eventExpired, cartClockExpired: row.cartClockExpired,
    }) : null,
  };
}

const BLOCK_MESSAGES: Record<PayNowBlock, string> = {
  cart_cancelled: 'The cart this payment belongs to was cancelled; it cannot be paid.',
  cart_expired: 'The cart this payment belongs to has expired; it cannot be paid.',
};

/** The shared refusal: not found, not eligible, or blocked by its cart. */
function refusal(ev: PayNowContext | null): PayNowFailure | null {
  if (!ev) return { status: 404, error: 'Billing event not found' };
  const status = statusOf(ev);
  if (Number(ev.completed_attempts) > 0) {
    return { status: 409, error: 'already_paid', message: 'This billing event has already been paid.' };
  }
  const flags = payNowFlags({
    status, eventType: ev.event_type, cancelled: Number(ev.cancelled) === 1, hasCompletedAttempt: false,
    linked: ev.product_set_id != null, amount: ev.amount != null ? parseFloat(ev.amount) : 0,
    cartStatus: ev.cart_status, eventExpired: Number(ev.expired) === 1, cartClockExpired: Number(ev.cart_clock_expired) === 1,
  });
  if (!flags.can_pay_now) {
    return { status: Number(ev.cancelled) === 1 ? 409 : 400, error: 'pay_now_not_available', message: `Pay now is not available for this billing event (${status ?? 'no status'}).` };
  }
  if (flags.pay_now_block) return { status: 409, error: flags.pay_now_block, message: BLOCK_MESSAGES[flags.pay_now_block] };
  return null;
}

async function loadAttempts(exec: Pick<Tx, 'query'>, billingEventId: number) {
  const { rows } = await exec.query<any>(
    `SELECT id, method, provider_status, provider_ref, status, attempt, page_token, page_token_expires
       FROM payment_requests WHERE billing_event_id = ? FOR UPDATE`, [billingEventId]);
  return rows;
}

const pendingView = (rows: any[]): PendingAttempt[] => rows.map((a) => ({
  id: Number(a.id), status: String(a.status), pageToken: a.page_token ?? null,
  pageTokenExpiresAt: a.page_token_expires ? new Date(a.page_token_expires) : null,
}));

const guardView = (rows: any[], excluded: readonly number[]) => rows
  .filter((a) => !excluded.includes(Number(a.id)))
  .map((a) => ({
    id: Number(a.id), method: (a.method ?? 'provider') as AttemptMethod,
    providerStatus: a.provider_status ?? null, providerRef: a.provider_ref ?? null, status: String(a.status),
  }));

/** Closes never-opened pending links as `expired` (#789: nothing can have been collected on them). */
async function expireAttempts(tx: Tx, ids: readonly number[], actor: string | null): Promise<void> {
  if (ids.length === 0) return;
  await tx.query(
    `UPDATE payment_requests SET status = 'expired', page_token = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'pending' AND page_token IS NOT NULL`,
    [actor, ...ids],
  );
}

async function chargeTypeIdFor(ev: PayNowContext): Promise<number | null> {
  if (ev.charge_type_id) return ev.charge_type_id;
  const { rows } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  return rows[0]?.id ?? null;
}

/** Read for the modal: the block (re-checked) and nothing else; the methods are the router's. */
export async function payNowState(gymId: string, billingEventId: number): Promise<PayNowFailure | { ok: true; amount: string; status: BillingEventStatus | null }> {
  const ev = await loadContext(db, gymId, billingEventId);
  const failure = refusal(ev);
  if (failure) return failure;
  return { ok: true, amount: ev!.amount!, status: statusOf(ev!) };
}

export interface PayNowManualResult {
  billing_event_id: number;
  previous_status: BillingEventStatus | null;
  new_status: 'paid';
  method: ManualPaymentMethod;
  payment_request_id: number;
  amount: string;
  activated_product_set_id: number | null;
}

/** Cash or external card terminal: a completed attempt on this event, no provider call. */
export async function payNowManual(
  gymId: string, billingEventId: number, method: ManualPaymentMethod, actor: string | null,
): Promise<{ failure: PayNowFailure } | { result: PayNowManualResult }> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT id FROM billing_events WHERE id = ? AND gym_id = ? FOR UPDATE', [billingEventId, gymId]);
    const ev = await loadContext(tx, gymId, billingEventId);
    const failure = refusal(ev);
    if (failure) return { failure };
    const event = ev!;

    const attempts = await loadAttempts(tx, event.id);
    const unopened = unopenedPendingAttempts(pendingView(attempts), new Date(), { includeLive: true });
    const guard = chargeGuard(guardView(attempts, unopened));
    if (!guard.allowed) {
      return { failure: { status: 409, error: 'payment_unresolved', message: `This payment cannot be recorded (${guard.reason}); reconcile the earlier attempt first.` } };
    }
    await expireAttempts(tx, unopened, actor);

    const chargeTypeId = await chargeTypeIdFor(event);
    const previousStatus = statusOf(event);
    const amount = parseFloat(event.amount!);
    const attempt = attempts.reduce((n: number, a: any) => Math.max(n, Number(a.attempt ?? 0)), 0) + 1;
    const { insertId } = await tx.query(
      `INSERT INTO payment_requests
         (gym_id, anchor_plan_snapshot_id, member_id, amount, currency, charge_type_id, billing_event_id,
          status, provider, source, attempt, method, created_by, created_at, completed_at, modified_at, modified_by)
       VALUES (?, ${ANCHOR_PLAN_SNAPSHOT_VALUE_SQL}, ?, ?, 'EUR', ?, ?, 'completed', 'manual', 'manual', ?, ?, ?,
               UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?)`,
      [gymId, event.user_membership_id, gymId, event.member_id, amount.toFixed(2), chargeTypeId, event.id,
        attempt, method, actor, actor],
    );
    await recordPaymentAttempt(tx, insertId);

    let activated: number | null = null;
    if (event.set_status === 'pending_payment' && event.event_type === 'payment_recorded') {
      // The checkout's initial event: paying it is what the webhook's completion
      // does — the version activates in this same transaction.
      const a = await activateWithEvents(tx, {
        gymId, productSetId: Number(event.product_set_id), today: new Date().toISOString().slice(0, 10), actor,
      });
      if (a.kind !== 'ok') throw Object.assign(new Error(a.kind), { payNowFailure: { status: 409, error: a.kind } });
      activated = Number(event.product_set_id);
    } else {
      await closeAsPaid(tx, gymId, event.id, actor);
    }
    await tx.query('UPDATE billing_events SET modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ?',
      [actor, event.id, gymId]);

    return {
      result: {
        billing_event_id: event.id, previous_status: previousStatus, new_status: 'paid' as const, method,
        payment_request_id: Number(insertId), amount: amount.toFixed(2), activated_product_set_id: activated,
      },
    };
  }).catch((err: any) => {
    if (err?.payNowFailure) return { failure: err.payNowFailure as PayNowFailure };
    throw err;
  });
}

/**
 * A scheduled obligation (or a failed charge) that has been paid leaves the
 * schedule: the nightly run selects `is_scheduled = 1` / `failed_billing` and
 * must find nothing left to collect (#1325's `closeScheduledEvent()`, which the
 * webhook now also applies to a paid Pay now checkout).
 */
export async function closeAsPaid(exec: Pick<Tx, 'query'>, gymId: string, billingEventId: number, actor: string | null): Promise<void> {
  await exec.query(
    `UPDATE billing_events SET is_scheduled = 0, event_type = 'recurring_payment',
            modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE id = ? AND gym_id = ? AND product_set_id IS NOT NULL
        AND (is_scheduled = 1 OR event_type IN ('charge_created', 'failed_billing'))`,
    [actor, billingEventId, gymId],
  );
}

export interface PayNowCheckoutResult {
  billing_event_id: number;
  payment_request_id: number;
  checkoutUrl: string;
  reused: boolean;
}

/**
 * Members App: a hosted checkout on this event. A still-valid link nobody has
 * opened is reused; a lapsed unopened one is expired; anything the provider
 * may still settle refuses. The provider is called outside the lock, and the
 * insert re-checks under it, so two concurrent submissions leave one link.
 */
export async function payNowMembersApp(
  gymId: string, billingEventId: number, actor: string | null,
): Promise<{ failure: PayNowFailure } | { result: PayNowCheckoutResult }> {
  // Phase 1 — decide (reuse, or go to the provider).
  const decided = await db.transaction(async (tx) => {
    await tx.query('SELECT id FROM billing_events WHERE id = ? AND gym_id = ? FOR UPDATE', [billingEventId, gymId]);
    const ev = await loadContext(tx, gymId, billingEventId);
    const failure = refusal(ev);
    if (failure) return { failure };
    const attempts = await loadAttempts(tx, billingEventId);
    const reuse = reusableCheckout(pendingView(attempts), new Date());
    if (reuse) return { reuse: { id: reuse.id, pageToken: reuse.pageToken! }, ev: ev! };
    const lapsed = unopenedPendingAttempts(pendingView(attempts), new Date(), { includeLive: false });
    const guard = chargeGuard(guardView(attempts, lapsed));
    if (!guard.allowed) {
      return { failure: { status: 409, error: 'payment_unresolved', message: `A payment for this billing event is still in progress (${guard.reason}).` } };
    }
    return { ev: ev! };
  });
  if ('failure' in decided && decided.failure) return { failure: decided.failure };
  const ev = (decided as any).ev as PayNowContext;
  const payer = await resolvePayerFor(db, gymId, ev.member_id);
  if ((decided as any).reuse) {
    const r = (decided as any).reuse as { id: number; pageToken: string };
    return { result: { billing_event_id: ev.id, payment_request_id: r.id, reused: true,
      checkoutUrl: await payerCheckoutUrl({ gymId, memberId: payer.payerMemberId, pageToken: r.pageToken }) } };
  }

  // Phase 2 — the hosted checkout (no money moves until the member pays).
  const amount = parseFloat(ev.amount!);
  const orderId = crypto.randomUUID();
  const created = await getPaymentProvider().createPaymentRequest({
    orderId,
    amount: toMinorUnits(amount),
    currency: 'EUR',
    description: await paymentDescriptionForEvent(db, gymId, ev.id, 'Membership fee'),
    memberEmail: ev.member_email ?? '',
    okUrl: process.env.PAYMENT_OK_URL ?? '',
    koUrl: process.env.PAYMENT_KO_URL ?? '',
    notificationUrl: process.env.PAYMENT_NOTIFICATION_URL ?? '',
  });

  // Phase 3 — record the attempt, re-checked under the lock.
  return db.transaction(async (tx) => {
    await tx.query('SELECT id FROM billing_events WHERE id = ? AND gym_id = ? FOR UPDATE', [billingEventId, gymId]);
    const again = await loadContext(tx, gymId, billingEventId);
    const failure = refusal(again);
    if (failure) return { failure };
    const attempts = await loadAttempts(tx, billingEventId);
    const reuse = reusableCheckout(pendingView(attempts), new Date());
    if (reuse) {
      // Another submission raised a link meanwhile: that one is the link.
      return { result: { billing_event_id: ev.id, payment_request_id: reuse.id, reused: true,
        checkoutUrl: await payerCheckoutUrl({ gymId, memberId: payer.payerMemberId, pageToken: reuse.pageToken! }) } };
    }
    const lapsed = unopenedPendingAttempts(pendingView(attempts), new Date(), { includeLive: false });
    const guard = chargeGuard(guardView(attempts, lapsed));
    if (!guard.allowed) {
      return { failure: { status: 409, error: 'payment_unresolved', message: `A payment for this billing event is still in progress (${guard.reason}).` } };
    }
    await expireAttempts(tx, lapsed, actor);
    const pageToken = crypto.randomUUID();
    const pageTokenExpires = new Date(Date.now() + 10 * 60 * 1000);
    const attempt = attempts.reduce((n: number, a: any) => Math.max(n, Number(a.attempt ?? 0)), 0) + 1;
    const { insertId } = await tx.query(
      `INSERT INTO payment_requests
         (gym_id, anchor_plan_snapshot_id, member_id, payer_member_id, amount, currency, charge_type_id, billing_event_id,
          status, provider, provider_order, provider_ref, page_token, page_token_expires,
          created_by, source, attempt)
       VALUES (?, ${ANCHOR_PLAN_SNAPSHOT_VALUE_SQL}, ?, ?, ?, 'EUR', ?, ?, 'pending', 'monei', ?, ?, ?, ?, ?, 'admin', ?)`,
      [gymId, ev.user_membership_id, gymId, ev.member_id, payer.payerMemberId, amount.toFixed(2), await chargeTypeIdFor(ev), ev.id,
        orderId, created.providerOrderId, pageToken, pageTokenExpires, actor, attempt],
    );
    await recordPaymentAttempt(tx, insertId);
    return { result: { billing_event_id: ev.id, payment_request_id: Number(insertId), reused: false,
      checkoutUrl: await payerCheckoutUrl({ gymId, memberId: payer.payerMemberId, pageToken }) } };
  });
}
