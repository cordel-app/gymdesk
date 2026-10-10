import crypto from 'crypto';
import { db, Tx } from '../infra/db';
import { getPaymentProvider } from '../payments';
import { toMinorUnits } from '../payments/money';
import { chargeGuard, EarlierAttempt } from '../domain/chargeGuard';
import { classifyProviderStatus, normaliseProviderStatus } from '../domain/providerPaymentStatus';
import { issueReceiptNumber } from '../domain/receiptNumbers';
import { recordStatusChange } from './billing-events';

/**
 * #1325 PR 2c — executing a ProductSet's persisted Billing Events.
 *
 * The Billing Event is the authoritative source of the charge: its own amount,
 * its own due date, its own attempts. Nothing here reads
 * `user_memberships.next_billing_date`, and nothing re-prices — the amount was
 * persisted by `materialiseScheduledEvents()` from the engine, and a ProductSet
 * edit replaces it before it is due, never after.
 *
 * Since #1325 PR 3 it is the **whole** of `POST /billing/run`: the assignment
 * pass that priced the cycle `next_billing_date` named is gone, and every
 * committed assignment is a ProductSet version whose obligations are here.
 *
 * Per event, in order, under the event's row lock:
 *   1. `chargeGuard()` over the raw status of *every* earlier attempt — a
 *      settled, in-flight, unknown or refunded one refuses the charge (logged
 *      for reconciliation, never retried);
 *   2. one attempt per UTC day, and at most `MAX_FAILED_DAYS` failed days
 *      (#785's cadence: the retry is the next run day, never the same loop) —
 *      reaching that count **pauses** the assignment the set projects
 *      (`recordStatusChange`, `active → paused`, `source = 'system'`), which is
 *      #785's escalation on the event's own attempts rather than on a stored
 *      counter; reactivating is explicit, as it always was;
 *   3. a zero amount is **waived**: a `payment_requests` row of method `waive`,
 *      no provider call;
 *   4. no stored card: nothing is attempted and the event stays scheduled and
 *      past due (which blocks a ProductSet edit; it never counts towards a
 *      pause, #785);
 *   5. otherwise the attempt row is written **before** the provider is called,
 *      so a crash or timeout leaves an attempt with no provider status — an
 *      unknown outcome the guard and the editing lock both treat as unresolved —
 *      and is closed with the raw provider status afterwards.
 */

export const MAX_FAILED_DAYS = 2;

export interface ExecutionSummary {
  processed: number;
  succeeded: number;
  failed: number;
  waived: number;
  skipped: number;
  /** Assignments paused after `MAX_FAILED_DAYS` failed days on one event (#785). */
  paused: number;
  receiptsIssued: number;
}

interface DueEvent {
  id: number;
  gym_id: string;
  product_set_id: number;
  member_id: number | null;
  amount: string | number;
  payment_token: string | null;
  sequence_id: string | null;
  provider: string | null;
}

type Outcome = 'succeeded' | 'failed' | 'waived' | 'skipped' | 'unknown';

async function loadAttempts(tx: Tx, eventId: number) {
  const { rows } = await tx.query<any>(
    `SELECT id, method, provider_status, provider_ref, status, attempt,
            DATE(created_at) AS attempt_day, (DATE(created_at) = UTC_DATE()) AS today
       FROM payment_requests WHERE billing_event_id = ? ORDER BY attempt ASC, id ASC FOR UPDATE`,
    [eventId],
  );
  return rows;
}

/**
 * #785's escalation, on the event's own attempts: once this event has failed on
 * `MAX_FAILED_DAYS` distinct UTC days, the assignment the set projects is paused
 * — inside the transaction that closes the attempt, so the failure and the pause
 * land together. Decided from the rows under the lock, never from a stored
 * counter. Only an `active` assignment is ours to pause; the audit row is how
 * it is explicable afterwards, and reactivating stays explicit.
 */
async function pauseAfterFailedDays(tx: Tx, event: DueEvent): Promise<boolean> {
  const { rows: days } = await tx.query<{ n: number | string }>(
    `SELECT COUNT(DISTINCT DATE(created_at)) AS n FROM payment_requests
      WHERE billing_event_id = ? AND method = 'provider' AND status = 'failed'`,
    [event.id],
  );
  if (Number(days[0]?.n ?? 0) < MAX_FAILED_DAYS) return false;

  const { rows } = await tx.query<{ id: number; member_id: number; status: string }>(
    `SELECT um.id, um.member_id, um.status
       FROM product_sets ps JOIN user_memberships um ON um.id = ps.user_membership_id
      WHERE ps.id = ? AND ps.gym_id = ? FOR UPDATE`,
    [event.product_set_id, event.gym_id],
  );
  const um = rows[0];
  if (!um || um.status !== 'active') return false;
  await tx.query("UPDATE user_memberships SET status = 'paused' WHERE id = ? AND gym_id = ?", [um.id, event.gym_id]);
  await recordStatusChange(tx, {
    gymId: event.gym_id, userMembershipId: Number(um.id), memberId: Number(um.member_id),
    previousStatus: um.status, newStatus: 'paused', source: 'system', actorUserId: null,
  });
  return true;
}

async function chargeTypeId(): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    "SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  return rows[0]?.id ?? null;
}

export async function executeDueScheduledEvents(opts: {
  today: string;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
}): Promise<ExecutionSummary> {
  const summary: ExecutionSummary = { processed: 0, succeeded: 0, failed: 0, waived: 0, skipped: 0, paused: 0, receiptsIssued: 0 };
  const log = opts.log;
  const feeTypeId = await chargeTypeId();

  // First attempts (scheduled and due) and retries (failed, set still Active).
  const { rows: due } = await db.query<DueEvent>(
    `SELECT be.id, be.gym_id, be.product_set_id, be.member_id, be.amount, pm.payment_token, pm.sequence_id, pm.provider
       FROM billing_events be
       JOIN product_sets ps ON ps.id = be.product_set_id AND ps.status = 'active'
       LEFT JOIN payment_methods pm ON pm.member_id = be.member_id AND pm.gym_id = be.gym_id
      WHERE be.billing_date <= ?
        AND (be.is_scheduled = 1 OR be.event_type = 'failed_billing')
      ORDER BY be.billing_date ASC, be.id ASC`,
    [opts.today],
  );

  for (const event of due) {
    summary.processed += 1;
    let outcome: Outcome = 'skipped';
    let attemptId = 0;
    let orderId = '';
    let amount = Number(event.amount);

    // Phase 1 — decide, and write the attempt row before any provider call.
    const decided = await db.transaction(async (tx): Promise<'go' | 'waived' | 'skip'> => {
      const { rows: locked } = await tx.query<{ is_scheduled: number; event_type: string; amount: string }>(
        'SELECT is_scheduled, event_type, amount FROM billing_events WHERE id = ? FOR UPDATE', [event.id]);
      const ev = locked[0];
      if (!ev || (Number(ev.is_scheduled) !== 1 && ev.event_type !== 'failed_billing')) return 'skip';
      amount = Number(ev.amount);

      const attempts = await loadAttempts(tx, event.id);
      const earlier: EarlierAttempt[] = attempts.map((a: any) => ({
        id: Number(a.id), method: a.method, providerStatus: a.provider_status,
        providerRef: a.provider_ref, status: a.status,
      }));
      const guard = chargeGuard(earlier);
      if (!guard.allowed) {
        log?.warn({ eventId: event.id, reason: guard.reason, attemptIds: guard.attemptIds },
          'scheduled events: charge refused by the guard — needs reconciliation');
        return 'skip';
      }
      if (attempts.some((a: any) => Number(a.today) === 1)) return 'skip'; // one attempt per run day
      const failedDays = new Set(attempts.filter((a: any) => a.method === 'provider').map((a: any) => String(a.attempt_day)));
      if (failedDays.size >= MAX_FAILED_DAYS) return 'skip';

      const nextAttempt = attempts.reduce((m: number, a: any) => Math.max(m, Number(a.attempt)), 0) + 1;
      orderId = `EVT-${String(event.gym_id).slice(0, 8)}-${event.id}-${crypto.randomUUID().slice(0, 8)}`;

      if (amount === 0) {
        const { insertId } = await tx.query(
          `INSERT INTO payment_requests
             (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider,
              provider_order, source, attempt, method, created_at, completed_at)
           VALUES (?, ?, 0, 'EUR', ?, ?, 'completed', 'monei', ?, 'billing_run', ?, 'waive',
                   UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
          [event.gym_id, event.member_id, feeTypeId, event.id, orderId, nextAttempt],
        );
        attemptId = insertId;
        await tx.query(
          `UPDATE billing_events SET is_scheduled = 0, event_type = 'waived_billing' WHERE id = ?`, [event.id]);
        return 'waived';
      }

      if (!event.payment_token || !event.sequence_id) return 'skip'; // nothing attempted; stays scheduled

      const { insertId } = await tx.query(
        `INSERT INTO payment_requests
           (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider,
            provider_order, source, attempt, method, created_at)
         VALUES (?, ?, ?, 'EUR', ?, ?, 'pending', ?, ?, 'billing_run', ?, 'provider', UTC_TIMESTAMP())`,
        [event.gym_id, event.member_id, amount, feeTypeId, event.id, event.provider ?? 'monei', orderId, nextAttempt],
      );
      attemptId = insertId;
      // The event leaves "scheduled" the moment an attempt exists; its status is
      // now its latest attempt's. The type is settled below.
      await tx.query('UPDATE billing_events SET is_scheduled = 0 WHERE id = ?', [event.id]);
      return 'go';
    });

    if (decided === 'skip') { summary.skipped += 1; continue; }
    if (decided === 'waived') { summary.waived += 1; continue; }

    // Phase 2 — the provider, outside any transaction.
    try {
      const result = await getPaymentProvider().executeRecurring({
        orderId,
        amount: toMinorUnits(amount),
        currency: 'EUR',
        paymentToken: event.payment_token as string,
        sequenceId: event.sequence_id as string,
      });
      const rawStatus = normaliseProviderStatus(result.providerStatus ?? (result.success ? 'SUCCEEDED' : 'FAILED'));
      const cls = classifyProviderStatus(rawStatus);
      const settled = result.success === true && cls === 'settled';
      // An in-flight status is neither success nor failure: leave the attempt
      // `pending` for the webhook to settle, and the event unresolved.
      const internal = settled ? 'completed' : cls === 'in_flight' ? 'pending' : 'failed';

      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE payment_requests
              SET status = ?, provider_ref = ?, provider_status = ?, failure_code = ?, failure_message = ?,
                  completed_at = ${internal === 'completed' ? 'UTC_TIMESTAMP()' : 'NULL'}
            WHERE id = ?`,
          [internal, result.providerRef ?? null, rawStatus, result.errorCode ?? null,
            result.errorMessage?.slice(0, 500) ?? null, attemptId],
        );
        if (internal === 'completed') {
          await tx.query(`UPDATE billing_events SET event_type = 'recurring_payment' WHERE id = ?`, [event.id]);
        } else if (internal === 'failed') {
          await tx.query(`UPDATE billing_events SET event_type = 'failed_billing' WHERE id = ?`, [event.id]);
          if (await pauseAfterFailedDays(tx, event)) summary.paused += 1;
        }
      });
      outcome = internal === 'completed' ? 'succeeded' : internal === 'failed' ? 'failed' : 'unknown';
    } catch (err) {
      // The provider threw or never answered: the attempt stays `pending` with no
      // provider status — an unknown outcome, never a definite failure.
      log?.error({ eventId: event.id, err: (err as Error).message }, 'scheduled events: provider error');
      outcome = 'unknown';
    }

    if (outcome === 'succeeded') {
      summary.succeeded += 1;
      try {
        const issued = await db.transaction((tx) => issueReceiptNumber(tx, event.gym_id, event.id));
        summary.receiptsIssued += issued.allocated ? 1 : 0;
      } catch (receiptErr) {
        log?.error({ eventId: event.id, err: (receiptErr as Error).message },
          'scheduled events: receipt number allocation failed (charge stands, issue on demand)');
      }
    } else if (outcome === 'failed' || outcome === 'unknown') {
      summary.failed += 1;
    }
  }
  return summary;
}
