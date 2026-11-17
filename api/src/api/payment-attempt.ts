import { db, type Tx } from '../infra/db';
import { paymentMethodCodeFor } from '../domain/paymentAttemptSnapshot';
import { planAssignmentIdOf } from './plan-assignment-sync';

type Exec = Pick<Tx, 'query'> | typeof db;

async function stamp(tx: Pick<Tx, 'query'>, paymentRequestId: number): Promise<number | null> {
  const { rows } = await tx.query<any>(
    'SELECT gym_id, user_membership_id, billing_event_id, method, source FROM payment_requests WHERE id = ? FOR UPDATE', [paymentRequestId]);
  const pr = rows[0];
  if (!pr) return null;

  // The Billing Event owns the counter; the row lock the UPDATE takes is held until commit.
  let attempt: number | null = null;
  if (pr.billing_event_id != null) {
    await tx.query('UPDATE billing_events SET attempt_count = attempt_count + 1 WHERE id = ?', [pr.billing_event_id]);
    const { rows: c } = await tx.query<{ n: number }>('SELECT attempt_count AS n FROM billing_events WHERE id = ?', [pr.billing_event_id]);
    attempt = Number(c[0]?.n ?? 0) || null;
  }

  // Immutable snapshot of the method's name as the catalogue has it right now.
  const code = paymentMethodCodeFor(pr.method, pr.source);
  let snap: any = null;
  if (code) {
    const { rows: m } = await tx.query<any>(
      `SELECT m.id, m.code,
              COALESCE((SELECT t.name FROM base_payment_method_translations t WHERE t.base_payment_method_id = m.id AND t.locale = 'en'),
                       m.code) AS name
         FROM base_payment_methods m WHERE m.code = ? AND m.deleted_at IS NULL LIMIT 1`, [code]);
    snap = m[0] ?? null;
  }
  // #2125 M6b-34: the re-keyed assignment (migration 431) is written with the attempt.
  const planAssignmentId = await planAssignmentIdOf(tx, pr.gym_id, pr.user_membership_id);
  await tx.query(
    `UPDATE payment_requests
        SET attempt = COALESCE(?, attempt), base_payment_method_id = ?, payment_method_code = ?, payment_method_name = ?,
            plan_assignment_id = ?
      WHERE id = ?`,
    [attempt, snap?.id ?? null, snap ? snap.code : null, snap ? snap.name : null, planAssignmentId, paymentRequestId]);
  return attempt;
}

/**
 * #2451: the one place a freshly inserted Payment Transaction gets its payment
 * method snapshot and its position in the Billing Event's attempt count (and, since
 * #2125 M6b-34, its `plan_assignment_id`). Call it
 * right after every `INSERT INTO payment_requests`, in the same transaction
 * (given the pool it opens its own, so the counter is still atomic).
 */
export async function recordPaymentAttempt(exec: Exec, paymentRequestId: number): Promise<number | null> {
  if ('transaction' in exec) return exec.transaction((tx) => stamp(tx, paymentRequestId));
  return stamp(exec, paymentRequestId);
}
