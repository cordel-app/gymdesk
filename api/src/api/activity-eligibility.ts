import { Tx } from '../infra/db';
import { registerBookingAccessHook } from './bookings';
import { tryClaimPackageCredit } from './package-credits';
import { resolveMemberProfessionalServices } from '../domain/memberProfessionalServices';
import {
  PROFESSIONAL_SERVICE_REQUIRED_CODE,
  RequiredProfessionalService,
  ServiceEligibility,
  decideServiceEligibility,
} from '../domain/activityEligibility';

/**
 * #973 stage 1: booking-time eligibility driven by `activity_types.public_event`
 * and the Professional Services the activity names
 * (`activity_type_eligible_professional_services`, migration 231).
 *
 * Until this ticket the relation was `activity_type_eligible_plans` (#481) —
 * "only members on these Plans may book" — and since #635 stage 4 it was the
 * only plan-based booking gate. There is **no plan-based booking gate at all
 * now**: an activity names the services that may book it, and a member
 * qualifies by holding sessions for one of them, from whichever Product
 * granted them (`domain/memberProfessionalServices.ts`). The rule itself is
 * `decideServiceEligibility()`; this file is the SQL around it and the hook.
 *
 * A `public_event` activity passes unconditionally, as before. A non-public
 * activity that names no service is **open** (the thread's `Q3 open`) — not
 * "blocked for everyone", which is what an empty plan list meant under #481.
 */

async function loadRequiredServices(
  q: Tx,
  gymId: string,
  activityTypeId: number,
): Promise<RequiredProfessionalService[]> {
  // A soft-deleted service drops out of the requirement (it is no longer a
  // thing a member can hold sessions for); one the gym has merely switched
  // off stays in it, so that it keeps blocking rather than silently opening
  // the activity — "a service the gym has switched off must not make a slot
  // eligible" holds in that direction too.
  const { rows } = await q.query<RequiredProfessionalService>(
    `SELECT ps.id, ps.name
     FROM activity_type_eligible_professional_services ateps
     JOIN professional_services ps ON ps.id = ateps.professional_service_id AND ps.deleted_at IS NULL
     WHERE ateps.activity_type_id = ? AND ateps.gym_id = ?
     ORDER BY ps.name ASC`,
    [activityTypeId, gymId],
  );
  return rows;
}

/**
 * The full decision for one (member, activity type) pair. `q` is a `Tx` or
 * the `db` singleton — both expose `query`. The member's balances are read
 * through the same loader `GET /members/:memberId/professional-services`
 * serves, so the number that decides a booking is the number the staff screen
 * shows.
 */
export async function resolveActivityTypeEligibility(
  q: Tx,
  gymId: string,
  memberId: number,
  activityTypeId: number,
): Promise<ServiceEligibility> {
  const { rows: atRows } = await q.query(
    'SELECT public_event FROM activity_types WHERE id = ? AND gym_id = ?',
    [activityTypeId, gymId],
  );
  // An unknown Activity Type passes here for the same reason the hook lets it
  // through: it is not this gate's job to 404, and the booking path fails on
  // the missing row further down.
  if (atRows.length === 0 || atRows[0].public_event) {
    return { eligible: true, required: [], matched: [], packageBacked: false };
  }
  const required = await loadRequiredServices(q, gymId, activityTypeId);
  if (required.length === 0) return decideServiceEligibility(required, []);
  const services = await resolveMemberProfessionalServices(gymId, memberId);
  return decideServiceEligibility(required, services);
}

/**
 * Is this Member allowed to book this Activity Type at all?
 *
 * Exported so a read-only projection can ask the question the booking path
 * answers, without either re-implementing the rule or running the hook for
 * its side effect. #647 stage 2 uses it to drop slots the booking path would
 * reject with 403 from the weekly view.
 */
export async function isActivityTypeEligibleForMember(
  q: Tx,
  gymId: string,
  memberId: number,
  activityTypeId: number,
): Promise<boolean> {
  return (await resolveActivityTypeEligibility(q, gymId, memberId, activityTypeId)).eligible;
}

registerBookingAccessHook(async (tx, gymId, memberId, activityTypeId, _centerId, opts) => {
  if (opts?.overrideAccess) return;
  const decision = await resolveActivityTypeEligibility(tx, gymId, memberId, activityTypeId);

  if (decision.eligible) {
    // A balance a Plan or a Promotion grants charges nothing. One that exists
    // only because of a purchased package still pays for the booking out of
    // that package — today's behaviour, kept until #973 stage 3 moves
    // consumption onto attendance (`Q2`). A claim that fails here is a race
    // with another booking spending the last credit, and is refused as such.
    if (!decision.packageBacked) return;
    if (await tryClaimPackageCredit(tx, gymId, memberId)) return;
  }

  throw Object.assign(
    new Error('This member has no sessions available for the Professional Services this activity requires.'),
    {
      status: 403,
      code: PROFESSIONAL_SERVICE_REQUIRED_CODE,
      // What would unlock the booking, for the surface (#973 stage 4) that
      // routes a member to buy it.
      professional_services: decision.required,
    },
  );
});
