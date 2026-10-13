// #1538 — which version of the member's Membership Plan the section shows.
//
// Pure: it decides nothing about lifecycle (the server does) and only says which
// of the rows the configuration read returned are drawn. One version at a time:
// as soon as a Draft (or a Pending Payment version) of the plan exists it
// *replaces* the Active snapshot in the view — the snapshot is untouched
// server-side and returns when the Draft is cancelled — and the same version is
// never listed a second time as an "in progress" entry.

import type { MemberPlanRow } from './membershipConfiguration';

const IN_FLIGHT = new Set(['draft', 'pending_payment']);

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
  if (inFlight.length > 0) return { rows: inFlight, heading: 'draft', showInFlightList: false };
  return { rows: live, heading: 'active', showInFlightList: true };
}
