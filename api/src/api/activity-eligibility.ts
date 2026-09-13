import { registerBookingAccessHook } from './bookings';

/**
 * #481: Booking-time eligibility gate driven by activity_types.public_event
 * and activity_type_eligible_plans.
 *
 * This is a separate, independent gate from plan-allowances/package-credits:
 * passing eligibility here does not mean the member has an available
 * booking credit (allowance/package) — both gates must pass.
 *
 * Must be registered BEFORE plan-allowances/package-credits (see app.ts) so
 * an ineligible member is rejected before entitlement is even evaluated.
 */
registerBookingAccessHook(async (tx, gymId, memberId, activityTypeId, _centerId, opts) => {
  if (opts?.overrideAccess) return;

  const { rows: atRows } = await tx.query(
    'SELECT public_event FROM activity_types WHERE id = ? AND gym_id = ?',
    [activityTypeId, gymId],
  );
  if (atRows.length === 0 || atRows[0].public_event) return;

  // Resolve the member's active membership plan the same way plan-allowances
  // does — either as the Membership's owner or as a Member covered by a
  // multi-member Membership (#374).
  const { rows: eligible } = await tx.query(
    `SELECT 1 FROM activity_type_eligible_plans atep
     JOIN user_memberships um ON um.membership_plan_id = atep.membership_plan_id AND um.gym_id = atep.gym_id
     WHERE atep.activity_type_id = ? AND atep.gym_id = ? AND um.status = 'active'
       AND (um.member_id = ? OR EXISTS (
         SELECT 1 FROM user_membership_members umm
         WHERE umm.user_membership_id = um.id AND umm.member_id = ?
       ))
     LIMIT 1`,
    [activityTypeId, gymId, memberId, memberId],
  );
  if (eligible.length > 0) return;

  throw Object.assign(
    new Error("This member's membership plan is not eligible to book this activity."),
    { status: 403, code: 'plan_not_eligible' },
  );
});
