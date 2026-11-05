import { db } from '../infra/db';
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

/**
 * #2381: the centers a Member may pick as their Default Center — the same
 * coverage the booking hook above enforces, read for a form. A Member with no
 * active plan, or with a plan that lists no centers (covers every center), may
 * pick any active center of the gym; otherwise the union of the plans' centers.
 */
export async function centersAvailableToMember(
  gymId: string,
  memberId: string | number,
): Promise<{ id: number; name: string }[]> {
  const { rows: memberships } = await db.query<{ membership_plan_id: number }>(
    `SELECT DISTINCT um.membership_plan_id FROM user_memberships um
     WHERE um.gym_id = ? AND um.status = 'active'
       AND (um.member_id = ? OR EXISTS (
         SELECT 1 FROM user_membership_members umm
         WHERE umm.user_membership_id = um.id AND umm.member_id = ?
       ))`,
    [gymId, memberId, memberId],
  );
  const planIds = memberships.map((m) => m.membership_plan_id);
  if (planIds.length > 0) {
    const marks = planIds.map(() => '?').join(',');
    const { rows: restricted } = await db.query(
      `SELECT DISTINCT membership_plan_id FROM membership_plan_centers
        WHERE gym_id = ? AND membership_plan_id IN (${marks})`,
      [gymId, ...planIds],
    );
    if (restricted.length === planIds.length) {
      const { rows } = await db.query<{ id: number; name: string }>(
        `SELECT DISTINCT c.id, c.name FROM centers c
          JOIN membership_plan_centers mpc ON mpc.center_id = c.id AND mpc.gym_id = c.gym_id
         WHERE c.gym_id = ? AND c.deleted_at IS NULL AND c.status = 'active'
           AND mpc.membership_plan_id IN (${marks})
         ORDER BY c.name`,
        [gymId, ...planIds],
      );
      return rows;
    }
  }
  const { rows } = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM centers WHERE gym_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY name`,
    [gymId],
  );
  return rows;
}
