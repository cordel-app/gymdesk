import { Tx } from '../infra/db';
import { registerBookingAccessHook } from './bookings';
import { tryClaimPackageCredit } from './package-credits';

/**
 * #481: Booking-time eligibility gate driven by activity_types.public_event
 * and activity_type_eligible_plans.
 *
 * Since #635 stage 4 (migration 177) this is the *only* plan-based booking
 * gate: Included Services (`plan_allowances`) is gone, and the relation it
 * expressed lives on the Activity Type instead — "only members on these plans
 * may book this activity", editable from the Activity Types page.
 *
 * A member whose plan does not cover the activity is not refused outright if
 * they hold a class package: the gate then claims a package credit
 * (`package-credits.ts`), which the old `plan_allowances` gate did too. Paying
 * per session is the alternative to being on a qualifying plan, so nothing is
 * charged to a package for an activity the member's plan already grants, or for
 * a `public_event` activity that needs no plan at all.
 */

/**
 * Is this Member allowed to book this Activity Type at all?
 *
 * Exported so a read-only projection can ask the question the booking path
 * answers, without either re-implementing the rule or running the hook for
 * its side effect. #647 stage 2 uses it to drop slots the booking path would
 * reject with 403 from the weekly view. `q` is a `Tx` or the `db` singleton —
 * both expose `query`.
 */
export async function isActivityTypeEligibleForMember(
  q: Tx,
  gymId: string,
  memberId: number,
  activityTypeId: number,
): Promise<boolean> {
  const { rows: atRows } = await q.query(
    'SELECT public_event FROM activity_types WHERE id = ? AND gym_id = ?',
    [activityTypeId, gymId],
  );
  // An unknown Activity Type passes here for the same reason the hook lets it
  // through: it is not this gate's job to 404, and the booking path fails on
  // the missing row further down.
  if (atRows.length === 0 || atRows[0].public_event) return true;

  // Resolve the member's active membership plan the same way plan-allowances
  // does — either as the Membership's owner or as a Member covered by a
  // multi-member Membership (#374).
  const { rows: eligible } = await q.query(
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
  return eligible.length > 0;
}

registerBookingAccessHook(async (tx, gymId, memberId, activityTypeId, _centerId, opts) => {
  if (opts?.overrideAccess) return;
  if (await isActivityTypeEligibleForMember(tx, gymId, memberId, activityTypeId)) return;

  // The plan does not cover it — a class package may still pay for it.
  if (await tryClaimPackageCredit(tx, gymId, memberId)) return;

  throw Object.assign(
    new Error("This member's membership plan is not eligible to book this activity."),
    { status: 403, code: 'plan_not_eligible' },
  );
});
