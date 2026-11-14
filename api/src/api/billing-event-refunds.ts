import { db, type Tx } from '../infra/db';
import { recordPaymentAttempt } from './payment-attempt';
import { getPaymentProvider } from '../payments';
import { canCancelPending } from '../domain/productSet';
import {
  BillingEventStatus, canCancelBillingEvent, deriveBillingEventStatus,
} from '../domain/billingEventStatus';
import {
  LineState, RefundBalance, RefundMethod, RefundRequestInput, RefundState,
  completedRefundCents, decideRefund, fromCents, isManualRefundMethod, refundBalance, refundMethodFor,
  refundOutcomeFromProvider, refundState, toCents,
} from '../domain/billingEventRefund';

/**
 * #2480 — Cancel a pending Billing Event and Refund a collected one. The pure
 * rules are `domain/billingEventRefund.ts`; this is the one writer of a refund
 * Payment Transaction (`payment_requests.transaction_type = 'refund'`) and of
 * `billing_events.cancelled_at`.
 *
 * A refund row names the payment attempt it returns money from
 * (`refund_of_payment_request_id`) and carries **no** `billing_event_id`, so
 * the event's derived status, its attempt counter (`recordPaymentAttempt()`
 * only counts a row with an event) and the charge guard never read it as an
 * attempt to settle the event.
 */

type Exec = Pick<Tx, 'query'>;

export interface ActionFailure { status: number; error: string }

/** The completed payment attempt a refund returns money from: the latest one that moved money. */
async function loadOriginalPayment(exec: Exec, gymId: string, billingEventId: number) {
  const { rows } = await exec.query<any>(
    `SELECT id, amount, method, provider, provider_ref, member_id, payer_member_id,
            user_membership_id, charge_type_id, currency, payment_method_name
       FROM payment_requests
      WHERE billing_event_id = ? AND gym_id = ? AND transaction_type = 'payment'
        AND status = 'completed' AND method IN ('provider', 'cash', 'card_terminal') AND amount > 0
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [billingEventId, gymId],
  );
  return rows[0] ?? null;
}

async function loadRefunds(exec: Exec, paymentRequestId: number) {
  const { rows } = await exec.query<any>(
    `SELECT id, amount, status FROM payment_requests
      WHERE refund_of_payment_request_id = ? AND transaction_type = 'refund'`,
    [paymentRequestId],
  );
  return rows as { id: number; amount: string; status: string }[];
}

async function loadLines(exec: Exec, gymId: string, billingEventId: number): Promise<(LineState & { item_name: string; kind: string; quantity: number })[]> {
  const { rows } = await exec.query<any>(
    `SELECT bel.id, bel.kind, bel.item_name, bel.quantity, bel.amount,
            COALESCE((SELECT SUM(prl.amount) FROM payment_refund_lines prl
                        JOIN payment_requests r ON r.id = prl.payment_request_id
                       WHERE prl.billing_event_line_id = bel.id AND r.status IN ('completed', 'pending')), 0) AS refunded
       FROM billing_event_lines bel
      WHERE bel.billing_event_id = ? AND bel.gym_id = ?
      ORDER BY bel.id`,
    [billingEventId, gymId],
  );
  return rows.map((r: any) => ({
    id: Number(r.id), kind: r.kind, item_name: r.item_name, quantity: Number(r.quantity),
    amount: r.amount, refundedCents: toCents(r.refunded),
  }));
}

export interface RefundOptions {
  billing_event_id: number;
  collected_amount: string;
  refunded_amount: string;
  refundable_amount: string;
  refund_state: RefundState;
  /**
   * #2797 — the original payment's method, which the refund goes back through.
   * Read-only: there is nothing to choose. `manual` means no provider is
   * called and the gym returns the money itself.
   */
  method: { code: RefundMethod; name: string; manual: boolean };
  lines: { id: number; kind: string; item_name: string; quantity: number; amount: string; refunded_amount: string; refundable_amount: string }[];
}

const METHOD_CATALOGUE_CODE: Record<RefundMethod, string> = { cash: 'cash', card_terminal: 'card', provider: 'monei' };

const NO_ORIGINAL_METHOD: ActionFailure = {
  status: 409,
  error: 'The original payment method of this billing event cannot be determined (a provider payment with no provider reference), so it cannot be refunded.',
};

/**
 * The name the original payment was recorded under: the attempt's own snapshot
 * (#2451), and the catalogue's English name only for an attempt written before
 * the snapshot existed.
 */
async function originalMethodName(exec: Exec, original: any, method: RefundMethod): Promise<string> {
  if (original.payment_method_name) return String(original.payment_method_name);
  const code = METHOD_CATALOGUE_CODE[method];
  const { rows } = await exec.query<any>(
    `SELECT COALESCE((SELECT t.name FROM base_payment_method_translations t
                       WHERE t.base_payment_method_id = m.id AND t.locale = 'en'), m.code) AS name
       FROM base_payment_methods m WHERE m.deleted_at IS NULL AND m.code = ?`,
    [code],
  );
  return String(rows[0]?.name ?? code);
}

/** GET …/:id/refund-options — what the Refund modal shows. 404 when the event does not exist; 409 when nothing was collected. */
export async function loadRefundOptions(gymId: string, billingEventId: number): Promise<{ failure: ActionFailure } | { result: RefundOptions }> {
  const { rows: ev } = await db.query<any>('SELECT id FROM billing_events WHERE id = ? AND gym_id = ?', [billingEventId, gymId]);
  if (!ev[0]) return { failure: { status: 404, error: 'Billing event not found' } };
  const original = await loadOriginalPayment(db, gymId, billingEventId);
  if (!original) return { failure: { status: 409, error: 'This billing event has no collected payment to refund.' } };
  const refunds = await loadRefunds(db, original.id);
  const balance = refundBalance(toCents(original.amount), refunds);
  const lines = await loadLines(db, gymId, billingEventId);
  const method = refundMethodFor({ method: original.method, providerRef: original.provider_ref });
  if (!method) return { failure: NO_ORIGINAL_METHOD };
  return {
    result: {
      billing_event_id: billingEventId,
      collected_amount: fromCents(balance.collectedCents),
      refunded_amount: fromCents(balance.refundedCents),
      refundable_amount: fromCents(balance.refundableCents),
      refund_state: refundState(balance.collectedCents, completedRefundCents(refunds)),
      method: { code: method, name: await originalMethodName(db, original, method), manual: isManualRefundMethod(method) },
      lines: lines.map((l) => ({
        id: l.id, kind: l.kind, item_name: l.item_name, quantity: l.quantity,
        amount: fromCents(toCents(l.amount)),
        refunded_amount: fromCents(l.refundedCents),
        refundable_amount: fromCents(Math.max(0, toCents(l.amount) - l.refundedCents)),
      })),
    },
  };
}

export interface RefundSummary {
  refunded_amount: string;
  refundable_amount: string;
  refund_state: RefundState;
}

/** One query for a page of events: what each has refunded and may still refund. */
export async function loadRefundSummaries(gymId: string, billingEventIds: number[]): Promise<Map<number, RefundSummary>> {
  const out = new Map<number, RefundSummary>();
  if (billingEventIds.length === 0) return out;
  const { rows } = await db.query<any>(
    `SELECT o.billing_event_id, o.id, o.amount,
            COALESCE(SUM(CASE WHEN r.status IN ('completed', 'pending') THEN r.amount END), 0) AS reserved,
            COALESCE(SUM(CASE WHEN r.status = 'completed' THEN r.amount END), 0) AS completed
       FROM payment_requests o
       LEFT JOIN payment_requests r ON r.refund_of_payment_request_id = o.id AND r.transaction_type = 'refund'
      WHERE o.gym_id = ? AND o.billing_event_id IN (${billingEventIds.map(() => '?').join(',')})
        AND o.transaction_type = 'payment' AND o.status = 'completed'
        AND o.method IN ('provider', 'cash', 'card_terminal') AND o.amount > 0
      GROUP BY o.billing_event_id, o.id, o.amount, o.created_at
      ORDER BY o.created_at DESC, o.id DESC`,
    [gymId, ...billingEventIds],
  );
  for (const r of rows) {
    const id = Number(r.billing_event_id);
    if (out.has(id)) continue; // the latest collected attempt is the one refunded
    const collected = toCents(r.amount);
    out.set(id, {
      refunded_amount: fromCents(toCents(r.completed)),
      refundable_amount: fromCents(Math.max(0, collected - toCents(r.reserved))),
      refund_state: refundState(collected, toCents(r.completed)),
    });
  }
  return out;
}

// ── Cancel ────────────────────────────────────────────────────────────────────

export interface CancelResult {
  billing_event_id: number;
  previous_status: BillingEventStatus;
  new_status: 'cancelled';
  expired_attempts: number;
}

/**
 * Cancels a `pending` Billing Event: the event is stamped `cancelled_at` (never
 * deleted), and its open attempts are expired so their checkout link can no
 * longer be paid. Refused while an attempt was submitted to the provider and
 * its outcome is not known (`canCancelPending()`, #1325's rule), because money
 * may still arrive. Taken under the event's row lock, so a second request finds
 * the event cancelled and answers 409.
 */
export async function cancelBillingEvent(gymId: string, billingEventId: number, actor: string | null): Promise<{ failure: ActionFailure } | { result: CancelResult }> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<any>(
      `SELECT id, event_type, is_scheduled, cancelled_at FROM billing_events WHERE id = ? AND gym_id = ? FOR UPDATE`,
      [billingEventId, gymId],
    );
    const ev = rows[0];
    if (!ev) return { failure: { status: 404, error: 'Billing event not found' } };
    if (ev.cancelled_at != null) return { failure: { status: 409, error: 'This billing event is already cancelled.' } };

    const { rows: attempts } = await tx.query<any>(
      `SELECT id, status, provider_ref, provider_status FROM payment_requests
        WHERE billing_event_id = ? AND transaction_type = 'payment'
        ORDER BY created_at DESC, id DESC`,
      [billingEventId],
    );
    const status: BillingEventStatus = Number(ev.is_scheduled) === 1
      ? 'scheduled' : deriveBillingEventStatus(ev.event_type, attempts[0]?.status ?? null);
    if (!canCancelBillingEvent(status)) {
      return { failure: { status: 409, error: `Only a pending billing event can be cancelled (this one is '${status}').` } };
    }
    const pendingAttempts = attempts.filter((a: any) => a.status === 'pending');
    if (!canCancelPending(pendingAttempts.map((a: any) => ({
      providerRef: a.provider_ref ?? null, providerStatus: a.provider_status ?? null, status: a.status,
    })))) {
      return { failure: { status: 409, error: 'A payment of this billing event is being processed; it cannot be cancelled until its outcome is known.' } };
    }

    const { rowCount: expiredCount } = await tx.query(
      `UPDATE payment_requests SET status = 'expired', page_token = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE billing_event_id = ? AND transaction_type = 'payment' AND status = 'pending'`,
      [actor, billingEventId],
    );
    await tx.query(
      `UPDATE billing_events SET cancelled_at = UTC_TIMESTAMP(), cancelled_by = ?,
              modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE id = ? AND gym_id = ?`,
      [actor, actor, billingEventId, gymId],
    );
    return { result: { billing_event_id: billingEventId, previous_status: status, new_status: 'cancelled' as const, expired_attempts: Number(expiredCount ?? 0) } };
  });
}

// ── Refund ────────────────────────────────────────────────────────────────────

export interface RefundResult {
  billing_event_id: number;
  refund_payment_request_id: number;
  kind: string;
  method: RefundMethod;
  amount: string;
  /** `completed`, or `pending` when the provider has not confirmed it yet. */
  status: 'completed' | 'pending';
  provider_status: string | null;
  provider_refund_ref: string | null;
  balance: { collected_amount: string; refunded_amount: string; refundable_amount: string; refund_state: RefundState };
}

const ATTEMPT_METHOD: Record<RefundMethod, string> = { cash: 'cash', card_terminal: 'card_terminal', provider: 'provider' };

/**
 * Refunds a collected Billing Event. Two transactions around the provider call,
 * never one, so the provider is never called while the event's row lock is
 * held, and so a crash or timeout leaves a **pending** refund that keeps its
 * amount reserved:
 *
 * The refund goes back through the original payment's own method (#2797): the
 * request chooses none, and one naming another is refused.
 *
 *  1. under the event's row lock: judge the request against the balance (which
 *     already counts every completed and pending refund), insert the refund
 *     Payment Transaction (`completed` for a manual method, `pending` for the
 *     provider) and its lines. A concurrent request waits on the lock and is
 *     judged against the reduced balance, so the refunds can never exceed what
 *     was collected.
 *  2. provider only: call MONEI, then record its answer on that row —
 *     `completed` once it says REFUNDED/PARTIALLY_REFUNDED, `failed` when it
 *     refuses (the amount is released), and left `pending` when it cannot be
 *     reached (an unknown outcome is never a failure, #785/#1325).
 *
 * The original attempt, the Billing Event's ledger row, its lines, any receipt
 * or invoice and every contracted item are left exactly as they were.
 */
export async function refundBillingEvent(
  gymId: string,
  billingEventId: number,
  input: RefundRequestInput,
  actor: string | null,
): Promise<{ failure: ActionFailure } | { result: RefundResult }> {
  const prepared = await db.transaction(async (tx) => {
    const { rows } = await tx.query<any>(
      'SELECT id, cancelled_at FROM billing_events WHERE id = ? AND gym_id = ? FOR UPDATE', [billingEventId, gymId]);
    if (!rows[0]) return { failure: { status: 404, error: 'Billing event not found' } as ActionFailure };
    const original = await loadOriginalPayment(tx, gymId, billingEventId);
    if (!original) return { failure: { status: 409, error: 'This billing event has no collected payment to refund.' } };

    const refunds = await loadRefunds(tx, original.id);
    const balance: RefundBalance = refundBalance(toCents(original.amount), refunds);
    const lines = await loadLines(tx, gymId, billingEventId);
    const originalMethod = refundMethodFor({ method: original.method, providerRef: original.provider_ref });
    if (!originalMethod) return { failure: NO_ORIGINAL_METHOD };
    const decision = decideRefund(input, balance, lines, originalMethod);
    if (!decision.ok) {
      const status = balance.refundableCents <= 0 ? 409 : 400;
      return { failure: { status, error: decision.error } };
    }
    const refund = decision.refund;
    const viaProvider = refund.method === 'provider';

    const { insertId } = await tx.query(
      `INSERT INTO payment_requests
         (gym_id, user_membership_id, member_id, payer_member_id, amount, currency, charge_type_id,
          billing_event_id, status, provider, provider_order, provider_ref, source, attempt,
          created_by, notes, method, transaction_type, refund_of_payment_request_id,
          created_at, completed_at, modified_at, modified_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, 'manual', 1, ?, ?, ?, 'refund', ?,
               UTC_TIMESTAMP(), ?, UTC_TIMESTAMP(), ?)`,
      [
        gymId, original.user_membership_id, original.member_id, original.payer_member_id,
        fromCents(refund.amountCents), original.currency ?? 'EUR', original.charge_type_id,
        viaProvider ? 'pending' : 'completed', viaProvider ? (original.provider ?? 'monei') : 'manual',
        actor, `Refund (${refund.kind}) of payment #${original.id}`, ATTEMPT_METHOD[refund.method], original.id,
        viaProvider ? null : new Date(), actor,
      ],
    );
    // The method snapshot; a refund has no event, so the attempt counter is untouched.
    await recordPaymentAttempt(tx, insertId);
    for (const l of refund.lines) {
      await tx.query(
        `INSERT INTO payment_refund_lines (gym_id, payment_request_id, billing_event_line_id, amount, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [gymId, insertId, l.id, fromCents(l.cents), actor],
      );
    }
    await tx.query(
      'UPDATE billing_events SET modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ?',
      [actor, billingEventId, gymId],
    );
    return { prepared: { refundId: Number(insertId), refund, original } };
  });
  if ('failure' in prepared) return { failure: prepared.failure! };
  const { refundId, refund, original } = prepared.prepared!;

  let status: 'completed' | 'pending' = 'completed';
  let providerStatus: string | null = null;
  let providerRefundRef: string | null = null;

  if (refund.method === 'provider') {
    status = 'pending';
    let answer;
    try {
      answer = await getPaymentProvider().refundPayment({ providerRef: original.provider_ref, amount: refund.amountCents });
    } catch (err: any) {
      // Unreachable or refused outright. A transport failure is an unknown
      // outcome: the refund stays pending and its amount stays reserved, so a
      // retry can never refund it twice. A refusal the provider answered (an
      // HTTP 4xx) is a definitive no and releases the amount.
      const message = String(err?.message ?? err);
      if (/Monei API error 4\d\d/.test(message)) {
        await db.query(
          `UPDATE payment_requests SET status = 'failed', failure_message = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
            WHERE id = ? AND status = 'pending'`,
          [message.slice(0, 500), actor, refundId],
        );
        return { failure: { status: 502, error: 'The payment provider refused the refund.' } };
      }
      return { failure: { status: 502, error: 'The payment provider could not be reached; the refund is recorded as pending and its amount stays reserved.' } };
    }
    providerStatus = answer.providerStatus;
    providerRefundRef = answer.providerRefundRef;
    const outcome = refundOutcomeFromProvider(answer.providerStatus);
    await db.query(
      `UPDATE payment_requests
          SET status = ?, provider_status = ?, provider_refund_ref = ?, failure_code = ?, failure_message = ?,
              completed_at = IF(? = 'completed', UTC_TIMESTAMP(), NULL), modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE id = ? AND status = 'pending'`,
      [outcome, providerStatus, providerRefundRef,
        outcome === 'failed' ? answer.errorCode : null, outcome === 'failed' ? answer.errorMessage : null,
        outcome, actor, refundId],
    );
    if (outcome === 'failed') {
      return { failure: { status: 502, error: `The payment provider did not refund the payment${answer.errorMessage ? `: ${answer.errorMessage}` : '.'}` } };
    }
    status = outcome;
  }

  const refunds = await loadRefunds(db, original.id);
  const balance = refundBalance(toCents(original.amount), refunds);
  return {
    result: {
      billing_event_id: billingEventId,
      refund_payment_request_id: refundId,
      kind: refund.kind,
      method: refund.method,
      amount: fromCents(refund.amountCents),
      status,
      provider_status: providerStatus,
      provider_refund_ref: providerRefundRef,
      balance: {
        collected_amount: fromCents(balance.collectedCents),
        refunded_amount: fromCents(completedRefundCents(refunds)),
        refundable_amount: fromCents(balance.refundableCents),
        refund_state: refundState(balance.collectedCents, completedRefundCents(refunds)),
      },
    },
  };
}
