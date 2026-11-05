import { registerBookingAccessHook } from './bookings';
import { soleActiveCenterId } from '../infra/centerContext';
import {
  centerAllowed, isPlanCenterAccessMode, resolveCenterAccess, type PlanCenterAccessMode,
} from '../domain/planCenterAccess';

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
  // covers the center. #2383: each plan has a center access mode.
  const { rows: memberships } = await tx.query(
    `SELECT DISTINCT um.membership_plan_id, mp.center_access_mode FROM user_memberships um
     JOIN membership_plans mp ON mp.id = um.membership_plan_id
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
  const { rows: centerRows } = await tx.query(
    `SELECT membership_plan_id, center_id FROM membership_plan_centers
      WHERE gym_id = ? AND membership_plan_id IN (${marks})`,
    [gymId, ...planIds],
  );
  const plans = memberships.map((m: { membership_plan_id: number; center_access_mode: string }) => ({
    mode: (isPlanCenterAccessMode(m.center_access_mode) ? m.center_access_mode : 'specific_centers') as PlanCenterAccessMode,
    centerIds: centerRows
      .filter((r: { membership_plan_id: number }) => r.membership_plan_id === m.membership_plan_id)
      .map((r: { center_id: number }) => r.center_id),
  }));

  // The Member's default center (the sole active center implied when they hold
  // none), read only when a plan needs it — never an arbitrary center.
  let defaultCenterId: number | null = null;
  if (plans.some((p: { mode: string }) => p.mode === 'member_default_center')) {
    const { rows: def } = await tx.query(
      `SELECT center_id FROM member_centers
        WHERE gym_id = ? AND member_id = ? AND is_default = 1 AND deleted_at IS NULL LIMIT 1`,
      [gymId, memberId],
    );
    if (def.length > 0) defaultCenterId = def[0].center_id;
    else {
      const { rows: any } = await tx.query(
        'SELECT 1 FROM member_centers WHERE gym_id = ? AND member_id = ? AND deleted_at IS NULL LIMIT 1',
        [gymId, memberId],
      );
      if (any.length === 0) defaultCenterId = await soleActiveCenterId(gymId);
    }
  }

  if (!centerAllowed(resolveCenterAccess(plans, defaultCenterId), centerId)) {
    throw Object.assign(
      new Error('Your membership plan does not cover this center.'),
      { status: 403, code: 'center_not_covered' },
    );
  }
});
