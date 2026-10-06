// #1123 — the member-facing **Billing Event Forecast**: what `GET
// /me/billing-event-forecast` answers, and the one place that says which
// `user_memberships` row is "the member's current plan".
//
// There is deliberately almost nothing here, for #924 stage 4's reason one app
// over: the projection an assignment's forecast needs already exists in one
// place (`assignedPlanBillingForecast()` over `loadSimulationAssignments()`),
// and every snapshot rule — the frozen fee and cadence (#635 §13–§17), each
// application's own grant snapshot (§16), the Additional Periodic Services, the
// Personal Membership Fee Benefit (#772) — is applied inside it. So the member's
// forecast is the *same* projection the staff see on the Assigned Plan card,
// scoped to the caller:
//
//     GET /user-memberships/:id/billing-event-simulation  ─┐
//                                                          ├─▶ assignedPlanBillingForecast()
//     GET /me/billing-event-forecast                      ─┘
//
// which is what makes #1123 §3's "the final total must correspond to the Billing
// Event amount that will actually be charged" true by construction rather than
// by a second arithmetic: a member and the nightly run cannot disagree, because
// neither reads anything the other does not.
//
// Two consequences of that choice are the rule rather than the implementation.
//
//  - **The member is never named by a request.** The route resolves the caller
//    through `resolveMemberId()` and this module takes a `memberId` it was
//    handed, so another member's forecast is unreachable whatever a payload says
//    (#1036's rule for My Goals, which this follows).
//  - **The horizon is the engine's.** `SIMULATED_CYCLES = 2` per recurring
//    stream, counted from today (#924 stage 4's `horizonFrom`), which is exactly
//    the answer the thread asked for ("2 complete cycles, same as membership
//    plans or assigned membership plans"). Nothing here bounds, extends or
//    re-counts it, so a change to the shared horizon reaches the staff card and
//    the member's page in the same commit.

import { db } from '../infra/db';
import type { AssignmentBillingEventSimulationResult } from '../domain/assignmentBillingEventSimulation';
import { emptyBillingEventSimulation } from '../domain/billingEventSimulation';
import { assignedPlanBillingForecast } from './assigned-plan-billing-forecast';

/**
 * Which of a Member's `user_memberships` rows is *the* one their own pages are
 * about, as an `ORDER BY` fragment for a query already scoped to
 * `um.gym_id = ? AND um.member_id = ?` and taking `LIMIT 1`.
 *
 * It exists as a constant because two routes need the same answer — `GET
 * /me/membership` (which has reported this row since P1.8) and the forecast
 * below — and a second spelling of the ordering is how the two would come to
 * describe different assignments on one screen: the card would name the Premium
 * plan while the forecast underneath projected a cancelled one.
 *
 * A live row wins (`active`, then `paused`); only a member with no live
 * assignment at all falls through to their most recent historical one, which is
 * what lets My Membership keep showing a cancelled plan rather than an empty
 * page. Ties go to the latest `starts_at`.
 */
export const MEMBER_CURRENT_ASSIGNMENT_ORDER = `
  ORDER BY
    FIELD(um.status, 'active','paused','expired','cancelled'),
    um.starts_at DESC`;

/**
 * The `WHERE` half of that same answer: a **Draft is never the member's plan**
 * (#1108 Q2). A Draft is staff-side configuration of a purchase that has not
 * been committed — it is not active, it is not bookable, and it bills nothing —
 * so neither My Membership nor the Payments card may describe one.
 *
 * It is a separate constant only because an `ORDER BY` fragment cannot carry a
 * predicate; it is the same one place, and both callers append both. Leaving it
 * out would be worse than showing a Draft: `FIELD()` answers 0 for a value it
 * does not list, which sorts *first*, so a member holding an Active plan and a
 * Draft replacement would have had the Draft described to them as their
 * membership.
 */
export const MEMBER_CURRENT_ASSIGNMENT_FILTER = "AND um.status <> 'draft'";

/**
 * Why a member has no forecast. A member with no plan at all, and one whose
 * only plan is `cancelled`/`expired`, both read as "nothing further is
 * scheduled" — a `cancelled` assignment bills nothing, so
 * `loadSimulationAssignments()` returns no row for it and
 * `assignedPlanBillingForecast()` already says so in its own words.
 *
 * The string is the API's fallback and not what the member reads: the page
 * renders its own locale key for `available: false`, exactly as the Assigned
 * Plan card does, because a sentence a member reads is the Members App's
 * (#1072's rule for a push payload, the same reason).
 */
const NO_ASSIGNMENT_REASON = 'This member holds no membership plan, so there is nothing to forecast.';

/**
 * The Billing Event Forecast of the member's current plan.
 *
 * It always answers a projection: a member with no assignment reads as
 * `available: false` rather than a 404, so the Payments card renders its empty
 * state instead of treating a legitimate state as an error (the shape
 * `GET /me/membership`'s `{ membership: null }` already established).
 */
export async function memberBillingEventForecast(
  gymId: string, memberId: number,
): Promise<AssignmentBillingEventSimulationResult> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT um.id
       FROM user_memberships um
      WHERE um.gym_id = ? AND um.member_id = ?
      ${MEMBER_CURRENT_ASSIGNMENT_FILTER}
      ${MEMBER_CURRENT_ASSIGNMENT_ORDER}
      LIMIT 1`,
    [gymId, memberId],
  );
  if (!rows[0]) return emptyBillingEventSimulation(NO_ASSIGNMENT_REASON);
  return assignedPlanBillingForecast(gymId, rows[0].id);
}
