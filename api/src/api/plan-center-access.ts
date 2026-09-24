import { registerBookingAccessHook } from './bookings';

/**
 * Booking-time center validation: if the member's active Membership Plan has
 * `membership_plan_centers` rows, the booking's center must be one of them.
 *
 * Lived in `plan-allowances.ts` until #635 stage 4 retired Included Services
 * (migration 177). It was never part of that concept — a plan's centers are
 * where it may be used, not what it includes — so the check moved here
 * unchanged rather than disappearing with `plan_allowances`.
 */
registerBookingAccessHook(async (tx, gymId, memberId, _activityTypeId, centerId, opts) => {
  if (!centerId) return;
  // #481: staff override bypasses center coverage the same way `force` already
  // bypasses the capacity check.
  if (opts?.overrideAccess) return;

  // Resolve the member's active membership plan — either as the Membership's
  // owner or as a Member covered by a multi-member Membership (#374).
  const { rows: memberships } = await tx.query(
    `SELECT um.membership_plan_id FROM user_memberships um
     WHERE um.gym_id = ? AND um.status = 'active'
       AND (um.member_id = ? OR EXISTS (
         SELECT 1 FROM user_membership_members umm
         WHERE umm.user_membership_id = um.id AND umm.member_id = ?
       ))
     LIMIT 1`,
    [gymId, memberId, memberId],
  );
  if (memberships.length === 0) return; // No membership — other guards handle

  const planId = memberships[0].membership_plan_id;

  const { rows: planCenters } = await tx.query(
    'SELECT COUNT(*) AS n FROM membership_plan_centers WHERE membership_plan_id = ? AND gym_id = ?',
    [planId, gymId],
  );
  if (Number(planCenters[0].n) === 0) return; // Plan covers every center

  const { rows: allowed } = await tx.query(
    'SELECT 1 FROM membership_plan_centers WHERE membership_plan_id = ? AND center_id = ? AND gym_id = ?',
    [planId, centerId, gymId],
  );
  if (allowed.length === 0) {
    throw Object.assign(
      new Error('Your membership plan does not cover this center.'),
      { status: 403, code: 'center_not_covered' },
    );
  }
});
