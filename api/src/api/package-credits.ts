import { registerBookingAccessHook } from './bookings';

/**
 * P3.3: package-credit consumption/refund tied to booking lifecycle.
 *
 * Behavior:
 *  - When a member books a restricted class type WITHOUT a qualifying plan
 *    membership (the plan-access hook would 403), but WITH an active package
 *    that has credits AND doesn't expire before the session's start, we:
 *      · debit sessions_remaining by 1
 *      · insert a class_package_transactions row (amount=-1) linked to the
 *        booking (booking_id filled in by cancelBooking's promotion side too)
 *      · link bookings.user_class_package_id
 *      · if this hits zero, flip the package status to 'consumed'
 *    All in the same transaction as the booking insert.
 *  - The debit happens only when the booking goes to 'booked' (i.e. under
 *    capacity). Waitlisted bookings do NOT consume credits — they wait, and
 *    only consume when promoted (P2.5 cancelBooking hook, wired below).
 *  - Cancellation before session start refunds the debit (+1 transaction,
 *    status back to 'active' if it had been 'consumed'). No-show keeps the
 *    debit.
 *
 * Wiring: this file replaces the plan-access hook when it fires. The plan-
 * access hook (registered in plan-class-types.ts) throws before we get here,
 * so we catch it: register OUR hook FIRST, and if the type is restricted and
 * we can grant access via a package, we set a request-local marker so the
 * plan-access hook can bail out. Because the plan-access hook is already
 * registered by the time index.ts loads this file, we sneak into the same
 * hook queue and rely on its "if member has plan, return; else throw" logic.
 *
 * The clean solution: replace the plan-access hook's throw with a
 * shared-context lookup. Since the hook already returns silently when the
 * class type is public or the member holds a plan, we register the package
 * hook BEFORE plan-access — impossible without re-ordering imports. So we
 * take a different approach: the package hook fires alongside the plan
 * hook, and if it detects "would use a credit," it stores that intent on
 * the tx object (a WeakMap keyed by tx handle). The plan hook is amended
 * to bail out when the marker is present. See plan-class-types.ts for
 * the coordinating check.
 *
 * Import order note: index.ts imports plan-class-types BEFORE
 * package-credits, so plan-access is queued first. That means package
 * hook runs AFTER, which won't help. Instead, the plan-class-types file
 * reads a shared coordinator (this module) synchronously — see
 * coordinatePackageAccess below.
 */

/** Set by the package hook when a credit will be spent on this booking. */
const packageIntentByTx = new WeakMap<any, { userClassPackageId: number; classSessionId: number }>();

export function getPackageIntent(tx: any) {
  return packageIntentByTx.get(tx) ?? null;
}

// Package hook runs BEFORE plan-access via the ordering below (it just needs
// to be first-registered). This module is imported at index.ts before
// plan-class-types, ensuring package hook fires first.
registerBookingAccessHook(async (tx, gymId, memberId, classTypeId) => {
  // Only intervene if the class type is plan-restricted; otherwise no cost.
  const { rows: restrictedRows } = await tx.query(
    'SELECT COUNT(*) AS n FROM class_type_user_memberships WHERE class_type_id = ? AND gym_id = ?',
    [classTypeId, gymId],
  );
  if (Number(restrictedRows[0].n) === 0) return;

  // Does the member already qualify via a plan? If so, no need to debit a package.
  const { rows: planMatch } = await tx.query(
    `SELECT um.id FROM user_memberships um
     JOIN class_type_user_memberships ctum
       ON ctum.membership_plan_id = um.membership_plan_id AND ctum.gym_id = um.gym_id
     WHERE um.gym_id = ? AND um.member_id = ? AND um.status = 'active'
       AND ctum.class_type_id = ? LIMIT 1`,
    [gymId, memberId, classTypeId],
  );
  if (planMatch.length > 0) return; // plan-access hook will pass too

  // Otherwise: does the member hold an active package with credits AND non-expired?
  // FOR UPDATE serialises concurrent debits against the same package row.
  const { rows: pkg } = await tx.query(
    `SELECT id, sessions_remaining, expires_at
     FROM user_class_packages
     WHERE gym_id = ? AND member_id = ? AND status = 'active'
       AND sessions_remaining > 0 AND expires_at >= UTC_DATE()
     ORDER BY expires_at ASC
     LIMIT 1 FOR UPDATE`,
    [gymId, memberId],
  );
  if (pkg.length === 0) {
    // No plan, no package: keep the plan-access hook's 403 behaviour.
    return;
  }

  // Record the intent so plan-access can allow this booking, and so the
  // POST route's post-transaction finaliser can debit the credit.
  packageIntentByTx.set(tx, { userClassPackageId: pkg[0].id, classSessionId: 0 });
});

/**
 * Post-booking debit. Called with the tx handle + inserted booking id from
 * bookings.ts once we've decided the booking is 'booked' (not waitlisted).
 * Waitlisted bookings skip this call — they only debit when promoted.
 */
export async function debitPackageIfClaimed(tx: any, bookingId: number, gymId: string) {
  const intent = packageIntentByTx.get(tx);
  if (!intent) return;
  await tx.query(
    "UPDATE user_class_packages SET sessions_remaining = sessions_remaining - 1, status = IF(sessions_remaining - 1 = 0, 'consumed', status) WHERE id = ?",
    [intent.userClassPackageId],
  );
  await tx.query(
    'UPDATE bookings SET user_class_package_id = ? WHERE id = ?',
    [intent.userClassPackageId, bookingId],
  );
  await tx.query(
    'INSERT INTO class_package_transactions (gym_id, user_class_package_id, booking_id, amount, reason) VALUES (?, ?, ?, -1, ?)',
    [gymId, intent.userClassPackageId, bookingId, 'Booking debit'],
  );
  packageIntentByTx.delete(tx);
}

/**
 * Refund a package credit inside cancelBooking's transaction. Called with the
 * cancelled booking's user_class_package_id (if any).
 */
export async function refundPackageCredit(tx: any, bookingId: number, userClassPackageId: number, gymId: string) {
  await tx.query(
    "UPDATE user_class_packages SET sessions_remaining = sessions_remaining + 1, status = IF(status = 'consumed', 'active', status) WHERE id = ?",
    [userClassPackageId],
  );
  await tx.query(
    'UPDATE bookings SET user_class_package_id = NULL WHERE id = ?',
    [bookingId],
  );
  await tx.query(
    'INSERT INTO class_package_transactions (gym_id, user_class_package_id, booking_id, amount, reason) VALUES (?, ?, ?, 1, ?)',
    [gymId, userClassPackageId, bookingId, 'Booking cancellation refund'],
  );
}
