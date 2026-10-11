import { SYSTEM_ACTOR } from './auditActor';
import { eventAssignmentSql } from './billingEventOwnership';
import { chargeGuard } from './chargeGuard';
import { AttemptMethod, ManualPaymentMethod } from './paymentAttemptMethod';
import crypto from 'crypto';
import { Tx, db } from '../infra/db';
import { advanceBillingDate } from './billingDate';
import { recordStatusChange } from '../api/billing-events';
import { ASSIGNMENT_CADENCE } from '../api/assigned-plan-snapshot';
import { getPaymentProvider } from '../payments';
import { toMinorUnits } from '../payments/money';
import {
  BillingEventStatus,
  deriveBillingEventStatus,
  isPaymentActionable,
  isNonObligationEvent,
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
  method: ManualPaymentMethod;
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
  /** #1325: the ProductSet version that owns the obligation, when one does. */
  product_set_id: number | null;
  is_scheduled: number;
  billing_date: Date | string | null;
  event_type: string;
  amount: string | null;
  charge_type_id: number | null;
  latest_tx_status: string | null;
  has_completed_tx: number;
  membership_status: string | null;
  last_attempt: number | null;
}

/**
 * Loads everything both actions need to decide whether they may run. The
 * `latest_tx_status` subquery is the same one the list endpoint uses — see
 * `deriveBillingEventStatus`.
 */
async function loadEventContext(
  gymId: string,
  billingEventId: number,
  exec: Pick<Tx, 'query'> = db,
): Promise<EventContext | null> {
  const { rows } = await exec.query<EventContext>(
    `SELECT be.id, be.gym_id, be.member_id, um.id AS user_membership_id, be.event_type,
            be.product_set_id, be.is_scheduled, be.billing_date,
            be.amount, be.charge_type_id,
            (SELECT pr.status FROM payment_requests pr
              WHERE pr.billing_event_id = be.id
              ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS latest_tx_status,
            (SELECT COUNT(*) FROM payment_requests pr
              WHERE pr.billing_event_id = be.id AND pr.status = 'completed') AS has_completed_tx,
            (SELECT MAX(pr.attempt) FROM payment_requests pr
              WHERE pr.billing_event_id = be.id) AS last_attempt,
            um.status AS membership_status
       FROM billing_events be
       LEFT JOIN user_memberships um ON um.id = ${eventAssignmentSql()}
      WHERE be.id = ? AND be.gym_id = ?`,
    [billingEventId, gymId],
  );
  return rows[0] ?? null;
}

/**
 * Shared guards: the event must exist, be in a failed/rejected state, not
 * already be settled, and hang off a membership (a `payment_requests` row
 * cannot exist without one).
 */
function guardActionable(ev: EventContext | null): ActionFailure | null {
  if (!ev) return { status: 404, error: 'Billing event not found' };
  if (Number(ev.has_completed_tx) > 0) {
    return { status: 409, error: 'This billing event has already been paid.' };
  }
  if (isNonObligationEvent(ev.event_type)) {
    return { status: 400, error: 'Payment actions are not available for a one-off purchase or a card verification.' };
  }
  const status = deriveBillingEventStatus(ev.event_type, ev.latest_tx_status);
  // #1325: a ProductSet's persisted obligation that is due and nothing has
  // collected — a member with no stored card is the usual case — is payable by
  // staff exactly like a failed one.
  const today = new Date().toISOString().slice(0, 10);
  const dueDate = ev.billing_date == null ? null
    : (ev.billing_date instanceof Date ? ev.billing_date.toISOString() : String(ev.billing_date)).slice(0, 10);
  const scheduledAndDue = Number(ev.is_scheduled) === 1 && dueDate != null && dueDate <= today;
  if (!isPaymentActionable(status) && !scheduledAndDue) {
    return { status: 400, error: `Payment actions are only available for failed billing events (this one is '${status}').` };
  }
  if (!ev.product_set_id) {
    return { status: 400, error: 'This billing event is not linked to a ProductSet.' };
  }
  const amount = ev.amount != null ? parseFloat(ev.amount) : NaN;
  if (!(amount > 0)) {
    return { status: 400, error: 'This billing event has no amount to charge.' };
  }
  return null;
}

/**
 * #1325: the event of a ProductSet leaves the scheduled state once somebody has
 * dealt with it, and its type says how it ended. Idempotent and a no-op for a
 * legacy event (`is_scheduled` is 0 and the type is already settled).
 */
async function closeScheduledEvent(tx: Tx, ev: EventContext, outcome: 'paid' | 'failed', actor: string | null): Promise<void> {
  if (!ev.product_set_id) return;
  await tx.query(
    `UPDATE billing_events SET is_scheduled = 0, event_type = ?,
            modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE id = ? AND gym_id = ? AND (is_scheduled = 1 OR event_type IN ('charge_created', 'failed_billing'))`,
    [outcome === 'paid' ? 'recurring_payment' : 'failed_billing', actor, ev.id, ev.gym_id],
  );
}

/**
 * The charge type a *charge* names. Nullable since migration 195 (a #788 card
 * verification bills nothing and carries NULL), so the fallback is no longer the
 * schema's requirement but the invariant these two paths keep: a row that moves
 * money always says what for.
 */
async function resolveChargeTypeId(ev: EventContext): Promise<number | null> {
  if (ev.charge_type_id) return ev.charge_type_id;
  const { rows } = await db.query<{ id: number }>(
    "SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1",
  );
  return rows[0]?.id ?? null;
}


/** Stamps §2's Modified At / Modified By on the parent Billing Event. */
async function stampEventModified(gymId: string, billingEventId: number, actor: string | null): Promise<void> {
  await db.query(
    'UPDATE billing_events SET modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ?',
    [actor, billingEventId, gymId],
  );
}

async function insertTransaction(params: {
  ev: EventContext;
  chargeTypeId: number;
  amount: number;
  status: 'completed' | 'failed';
  source: 'retry' | 'manual';
  /** #1459: how the attempt was made; defaults from `source` (manual → cash, retry → provider). */
  method?: AttemptMethod;
  /** Runs inside the caller's transaction when given. */
  exec?: Pick<Tx, 'query'>;
  attempt: number;
  provider: string;
  providerOrder: string | null;
  providerRef: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  notes: string | null;
  /** #1182: plain-text actor snapshot written as `created_by` / `modified_by`. */
  actor: string | null;
  /** #1325: the provider's own status, verbatim (a manual payment has none). */
  providerStatus?: string | null;
}): Promise<number> {
  const { insertId } = await (params.exec ?? db).query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        billing_event_id, status, provider, provider_order, provider_ref,
        source, attempt, created_by, failure_code, failure_message, notes,
        method, provider_status,
        created_at, completed_at, modified_at, modified_by)
     VALUES (?, ?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             UTC_TIMESTAMP(), ?, UTC_TIMESTAMP(), ?)`,
    [
      params.ev.gym_id, params.ev.user_membership_id, params.ev.member_id,
      params.amount.toFixed(2), params.chargeTypeId, params.ev.id,
      params.status, params.provider, params.providerOrder, params.providerRef,
      params.source, params.attempt, params.actor,
      params.failureCode, params.failureMessage, params.notes,
      params.method ?? (params.source === 'manual' ? 'cash' : 'provider'), params.providerStatus ?? null,
      params.status === 'completed' ? new Date() : null,
      params.actor,
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
  /** #1182: the plain-text actor snapshot, written as `modified_by` of a plan the rejections pause. */
  actorArg?: string | null,
): Promise<{ failure: ActionFailure } | { result: RetryResult }> {
  const actor = actorArg === undefined ? (actorUserId ? null : SYSTEM_ACTOR) : actorArg;
  const ev = await loadEventContext(gymId, billingEventId);
  const guard = guardActionable(ev);
  if (guard) return { failure: guard };
  const event = ev!;

  const chargeTypeId = await resolveChargeTypeId(event);
  if (!chargeTypeId) return { failure: { status: 500, error: 'charge_type membership_fee not configured' } };

  // #1325: the duplicate-charge rule, over the raw status of every earlier
  // attempt — a settled, in-flight, unknown or refunded one refuses the retry.
  const { rows: earlier } = await db.query<any>(
    `SELECT id, method, provider_status, provider_ref, status FROM payment_requests WHERE billing_event_id = ?`,
    [event.id]);
  const guarded = chargeGuard(earlier.map((a: any) => ({
    id: Number(a.id), method: (a.method ?? 'provider') as AttemptMethod,
    providerStatus: a.provider_status ?? null, providerRef: a.provider_ref ?? null, status: String(a.status),
  })));
  if (!guarded.allowed) {
    return { failure: { status: 409, error: `This charge cannot be retried (${guarded.reason}); reconcile the earlier attempt first.` } };
  }

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
    let rawProviderStatus: string | null = null;

    try {
      const result = await getPaymentProvider().executeRecurring({
        orderId,
        amount: toMinorUnits(amount),
        currency: 'EUR',
        paymentToken: pm.payment_token,
        sequenceId: pm.sequence_id,
      });
      providerRef = result.providerRef ?? null;
      rawProviderStatus = result.providerStatus ?? null;
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
      failureCode, failureMessage, notes: null, actor,
      providerStatus: rawProviderStatus,
    });

    attempts.push({
      payment_request_id: paymentRequestId, attempt, status,
      provider_ref: providerRef, failure_code: failureCode, failure_message: failureMessage,
    });
    if (status === 'completed') succeeded = true;
  }

  let membershipPaused = false;
  await db.transaction((tx) => closeScheduledEvent(tx, event, succeeded ? 'paid' : 'failed', actor));
  if (succeeded) {
  } else if (event.membership_status === 'active' && event.user_membership_id) {
    // Q3: two consecutive rejections pause the assigned plan. The status flip
    // goes through the same append-only ledger row every other transition
    // writes (`recordStatusChange`), so the pause is explicable from the ledger.
    await db.transaction(async (tx) => {
      const { rows: current } = await tx.query<{ id: number; member_id: number; status: string }>(
        'SELECT id, member_id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
        [event.user_membership_id, gymId],
      );
      if (current.length === 0 || current[0].status !== 'active') return;
      await tx.query(
        `UPDATE user_memberships
            SET status = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ? AND gym_id = ?`,
        ['paused', actor, current[0].id, gymId]);
      await recordStatusChange(tx, {
        gymId, userMembershipId: current[0].id, memberId: current[0].member_id,
        previousStatus: current[0].status, newStatus: 'paused',
        source: actorSource, actorUserId,
      });
      membershipPaused = true;
    });
  }

  await stampEventModified(gymId, event.id, actor);

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
  /** #1182: the plain-text actor snapshot (`resolveRequestActor()`); omitted with no user = System. */
  actorArg?: string | null,
  /** #1459: `cash` (default) or `card_terminal`; neither calls the online provider. */
  method: ManualPaymentMethod = 'cash',
): Promise<{ failure: ActionFailure } | { result: ManualPaymentResult }> {
  const actor = actorArg === undefined ? (actorUserId ? null : SYSTEM_ACTOR) : actorArg;

  // #1459: the event's row lock is what makes a duplicate settlement
  // impossible, not the button: two concurrent requests serialise here and the
  // second one reads the first one's completed attempt and answers 409.
  return db.transaction(async (tx) => {
    await tx.query('SELECT id FROM billing_events WHERE id = ? AND gym_id = ? FOR UPDATE', [billingEventId, gymId]);
    const ev = await loadEventContext(gymId, billingEventId, tx);
    const guard = guardActionable(ev);
    if (guard) return { failure: guard };
    const event = ev!;

    const earlier = await loadEarlierAttempts(tx, event.id);
    const guarded = chargeGuard(earlier);
    if (!guarded.allowed) {
      return { failure: { status: 409, error: `This payment cannot be recorded (${guarded.reason}); reconcile the earlier attempt first.` } };
    }

    const chargeTypeId = await resolveChargeTypeId(event);
    if (!chargeTypeId) return { failure: { status: 500, error: 'charge_type membership_fee not configured' } };

    // Defaults to the event's own amount; an explicit amount (a partial or
    // renegotiated settlement) is accepted but must be a positive number. The
    // confirmation modal never sends one (#1459: the full outstanding amount).
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
      ev: event, chargeTypeId, amount, status: 'completed', source: 'manual', method,
      attempt: Number(event.last_attempt ?? 0) + 1,
      provider: 'manual', providerOrder: null, providerRef: null,
      failureCode: null, failureMessage: null, notes, actor, exec: tx,
    });

    await closeScheduledEvent(tx, event, 'paid', actor);
    await tx.query(
      'UPDATE billing_events SET modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ?',
      [actor, event.id, gymId],
    );

    return {
      result: {
        method,
        billing_event_id: event.id,
        previous_status: previousStatus,
        new_status: 'paid' as BillingEventStatus,
        payment_request_id: paymentRequestId,
        amount: amount.toFixed(2),
        notes,
      },
    };
  });
}

export interface WaiveResult {
  billing_event_id: number;
  previous_status: BillingEventStatus;
  /** The amount the gym gave up; the attempt itself carries 0.00 so no total counts it as money. */
  waived_amount: string;
  reason: string;
  payment_request_id: number;
}

/**
 * #1459 — **Waive**: staff give up an outstanding amount. A `waive` attempt
 * (amount 0.00, like the nightly run's own waiver, so nothing summing
 * collected money can count it) is written on the **same** event, which
 * becomes `waived_billing` — a type no receipt is ever issued for. No provider
 * call, no new ledger row, and it is never a received payment. Eligibility is
 * the manual payment's exactly (`guardActionable` + `chargeGuard`, under the
 * event's row lock); a reason is required and goes on the attempt's notes and
 * the audit row. It does not reactivate or pause anything: reactivation stays
 * explicit.
 */
export async function waiveBillingEvent(
  gymId: string,
  billingEventId: number,
  actorUserId: string | null,
  input: { reason?: unknown },
  actorArg?: string | null,
): Promise<{ failure: ActionFailure } | { result: WaiveResult }> {
  const actor = actorArg === undefined ? (actorUserId ? null : SYSTEM_ACTOR) : actorArg;
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
  if (!reason) return { failure: { status: 400, error: 'A reason is required to waive an amount.' } };

  return db.transaction(async (tx) => {
    await tx.query('SELECT id FROM billing_events WHERE id = ? AND gym_id = ? FOR UPDATE', [billingEventId, gymId]);
    const ev = await loadEventContext(gymId, billingEventId, tx);
    const guard = guardActionable(ev);
    if (guard) return { failure: guard };
    const event = ev!;

    const guarded = chargeGuard(await loadEarlierAttempts(tx, event.id));
    if (!guarded.allowed) {
      return { failure: { status: 409, error: `This amount cannot be waived (${guarded.reason}); reconcile the earlier attempt first.` } };
    }
    const chargeTypeId = await resolveChargeTypeId(event);
    if (!chargeTypeId) return { failure: { status: 500, error: 'charge_type membership_fee not configured' } };

    const previousStatus = deriveBillingEventStatus(event.event_type, event.latest_tx_status);
    const waived = parseFloat(event.amount!);

    const paymentRequestId = await insertTransaction({
      ev: event, chargeTypeId, amount: 0, status: 'completed', source: 'manual', method: 'waive',
      attempt: Number(event.last_attempt ?? 0) + 1,
      provider: 'manual', providerOrder: null, providerRef: null,
      failureCode: null, failureMessage: null, notes: reason, actor, exec: tx,
    });
    await tx.query(
      `UPDATE billing_events SET is_scheduled = 0, event_type = 'waived_billing',
              modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE id = ? AND gym_id = ?`,
      [actor, event.id, gymId],
    );

    return {
      result: {
        billing_event_id: event.id,
        previous_status: previousStatus,
        waived_amount: waived.toFixed(2),
        reason,
        payment_request_id: paymentRequestId,
      },
    };
  });
}

/** Every earlier attempt of the event, in the shape `chargeGuard()` reads. */
async function loadEarlierAttempts(exec: Pick<Tx, 'query'>, billingEventId: number) {
  const { rows } = await exec.query<any>(
    'SELECT id, method, provider_status, provider_ref, status FROM payment_requests WHERE billing_event_id = ?',
    [billingEventId],
  );
  return rows.map((a: any) => ({
    id: Number(a.id), method: (a.method ?? 'provider') as AttemptMethod,
    providerStatus: a.provider_status ?? null, providerRef: a.provider_ref ?? null, status: String(a.status),
  }));
}
