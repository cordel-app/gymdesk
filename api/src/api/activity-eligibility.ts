import { Tx } from '../infra/db';
import { registerBookingAccessHook } from './bookings';
import { MemberProfessionalService, resolveMemberProfessionalServices } from '../domain/memberProfessionalServices';
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
 * Since #980 stage 3 an occurrence may carry a list of its own
 * (`calendar_event_eligible_professional_services`, migration 232), which
 * wins over the Activity Type's when `calendar_events.eligible_services_override`
 * is set; the booking hook is handed the occurrence for that reason.
 */

const ACTIVITY_REQUIRED_SQL = `
  SELECT ps.id, ps.name
  FROM activity_type_eligible_professional_services ateps
  JOIN professional_services ps ON ps.id = ateps.professional_service_id AND ps.deleted_at IS NULL
  WHERE ateps.activity_type_id = ? AND ateps.gym_id = ?
  ORDER BY ps.name ASC
`;

const OCCURRENCE_REQUIRED_SQL = `
  SELECT ps.id, ps.name
  FROM calendar_event_eligible_professional_services ceeps
  JOIN professional_services ps ON ps.id = ceeps.professional_service_id AND ps.deleted_at IS NULL
  WHERE ceeps.calendar_event_id = ? AND ceeps.gym_id = ?
  ORDER BY ps.name ASC
`;

/**
 * The services the booking must be judged against. #980 stage 3: an
 * occurrence with `eligible_services_override = 1` has a list of its own
 * (migration 232), possibly empty — "any member may book this event" —
 * and one without follows its Activity Type's, exactly as a NULL
 * `waitlist_mode` follows the Activity Type's setting.
 *
 * A soft-deleted service drops out of either list (it is no longer a thing a
 * member can hold sessions for); one the gym has merely switched off stays
 * in it, so that it keeps blocking rather than silently opening the
 * activity — "a service the gym has switched off must not make a slot
 * eligible" holds in that direction too.
 */
export async function loadRequiredServices(
  q: Tx,
  gymId: string,
  activityTypeId: number,
  calendarEventId?: number,
): Promise<RequiredProfessionalService[]> {
  if (calendarEventId != null) {
    const { rows: ceRows } = await q.query(
      'SELECT eligible_services_override FROM calendar_events WHERE id = ? AND gym_id = ?',
      [calendarEventId, gymId],
    );
    if (ceRows[0]?.eligible_services_override) {
      const { rows } = await q.query<RequiredProfessionalService>(OCCURRENCE_REQUIRED_SQL, [calendarEventId, gymId]);
      return rows;
    }
  }
  const { rows } = await q.query<RequiredProfessionalService>(ACTIVITY_REQUIRED_SQL, [activityTypeId, gymId]);
  return rows;
}

export interface EligibilityOptions {
  /** The occurrence being booked or projected — its own list wins when it has one. */
  calendarEventId?: number;
  /** The member's balances, when the caller already holds them (one load for a whole projection). */
  memberServices?: MemberProfessionalService[];
}

/**
 * The full decision for one (member, activity type[, occurrence]) triple.
 * `q` is a `Tx` or the `db` singleton — both expose `query`. The member's
 * balances are read through the same loader
 * `GET /members/:memberId/professional-services` serves, so the number that
 * decides a booking is the number the staff screen shows.
 */
export async function resolveActivityTypeEligibility(
  q: Tx,
  gymId: string,
  memberId: number,
  activityTypeId: number,
  opts: EligibilityOptions = {},
): Promise<ServiceEligibility> {
  const { rows: atRows } = await q.query(
    'SELECT public_event FROM activity_types WHERE id = ? AND gym_id = ?',
    [activityTypeId, gymId],
  );
  // An unknown Activity Type passes here for the same reason the hook lets it
  // through: it is not this gate's job to 404, and the booking path fails on
  // the missing row further down.
  if (atRows.length === 0 || atRows[0].public_event) {
    return { eligible: true, required: [], matched: [] };
  }
  const required = await loadRequiredServices(q, gymId, activityTypeId, opts.calendarEventId);
  if (required.length === 0) return decideServiceEligibility(required, []);
  const services = opts.memberServices ?? await resolveMemberProfessionalServices(gymId, memberId);
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
  opts: EligibilityOptions = {},
): Promise<boolean> {
  return (await resolveActivityTypeEligibility(q, gymId, memberId, activityTypeId, opts)).eligible;
}

registerBookingAccessHook(async (tx, gymId, memberId, activityTypeId, _centerId, opts) => {
  if (opts?.overrideAccess) return;
  const decision = await resolveActivityTypeEligibility(tx, gymId, memberId, activityTypeId, { calendarEventId: opts?.calendarEventId });

  // Booking spends nothing (#973 `Q2`): a session is spent on attendance, a
  // late cancellation or a no-show, by the consumption ledger (#1189 stage 3).
  if (decision.eligible) return;

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
