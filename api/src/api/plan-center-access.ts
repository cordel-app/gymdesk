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

  // Resolve the member's active membership plans — either as the Membership's
  // owner or as a Member covered by a multi-member Membership (#374). #2125: a
  // member may hold several, and the booking is allowed when *any* of them
  // covers the center.
  const { rows: memberships } = await tx.query(
    `SELECT DISTINCT um.membership_plan_id FROM user_memberships um
     WHERE um.gym_id = ? AND um.status = 'active'
       AND (um.member_id = ? OR EXISTS (
         SELECT 1 FROM user_membership_members umm
         WHERE umm.user_membership_id = um.id AND umm.member_id = ?
       ))`,
    [gymId, memberId, memberId],
  );
  if (memberships.length === 0) return; // No membership — other guards handle

  const planIds = memberships.map((m: { membership_plan_id: number }) => m.membership_plan_id);
  const marks = planIds.map(() => '?').join(',');

  const { rows: restricted } = await tx.query(
    `SELECT DISTINCT membership_plan_id FROM membership_plan_centers
      WHERE gym_id = ? AND membership_plan_id IN (${marks})`,
    [gymId, ...planIds],
  );
  // A plan with no center rows covers every center.
  if (restricted.length < planIds.length) return;

  const { rows: allowed } = await tx.query(
    `SELECT 1 FROM membership_plan_centers
      WHERE gym_id = ? AND center_id = ? AND membership_plan_id IN (${marks}) LIMIT 1`,
    [gymId, centerId, ...planIds],
  );
  if (allowed.length === 0) {
    throw Object.assign(
      new Error('Your membership plan does not cover this center.'),
      { status: 403, code: 'center_not_covered' },
    );
  }
});
