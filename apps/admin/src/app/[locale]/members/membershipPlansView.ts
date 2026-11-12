// #1538 — which version of the member's Membership Plan the section shows.
//
// Pure: it decides nothing about lifecycle (the server does) and only says which
// of the rows the configuration read returned are drawn. One version at a time:
// as soon as a Draft (or a Pending Payment version) of the plan exists it
// *replaces* the Active snapshot in the view — the snapshot is untouched
// server-side and returns when the Draft is cancelled — and the same version is
// never listed a second time as an "in progress" entry.

import type { MemberPlanRow, ProductSetRow } from './membershipConfiguration';

const IN_FLIGHT = new Set(['draft', 'pending_payment']);
/** The stored status of a plan cancelling at its period end (`api/src/domain/assignmentStatus.ts`). */
const CANCELS_AT_PERIOD_END = 'active_cancel_at_period_end';

export const isInFlightPlan = (p: Pick<MemberPlanRow, 'status'>): boolean => IN_FLIGHT.has(p.status);

export interface VisiblePlans {
  /** The rows the first table draws: the in-flight version when there is one, else the live plans. */
  rows: MemberPlanRow[];
  /** `draft` when the rows are the replacement version, `active` otherwise (the heading follows it). */
  heading: 'active' | 'draft';
  /** The separate "in progress" list is redundant while a plan row is the in-flight version. */
  showInFlightList: boolean;
}

export function visiblePlans(plans: readonly MemberPlanRow[]): VisiblePlans {
  const live = plans.filter((p) => p.is_live);
  const inFlight = live.filter(isInFlightPlan);
  // #2659 stage 3: a plan cancelling at its period end is carried by the Draft (for entitlement
  // only — never billed), so it stays listed beside the in-flight version until its end date.
  // An Active plan is still replaced in the view by the Draft, as #1538 decides.
  const cancelling = plans.filter((p) => p.status === CANCELS_AT_PERIOD_END && p.is_current && !isInFlightPlan(p));
  // #2742: a version awaiting its first payment is listed in the Active category (its own
  // `Pending Payment` badge tells it apart); only a Draft takes the view out of it.
  if (inFlight.length > 0) {
    const heading = inFlight.some((p) => p.status === 'draft') ? 'draft' : 'active';
    return { rows: [...inFlight, ...cancelling], heading, showInFlightList: false };
  }
  // #2549: a cancelled plan stays in Active until its end date passes (status badge unchanged).
  return { rows: plans.filter((p) => p.is_live || p.is_current), heading: 'active', showInFlightList: true };
}

/**
 * #1538 stage 3 — whether `⋮ → Edit` is offered on a plan row. Only the Member's
 * own, running plan can start a replacement Draft: a Draft or a Pending Payment
 * version is already the in-flight version (it is configured in place), a plan
 * covered through someone else's Membership is read-only (#1191) and a plan with
 * no Membership Plan has nothing to re-freeze.
 */
export function canEditLivePlan(
  p: Pick<MemberPlanRow, 'status' | 'is_live' | 'assignment_relationship' | 'membership_plan_id'>,
): boolean {
  return p.is_live && !isInFlightPlan(p) && p.assignment_relationship !== 'linked' && p.membership_plan_id != null;
}

/**
 * #2742 — the Membership Plans awaiting their first payment that no assignment row
 * represents yet: a plan a member chose in the Members App is a ProductSet version in
 * `pending_payment`, and its assignment is projected only when the payment activates it.
 * The Member card lists these in the Active category, labelled `Pending Payment`, from the
 * version's own stored status — nothing here changes or infers a lifecycle. A version
 * linked to an assignment (an Admin Save & Pay) is already one of the plan rows, so it is
 * never listed twice; a version with no plan has no Membership Plan to show.
 */
export function pendingPaymentPlanSets(productSets: readonly ProductSetRow[]): ProductSetRow[] {
  return productSets.filter((ps) => ps.status === 'pending_payment'
    && ps.user_membership_id == null
    && ps.membership_plan_id != null);
}
