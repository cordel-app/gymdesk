// #1122 §7/§8 — **Past Membership Plans**: which of a Member's own assignments
// belong in the collapsed history card of the Members App, and what each one is
// reported as.
//
// It is pure, so both halves of the feature are assertable with no database and
// no browser (`api/src/test/member-past-plans.unit.test.ts`, in the API suite
// because CI runs `npm test` in `api/` only), and it is deliberately tiny: the
// whole rule is *which row the member's card is already about, and everything
// else*.
//
// Three of its answers are the rule rather than the implementation.
//
//  - **It adds no second "which plan is the member's".** That question is
//    `MEMBER_CURRENT_ASSIGNMENT_ORDER`'s alone (#1123), so the caller runs that
//    one ordering, hands the rows here in it, and the history is the tail. A
//    `WHERE status = 'cancelled'` of its own would be that second rule, and it
//    would describe the same assignment twice the day a member's only plan is
//    cancelled — the card above would name it and the history under it would
//    list it again.
//  - **A Draft is not history either.** The caller appends
//    `MEMBER_CURRENT_ASSIGNMENT_FILTER` beside the ordering (#1108 Q2: a Draft
//    is staff-side configuration that is not the member's plan), so a Draft
//    reaches neither half — which is why the filter is appended to the query
//    rather than applied here.
//  - **A past plan carries no money.** §8 is explicit that the section exists
//    for *historical visibility* and must not show an active plan's actions, so
//    a row is a name, a status and the date it ended. Pricing a finished
//    assignment would mean resolving a fee per row (`resolveMembershipFee()`)
//    for a figure nobody will be charged.

/** How many of a member's assignments the history query reads at most. */
export const MEMBER_PLAN_HISTORY_LIMIT = 50;

/** The columns `toMemberPastPlan()` needs, as the query projects them. */
export interface MemberPlanHistoryRow {
  id: number;
  membership_plan_id: number | null;
  plan_name: string | null;
  status: string;
  starts_at: unknown;
  ends_at: unknown;
  closed_at: unknown;
}

/** One row of the Past Membership Plans card, as `GET /me/membership` reports it. */
export interface MemberPastPlan {
  id: number;
  membership_plan_id: number | null;
  plan_name: string | null;
  status: string;
  starts_at: string | null;
  /**
   * The day it stopped running: the contractual `ends_at` where there is one,
   * else the moment it was closed (`closed_at`, which `POST /:id/close` and
   * `DELETE` stamp). `null` for a row that carries neither, which reads as the
   * status alone rather than as a guessed date.
   */
  ended_on: string | null;
}

/** A DATE or DATETIME column as the bare `YYYY-MM-DD` every member-facing date is. */
function toDateOnly(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return text ? text.slice(0, 10) : null;
}

export function toMemberPastPlan(row: MemberPlanHistoryRow): MemberPastPlan {
  return {
    id: Number(row.id),
    membership_plan_id: row.membership_plan_id == null ? null : Number(row.membership_plan_id),
    plan_name: row.plan_name ?? null,
    status: String(row.status),
    starts_at: toDateOnly(row.starts_at),
    ended_on: toDateOnly(row.ends_at) ?? toDateOnly(row.closed_at),
  };
}

/**
 * Split the member's assignments — already ordered by
 * `MEMBER_CURRENT_ASSIGNMENT_ORDER` — into the one their page is about and the
 * history underneath it.
 *
 * The history is re-ordered **by date, newest first**, which that ordering does
 * not give: it groups by status before date (an `expired` row sorts ahead of a
 * `cancelled` one whatever their dates), which is exactly right for picking the
 * current plan and wrong for reading a history. Ties go to the higher id, the
 * same tiebreak the Admin Member card's own list uses.
 */
export function splitMemberPlanHistory<T extends MemberPlanHistoryRow>(
  rows: readonly T[],
): { current: T | null; past: MemberPastPlan[] } {
  if (rows.length === 0) return { current: null, past: [] };
  const past = rows.slice(1).map(toMemberPastPlan);
  past.sort((a, b) => (b.starts_at ?? '').localeCompare(a.starts_at ?? '') || b.id - a.id);
  return { current: rows[0], past };
}
