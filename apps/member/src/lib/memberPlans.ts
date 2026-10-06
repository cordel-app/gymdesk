// #1122 §7/§8 — everything the Members App's **Past Membership Plans** card
// decides or formats, and nothing it draws.
//
// The split is `memberPayments.ts`' (#1123) and `memberProducts.ts`' (#1121):
// this module answers which locale **key** a row reads under and how its date is
// written, `components/PastMembershipPlansCard.tsx` is the look, and the page
// resolves the keys — so nothing here calls `t()` and both halves stay
// assertable (`api/src/test/member-past-plans.unit.test.ts`, in the API suite
// because CI runs `npm test` in `api/` only).
//
// Three of its answers are the rule rather than the implementation.
//
//  - **Which plans are past is the server's.** `GET /me/membership` answers the
//    member's current plan and `past_memberships` from one ordering
//    (`MEMBER_CURRENT_ASSIGNMENT_ORDER` plus `splitMemberPlanHistory()`), so the
//    page never filters a list by status for itself — a client-side rule is how
//    a plan comes to be named in the card above *and* listed in the history
//    under it.
//  - **A past plan shows no money and no action** (§8: the section exists for
//    historical visibility and must not carry an active plan's actions), so a
//    row is a name and one muted line. There is no price, no pill and no
//    control to word here.
//  - **A missing date is an absence, never a guess.** A row that carries
//    neither an end date nor a closing stamp reads as its status alone rather
//    than falling back to the day it *started*, which would tell a member their
//    plan ended on the day it began.

import { formatPaymentDate } from './memberPayments';

/** One row of `past_memberships`, as `GET /me/membership` reports it. */
export interface MemberPastPlan {
  id: number;
  membership_plan_id: number | null;
  plan_name: string | null;
  status: string;
  starts_at: string | null;
  /** The day it stopped running: its `ends_at`, else when it was closed. */
  ended_on: string | null;
}

/** The locale key naming what became of a past plan — the `membership.status` map. */
export function pastPlanStatusKey(plan: MemberPastPlan): string {
  return `membership.status.${plan.status}`;
}

/**
 * The name of a past plan. A row whose Membership Plan has since been deleted
 * has no name left to show, and `—` is what every other member-facing surface
 * renders for one.
 */
export function pastPlanName(plan: MemberPastPlan): string {
  return plan.plan_name ?? '—';
}

/**
 * The date under it, formatted in the member's own locale — `null` where the
 * row carries none, which is what makes the line read as the status alone.
 */
export function pastPlanEndedOn(plan: MemberPastPlan, locale: string): string | null {
  return plan.ended_on ? formatPaymentDate(plan.ended_on, locale) : null;
}
