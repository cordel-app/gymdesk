import { registerBookingAccessHook } from './bookings';

/**
 * P3.3: package-credit consumption/refund tied to booking lifecycle.
 * Now backed by calendar_event_bookings (stage 3 of #360).
 *
 * Behavior unchanged from the old bookings-scoped implementation:
 *  - Debit when a 'booked' insert lands (not waitlisted).
 *  - Waitlisted bookings consume only when promoted.
 *  - Cancellation >= 1 day before session auto-refunds; same-day keeps the debit.
 *
 * class_package_transactions gains a calendar_event_booking_id column
 * (migration 134) that replaces booking_id for new rows.
 */

const packageIntentByTx = new WeakMap<any, { userClassPackageId: number }>();

export function getPackageIntent(tx: any) {
  return packageIntentByTx.get(tx) ?? null;
}

registerBookingAccessHook(async (tx, gymId, memberId, activityTypeId) => {
  const { rows: restrictedRows } = await tx.query(
    'SELECT COUNT(*) AS n FROM plan_allowances WHERE activity_type_id = ? AND gym_id = ?',
    [activityTypeId, gymId],
  );
  if (Number(restrictedRows[0].n) === 0) return;

  const { rows: planMatch } = await tx.query(
    `SELECT um.id FROM user_memberships um
     JOIN plan_allowances pa
       ON pa.membership_plan_id = um.membership_plan_id AND pa.gym_id = um.gym_id
     WHERE um.gym_id = ? AND um.member_id = ? AND um.status = 'active'
       AND pa.activity_type_id = ? LIMIT 1`,
    [gymId, memberId, activityTypeId],
  );
  if (planMatch.length > 0) return;

  const { rows: pkg } = await tx.query(
    `SELECT id, sessions_remaining, expires_at
     FROM user_class_packages
     WHERE gym_id = ? AND member_id = ? AND status = 'active'
       AND sessions_remaining > 0 AND expires_at >= UTC_DATE()
     ORDER BY expires_at ASC
     LIMIT 1 FOR UPDATE`,
    [gymId, memberId],
  );
  if (pkg.length === 0) return;

  packageIntentByTx.set(tx, { userClassPackageId: pkg[0].id });
});

export async function debitPackageIfClaimed(tx: any, bookingId: number, gymId: string) {
  const intent = packageIntentByTx.get(tx);
  if (!intent) return;
  await tx.query(
    "UPDATE user_class_packages SET sessions_remaining = sessions_remaining - 1, status = IF(sessions_remaining - 1 = 0, 'consumed', status) WHERE id = ?",
    [intent.userClassPackageId],
  );
  await tx.query(
    'UPDATE calendar_event_bookings SET user_class_package_id = ? WHERE id = ?',
    [intent.userClassPackageId, bookingId],
  );
  await tx.query(
    'INSERT INTO class_package_transactions (gym_id, user_class_package_id, booking_id, calendar_event_booking_id, amount, reason) VALUES (?, ?, NULL, ?, -1, ?)',
    [gymId, intent.userClassPackageId, bookingId, 'Booking debit'],
  );
  packageIntentByTx.delete(tx);
}

export async function refundPackageCredit(
  tx: any,
  bookingId: number,
  userClassPackageId: number,
  gymId: string,
  reason = 'Booking cancellation refund',
  actorUserId: string | null = null,
) {
  await tx.query(
    "UPDATE user_class_packages SET sessions_remaining = sessions_remaining + 1, status = IF(status = 'consumed', 'active', status) WHERE id = ?",
    [userClassPackageId],
  );
  await tx.query(
    'UPDATE calendar_event_bookings SET user_class_package_id = NULL WHERE id = ?',
    [bookingId],
  );
  await tx.query(
    'INSERT INTO class_package_transactions (gym_id, user_class_package_id, booking_id, calendar_event_booking_id, amount, reason, actor_user_id) VALUES (?, ?, NULL, ?, 1, ?, ?)',
    [gymId, userClassPackageId, bookingId, reason, actorUserId],
  );
}
