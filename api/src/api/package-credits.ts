/**
 * P3.3: package-credit consumption/refund tied to booking lifecycle.
 * Now backed by calendar_event_bookings (stage 3 of #360).
 *
 * Since #1189 stage 3 a booking no longer debits a package: sessions are spent
 * by the consumption ledger (`service-consumption.ts`) on attendance, late
 * cancellation or no-show. What is left here is the refund of a credit that a
 * pre-stage-3 booking was debited at booking time (`user_class_package_id`).
 *
 * class_package_transactions gains a calendar_event_booking_id column
 * (migration 134) that replaces booking_id for new rows.
 */

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
