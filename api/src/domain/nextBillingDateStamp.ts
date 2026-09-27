import type { Tx } from '../infra/db';
import { ASSIGNMENT_CADENCE } from '../api/assigned-plan-snapshot';
import { firstBillingDateAfter, type BillingDateUnit } from './billingDate';

/**
 * #790 — the two writers that put an assignment back on the nightly run's
 * schedule, and the one rule both follow: **the date they stamp is never today
 * or earlier**. It is the first cycle boundary strictly after UTC today
 * (`firstBillingDateAfter()`), so the run's `next_billing_date <= UTC_DATE()`
 * never picks up a cycle that elapsed before the member paid or while the
 * assignment was paused. Those cycles are written off: no charge, no
 * `adjustment` row (decisions recorded in `docs/payments.md`, A5).
 *
 * Both read the row `FOR UPDATE` in the caller's transaction, the cadence
 * through `ASSIGNMENT_CADENCE` (the assignment's own, then its Plan's live
 * `billing_policies` row — hence the LEFT JOIN), and every date as a
 * `YYYY-MM-DD` string from SQL, today included, so nothing crosses a timezone
 * conversion.
 */

interface ScheduleRow {
  starts_at: string;
  next_billing_date: string | null;
  today: string;
  cadence_interval: number | null;
  cadence_unit: BillingDateUnit | null;
}

async function lockScheduleRow(tx: Tx, userMembershipId: number, gymId: string): Promise<ScheduleRow | null> {
  const { rows } = await tx.query<ScheduleRow>(
    `SELECT DATE_FORMAT(um.starts_at, '%Y-%m-%d')         AS starts_at,
            DATE_FORMAT(um.next_billing_date, '%Y-%m-%d') AS next_billing_date,
            DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')           AS today,
            ${ASSIGNMENT_CADENCE.interval()}              AS cadence_interval,
            ${ASSIGNMENT_CADENCE.unit()}                  AS cadence_unit
     FROM user_memberships um
     LEFT JOIN billing_policies bp ON bp.membership_plan_id = um.membership_plan_id
     WHERE um.id = ? AND um.gym_id = ?
     FOR UPDATE`,
    [userMembershipId, gymId],
  );
  return rows[0] ?? null;
}

function cadenceOf(row: ScheduleRow): { interval: number; unit: BillingDateUnit } | null {
  const interval = Number(row.cadence_interval);
  if (row.cadence_unit == null || !Number.isInteger(interval) || interval < 1) return null;
  return { interval, unit: row.cadence_unit };
}

/**
 * The first completed payment of an assignment (the payment webhook): stamps
 * `next_billing_date` only when it is still NULL, as the first boundary of the
 * `starts_at`-anchored schedule strictly after today. An assignment starting
 * today or later gets `starts_at + 1 cadence`, exactly as before; a back-dated
 * one skips the elapsed cycles instead of being charged one per night for them
 * (the last of which was the cycle this payment was itself priced on).
 *
 * Returns the stamped date, or null when nothing was written (already set, or
 * no cadence to bill on).
 */
export async function stampFirstNextBillingDate(
  tx: Tx, userMembershipId: number, gymId: string,
): Promise<string | null> {
  const row = await lockScheduleRow(tx, userMembershipId, gymId);
  if (!row || row.next_billing_date != null) return null;
  const cadence = cadenceOf(row);
  if (!cadence) return null;
  const next = firstBillingDateAfter(row.starts_at, cadence.interval, cadence.unit, row.today);
  await tx.query(
    'UPDATE user_memberships SET next_billing_date = ? WHERE id = ? AND gym_id = ? AND next_billing_date IS NULL',
    [next, userMembershipId, gymId],
  );
  return next;
}

/**
 * A transition back to `active` (Reactivate, or a status flip through
 * `PUT /user-memberships/:id`): a pause is not a debt, so a `next_billing_date`
 * that went by while the assignment was off the run is walked forward, along
 * its own schedule, to the first boundary strictly after today. A date still in
 * the future is left alone, and so is a NULL one — an assignment that never
 * paid has no schedule yet, and its first payment stamps one.
 *
 * Call it inside the transaction that flips the status, beside #785's dunning
 * reset: both say "bill this again from here".
 */
export async function rollStaleNextBillingDateForward(
  tx: Tx, userMembershipId: number, gymId: string,
): Promise<string | null> {
  const row = await lockScheduleRow(tx, userMembershipId, gymId);
  if (!row || row.next_billing_date == null || row.next_billing_date > row.today) return null;
  const cadence = cadenceOf(row);
  if (!cadence) return null;
  const next = firstBillingDateAfter(row.next_billing_date, cadence.interval, cadence.unit, row.today);
  await tx.query(
    'UPDATE user_memberships SET next_billing_date = ? WHERE id = ? AND gym_id = ?',
    [next, userMembershipId, gymId],
  );
  return next;
}
