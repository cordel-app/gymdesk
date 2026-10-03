/**
 * #956 — **one member, one Membership Plan.**
 *
 * This module is the one place that decides what "the member already has a
 * plan" means, and what replacing it does to the plan being replaced. The rules
 * are pure so both halves of the enforcement — the 409 a route answers and the
 * supersede a confirmed assignment performs — read them from the same
 * declaration rather than each spelling out a status list and a date.
 *
 * It reverses #634 §6/§14, which allowed "several plans in parallel, but only
 * one of each type" (migration 172). The thread's Q1–Q5 answers are what the
 * constants below encode, and each one is a product decision rather than an
 * implementation detail:
 *
 *   - **Q2: `paused` counts as the one plan.** A paused assignment is live, not
 *     cancelled, and if it did not count then pausing would be a way around the
 *     rule. A future-dated assignment counts too — it is stored `active`, and
 *     `pending` is a derived `lifecycle_status`, never a stored one.
 *   - **Q3: the transition is immediate.** On confirm the current plan becomes
 *     `cancelled` with `closed_at` stamped now and `ends_at` set to the new
 *     plan's `starts_at`, so the history reads as one plan ending where the next
 *     begins whatever date the admin picked. A *scheduled* transition would need
 *     a nightly sweep to flip the status on the day, which this ticket does not
 *     introduce.
 *   - **Q4: a family plan's co-members are covered too.** `user_memberships`
 *     carries one row for the owner and a `user_membership_members` row per
 *     covered member, so the conflict query asks "does any live assignment
 *     *cover* this member", not "does this member own one". The restored UNIQUE
 *     index (migration 213) is keyed on the owner's `member_id` through
 *     `active_member_key`, so it covers only the owner half — the rest is this
 *     module's, enforced under the row lock.
 *
 * What is deliberately *not* here: the index cannot express `paused` (its
 * generated column is NULL unless the row is `active`), so the database
 * guarantees at most one `active` row per owning member and the application
 * guarantees the rest. Two concurrent assignments of a member who already has a
 * live plan serialise on that plan's `FOR UPDATE` lock; two concurrent
 * assignments of a member who has none collide on the index.
 */

/**
 * The statuses that make an assignment *the* member's plan. `cancelled` and
 * `expired` are history and never block a new assignment — a member may hold
 * any number of those.
 */
export const LIVE_ASSIGNMENT_STATUSES = ['active', 'paused'] as const;
export type LiveAssignmentStatus = (typeof LIVE_ASSIGNMENT_STATUSES)[number];

export function isLiveAssignmentStatus(value: unknown): value is LiveAssignmentStatus {
  return typeof value === 'string' && (LIVE_ASSIGNMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * The error code a route answers when the member already holds a live plan and
 * the caller has not confirmed the replacement. A code rather than a sentence
 * because the frontend renders its own confirmation dialog from the payload
 * (#956 stage 2) — the `message` beside it is the fallback for a client that
 * only surfaces text, exactly as `/close`'s `unused_value_impacted` does.
 */
export const ACTIVE_PLAN_EXISTS = 'active_plan_exists';

/** One live assignment standing in the way of a new one. */
export interface LiveAssignment {
  /** `user_memberships.id` — what a replacement supersedes. */
  id: number;
  /** The owning member. Not necessarily the member being assigned (a family plan). */
  owner_member_id: number;
  owner_member_name: string | null;
  /** The member the caller is assigning, whom this assignment already covers. */
  blocked_member_id: number;
  blocked_member_name: string | null;
  membership_plan_id: number | null;
  membership_plan_name: string | null;
  status: LiveAssignmentStatus;
  /** `YYYY-MM-DD`, read as a string from SQL so no DATE crosses a timezone conversion. */
  starts_at: string;
  ends_at: string | null;
}

export interface ActivePlanConflictBody {
  error: typeof ACTIVE_PLAN_EXISTS;
  message: string;
  /** The plan the dialog names as "Current plan" — the first conflict. */
  current_plan: LiveAssignment;
  /** Every live assignment the confirmed call would cancel; one per blocked member. */
  conflicts: LiveAssignment[];
}

/**
 * The 409 body. It carries everything the confirmation dialog needs — both plan
 * names and the current plan's dates — so the frontend renders the warning
 * without a second read of the assignment it is about to replace.
 */
export function activePlanConflictBody(
  conflicts: LiveAssignment[],
  newPlanName: string | null,
): ActivePlanConflictBody {
  const current = conflicts[0];
  const currentName = current.membership_plan_name ?? 'their current Membership Plan';
  const newName = newPlanName ?? 'the new Membership Plan';
  const subject = conflicts.length > 1
    ? `${conflicts.length} of the selected members already have an active Membership Plan`
    : 'This member already has an active Membership Plan';
  return {
    error: ACTIVE_PLAN_EXISTS,
    message:
      `${subject}. Assigning ${newName} will cancel ${currentName}. `
      + 'Resend with confirm: true to proceed.',
    current_plan: current,
    conflicts,
  };
}

/**
 * A replacement may not start *before* the plan it replaces did: the superseded
 * row's `ends_at` is stamped with this date, and an `ends_at` earlier than its
 * own `starts_at` is a history no screen can render sensibly. Equal is fine — a
 * plan replaced on its own start date ran for zero days, which is what a
 * same-day correction means.
 *
 * Returns the message to answer with, or `null` when the date is usable.
 */
export function supersedeStartsAtError(
  newStartsAt: string,
  conflicts: readonly Pick<LiveAssignment, 'starts_at'>[],
): string | null {
  for (const conflict of conflicts) {
    if (newStartsAt < conflict.starts_at) {
      return 'starts_at cannot be earlier than the start date of the Membership Plan it replaces '
        + `(${conflict.starts_at}).`;
    }
  }
  return null;
}
