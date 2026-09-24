import crypto from 'crypto';
import { db } from '../infra/db';
import { advanceBillingDate } from './billingDate';
import { recordStatusChange } from '../api/billing-events';
import { ASSIGNMENT_CADENCE } from '../api/assigned-plan-snapshot';
import { getPaymentProvider } from '../payments';
import {
  BillingEventStatus,
  deriveBillingEventStatus,
  isPaymentActionable,
} from './billingEventStatus';

/**
 * #640: the two audited payment actions available on a failed/rejected Billing
 * Event, plus the read model behind the Details view.
 *
 * Both actions follow §3's rule — *never* append a second Billing Event. A
 * Billing Event is the charge; a Payment Transaction (`payment_requests`) is
 * an attempt to settle it, and an event carries 0..N of them. Retrying or
 * recording a front-desk payment therefore only adds transactions against the
 * existing `billing_event_id`, which flips the event's derived status without
 * rewriting the append-only ledger row.
 *
 * The audit trail itself (§5) lives in `audit_logs` — the routes call
 * `recordAudit` with the before/after snapshots these helpers return.
 */

/** Shared with the routes so they can answer with the right HTTP status. */
export interface ActionFailure {
  status: number;
  error: string;
}

export interface PaymentAttempt {
  payment_request_id: number;
  attempt: number;
  status: 'completed' | 'failed';
  provider_ref: string | null;
  failure_code: string | null;
  failure_message: string | null;
}

export interface RetryResult {
  billing_event_id: number;
  previous_status: BillingEventStatus;
  new_status: BillingEventStatus;
  attempts: PaymentAttempt[];
  /** True when both attempts failed and the assigned plan was paused. */
  membership_paused: boolean;
}

export interface ManualPaymentResult {
  billing_event_id: number;
  previous_status: BillingEventStatus;
  new_status: BillingEventStatus;
  payment_request_id: number;
  amount: string;
  notes: string | null;
}

/** Q3 (#640): a Retry fires the charge and, if it is rejected, once more. */
const MAX_RETRY_ATTEMPTS = 2;

interface EventContext {
  id: number;
  gym_id: string;
  member_id: number | null;
  user_membership_id: number | null;
  event_type: string;
  amount: string | null;
  charge_type_id: number | null;
  latest_tx_status: string | null;
  has_completed_tx: number;
  membership_status: string | null;
  next_billing_date: Date | string | null;
  recurring_billing_interval: number | null;
  recurring_billing_unit: 'day' | 'week' | 'month' | 'year' | null;
  last_attempt: number | null;
}

/**
 * Loads everything both actions need to decide whether they may run. The
 * `latest_tx_status` subquery is the same one the list endpoint uses — see
 * `deriveBillingEventStatus`.
 */
async function loadEventContext(gymId: string, billingEventId: number): Promise<EventContext | null> {
  const { rows } = await db.query<EventContext>(
    `SELECT be.id, be.gym_id, be.member_id, be.user_membership_id, be.event_type,
            be.amount, be.charge_type_id,
            (SELECT pr.status FROM payment_requests pr
              WHERE pr.billing_event_id = be.id
              ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS latest_tx_status,
            (SELECT COUNT(*) FROM payment_requests pr
              WHERE pr.billing_event_id = be.id AND pr.status = 'completed') AS has_completed_tx,
            (SELECT MAX(pr.attempt) FROM payment_requests pr
              WHERE pr.billing_event_id = be.id) AS last_attempt,
            um.status AS membership_status, um.next_billing_date,
            ${ASSIGNMENT_CADENCE.interval()} AS recurring_billing_interval,
            ${ASSIGNMENT_CADENCE.unit()} AS recurring_billing_unit
       FROM billing_events be
       LEFT JOIN user_memberships um ON um.id = be.user_membership_id
       LEFT JOIN billing_policies bp ON bp.membership_plan_id = um.membership_plan_id
      WHERE be.id = ? AND be.gym_id = ?`,
    [billingEventId, gymId],
  );
  return rows[0] ?? null;
}

/**
 * Shared guards: the event must exist, be in a failed/rejected state, not
 * already be settled, and hang off a membership (a `payment_requests` row
 * cannot exist without one — `user_membership_id` is NOT NULL there).
 */
function guardActionable(ev: EventContext | null): ActionFailure | null {
  if (!ev) return { status: 404, error: 'Billing event not found' };
  if (Number(ev.has_completed_tx) > 0) {
    return { status: 409, error: 'This billing event has already been paid.' };
  }
  const status = deriveBillingEventStatus(ev.event_type, ev.latest_tx_status);
  if (!isPaymentActionable(status)) {
    return { status: 400, error: `Payment actions are only available for failed billing events (this one is '${status}').` };
  }
  if (!ev.user_membership_id) {
    return { status: 400, error: 'This billing event is not linked to an assigned plan.' };
  }
  const amount = ev.amount != null ? parseFloat(ev.amount) : NaN;
  if (!(amount > 0)) {
    return { status: 400, error: 'This billing event has no amount to charge.' };
  }
  return null;
}

/** `payment_requests.charge_type_id` is NOT NULL; fall back to membership_fee. */
async function resolveChargeTypeId(ev: EventContext): Promise<number | null> {
  if (ev.charge_type_id) return ev.charge_type_id;
  const { rows } = await db.query<{ id: number }>(
    "SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1",
  );
  return rows[0]?.id ?? null;
}

/**
 * Mirrors the successful branch of the nightly run (`billing.ts`): a charge
 * that finally settles must move the membership's schedule on, or the run
 * would charge the same period again the next night. Only advances while the
 * membership is still waiting on that very charge (`next_billing_date` today
 * or earlier) — a schedule that already moved on is left alone.
 */
async function advanceScheduleAfterPayment(ev: EventContext): Promise<void> {
  if (!ev.user_membership_id || !ev.next_billing_date) return;
  if (!ev.recurring_billing_interval || !ev.recurring_billing_unit) return;
  const today = new Date().toISOString().slice(0, 10);
  const current = ev.next_billing_date instanceof Date
    ? ev.next_billing_date.toISOString().slice(0, 10)
    : String(ev.next_billing_date).slice(0, 10);
  if (current > today) return;

  const next = advanceBillingDate(current, ev.recurring_billing_interval, ev.recurring_billing_unit);
  await db.query(
    'UPDATE user_memberships SET last_billed_at = UTC_TIMESTAMP(), next_billing_date = ? WHERE id = ? AND gym_id = ?',
    [next, ev.user_membership_id, ev.gym_id],
  );
}

/** Stamps §2's Modified At / Modified By on the parent Billing Event. */
async function stampEventModified(gymId: string, billingEventId: number, actorUserId: string | null): Promise<void> {
  await db.query(
    'UPDATE billing_events SET modified_at = UTC_TIMESTAMP(), modified_by_user_id = ? WHERE id = ? AND gym_id = ?',
    [actorUserId, billingEventId, gymId],
  );
}

async function insertTransaction(params: {
  ev: EventContext;
  chargeTypeId: number;
  amount: number;
  status: 'completed' | 'failed';
  source: 'retry' | 'manual';
  attempt: number;
  provider: string;
  providerOrder: string | null;
  providerRef: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  notes: string | null;
  actorUserId: string | null;
}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        billing_event_id, status, provider, provider_order, provider_ref,
        source, attempt, initiated_by, failure_code, failure_message, notes,
        created_at, completed_at, modified_at, modified_by_user_id)
     VALUES (?, ?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             UTC_TIMESTAMP(), ?, UTC_TIMESTAMP(), ?)`,
    [
      params.ev.gym_id, params.ev.user_membership_id, params.ev.member_id,
      params.amount.toFixed(2), params.chargeTypeId, params.ev.id,
      params.status, params.provider, params.providerOrder, params.providerRef,
      params.source, params.attempt, params.actorUserId,
      params.failureCode, params.failureMessage, params.notes,
      params.status === 'completed' ? new Date() : null,
      params.actorUserId,
    ],
  );
  return insertId;
}

/**
 * Retry Payment (§3, Q3 option B): create a **new** Payment Transaction
 * against the **same** Billing Event and re-run the provider charge. A
 * rejection is retried once more; if that also fails the assigned plan is
 * paused, which in turn flips every covered member's payment status (derived
 * from their latest transaction — see `members.ts`).
 */
export async function retryBillingEventPayment(
  gymId: string,
  billingEventId: number,
  actorUserId: string | null,
  actorSource: string,
): Promise<{ failure: ActionFailure } | { result: RetryResult }> {
  const ev = await loadEventContext(gymId, billingEventId);
  const guard = guardActionable(ev);
  if (guard) return { failure: guard };
  const event = ev!;

  const chargeTypeId = await resolveChargeTypeId(event);
  if (!chargeTypeId) return { failure: { status: 500, error: 'charge_type membership_fee not configured' } };

  const { rows: pmRows } = await db.query<{ payment_token: string | null; sequence_id: string | null; provider: string }>(
    'SELECT payment_token, sequence_id, provider FROM payment_methods WHERE member_id = ? AND gym_id = ? LIMIT 1',
    [event.member_id, gymId],
  );
  const pm = pmRows[0];
  if (!pm?.payment_token || !pm?.sequence_id) {
    return {
      failure: {
        status: 400,
        error: 'This member has no stored payment method, so the charge cannot be retried. Record a manual payment instead.',
      },
    };
  }

  const previousStatus = deriveBillingEventStatus(event.event_type, event.latest_tx_status);
  const amount = parseFloat(event.amount!);
  const attempts: PaymentAttempt[] = [];
  let succeeded = false;
  const baseAttempt = Number(event.last_attempt ?? 0);

  for (let i = 0; i < MAX_RETRY_ATTEMPTS && !succeeded; i++) {
    const attempt = baseAttempt + i + 1;
    const orderId = `RETRY-${gymId.slice(0, 8)}-${event.id}-${crypto.randomUUID().slice(0, 8)}`;

    let status: 'completed' | 'failed' = 'failed';
    let providerRef: string | null = null;
    let failureCode: string | null = null;
    let failureMessage: string | null = null;

    try {
      const result = await getPaymentProvider().executeRecurring({
        orderId,
        amount,
        currency: 'EUR',
        paymentToken: pm.payment_token,
        sequenceId: pm.sequence_id,
      });
      providerRef = result.providerRef ?? null;
      if (result.success) {
        status = 'completed';
      } else {
        failureCode = result.errorCode ?? null;
        failureMessage = result.errorMessage ?? null;
      }
    } catch (err) {
      // A provider/transport error is a failed attempt like any other: it is
      // recorded as a transaction so the Details view can explain the gap.
      failureCode = 'provider_error';
      failureMessage = (err as Error).message?.slice(0, 500) ?? null;
    }

    const paymentRequestId = await insertTransaction({
      ev: event, chargeTypeId, amount, status, source: 'retry', attempt,
      provider: pm.provider, providerOrder: orderId, providerRef,
      failureCode, failureMessage, notes: null, actorUserId,
    });

    attempts.push({
      payment_request_id: paymentRequestId, attempt, status,
      provider_ref: providerRef, failure_code: failureCode, failure_message: failureMessage,
    });
    if (status === 'completed') succeeded = true;
  }

  let membershipPaused = false;
  if (succeeded) {
    await advanceScheduleAfterPayment(event);
  } else if (event.membership_status === 'active') {
    // Q3: two consecutive rejections pause the assigned plan. The status flip
    // goes through the same append-only ledger row every other transition
    // writes (`recordStatusChange`), so the pause is explicable from the ledger.
    await db.transaction(async (tx) => {
      const { rows: current } = await tx.query<{ id: number; member_id: number; status: string }>(
        'SELECT id, member_id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
        [event.user_membership_id, gymId],
      );
      if (current.length === 0 || current[0].status !== 'active') return;
      await tx.query('UPDATE user_memberships SET status = ? WHERE id = ? AND gym_id = ?', ['paused', current[0].id, gymId]);
      await recordStatusChange(tx, {
        gymId, userMembershipId: current[0].id, memberId: current[0].member_id,
        previousStatus: current[0].status, newStatus: 'paused',
        source: actorSource, actorUserId,
      });
      membershipPaused = true;
    });
  }

  await stampEventModified(gymId, event.id, actorUserId);

  return {
    result: {
      billing_event_id: event.id,
      previous_status: previousStatus,
      new_status: succeeded ? 'paid' : 'failed',
      attempts,
      membership_paused: membershipPaused,
    },
  };
}

/**
 * Manual payment (§4, formerly "Flag as Paid"): records a front-desk payment
 * as a completed Payment Transaction on the same Billing Event. No provider
 * call, no new ledger row — the event simply reads as paid because its latest
 * transaction is completed.
 */
export async function recordManualPayment(
  gymId: string,
  billingEventId: number,
  actorUserId: string | null,
  input: { amount?: unknown; notes?: unknown },
): Promise<{ failure: ActionFailure } | { result: ManualPaymentResult }> {
  const ev = await loadEventContext(gymId, billingEventId);
  const guard = guardActionable(ev);
  if (guard) return { failure: guard };
  const event = ev!;

  const chargeTypeId = await resolveChargeTypeId(event);
  if (!chargeTypeId) return { failure: { status: 500, error: 'charge_type membership_fee not configured' } };

  // Defaults to the event's own amount; an explicit amount (a partial or
  // renegotiated settlement) is accepted but must be a positive number.
  let amount = parseFloat(event.amount!);
  if (input.amount != null && input.amount !== '') {
    const parsed = parseFloat(String(input.amount));
    if (isNaN(parsed) || parsed <= 0) {
      return { failure: { status: 400, error: 'amount must be greater than 0' } };
    }
    amount = parsed;
  }

  const notes = typeof input.notes === 'string' && input.notes.trim()
    ? input.notes.trim().slice(0, 500)
    : null;

  const previousStatus = deriveBillingEventStatus(event.event_type, event.latest_tx_status);

  const paymentRequestId = await insertTransaction({
    ev: event, chargeTypeId, amount, status: 'completed', source: 'manual',
    attempt: Number(event.last_attempt ?? 0) + 1,
    provider: 'manual', providerOrder: null, providerRef: null,
    failureCode: null, failureMessage: null, notes, actorUserId,
  });

  await advanceScheduleAfterPayment(event);
  await stampEventModified(gymId, event.id, actorUserId);

  return {
    result: {
      billing_event_id: event.id,
      previous_status: previousStatus,
      new_status: 'paid',
      payment_request_id: paymentRequestId,
      amount: amount.toFixed(2),
      notes,
    },
  };
}
