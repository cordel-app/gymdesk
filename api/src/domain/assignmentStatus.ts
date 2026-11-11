/**
 * #2659 stage 1 (#2125 lifecycle) — the stored statuses of a Membership Plan
 * assignment (`user_memberships.status`), declared once.
 *
 * `active_cancel_at_period_end` is the persisted form of what
 * `LIFECYCLE_STATUS_SQL` derived as *Cancels on End Date* since #2625: a plan
 * the member cancelled that still entitles them until its last paid day
 * (`ends_at`). Stage 1 adds the value and teaches every reader to give it the
 * answer it gives a `cancelled` row; nothing writes it yet, so no behaviour
 * moves. Stage 2 makes the cancel paths write it, moves the existing rows and
 * transitions it to `cancelled` once `ends_at` has passed.
 *
 * A new status goes in **two** places: `ASSIGNMENT_STATUSES` and the
 * `user_memberships_status_check` CHECK (current definition: migration 395).
 */
export const CANCELS_AT_PERIOD_END_STATUS = 'active_cancel_at_period_end' as const;

export const ASSIGNMENT_STATUSES = [
  'draft', 'pending_payment', 'active', 'paused',
  CANCELS_AT_PERIOD_END_STATUS, 'cancelled', 'expired', 'superseded',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/**
 * The statuses a member's cancellation leaves an assignment in: the one still
 * running to its end date and the finished one. Every reader that asks "was
 * this plan cancelled" asks this set, never `'cancelled'` alone.
 */
export const CANCELLED_ASSIGNMENT_STATUSES = [CANCELS_AT_PERIOD_END_STATUS, 'cancelled'] as const;

/** `CANCELLED_ASSIGNMENT_STATUSES` as a SQL list body, for `status IN (…)`. */
export const CANCELLED_ASSIGNMENT_STATUSES_SQL = CANCELLED_ASSIGNMENT_STATUSES.map((s) => `'${s}'`).join(', ');

export function isCancelledAssignmentStatus(status: unknown): boolean {
  return (CANCELLED_ASSIGNMENT_STATUSES as readonly unknown[]).includes(status);
}

/**
 * #2659 stage 2: the status a member's cancellation writes. A plan whose last
 * paid day (`ends_at`, #1196's `cancellationEndDate()`) is today or later keeps
 * running to it as `active_cancel_at_period_end`; one with nothing left to run
 * is `cancelled` at once. Dates are `YYYY-MM-DD` (UTC), compared as strings.
 */
export function cancellationStatusFor(endsAt: string | null, today: string): 'active_cancel_at_period_end' | 'cancelled' {
  return endsAt != null && endsAt >= today ? CANCELS_AT_PERIOD_END_STATUS : 'cancelled';
}

/**
 * #2659 stage 2: "this assignment entitles its beneficiaries today" for the
 * access readers (center access, class-type access, the access-locked flag): an
 * `active` plan, or one that cancels at its period end and has not reached it.
 * The day-granular check keeps the answer right between `ends_at` passing and
 * the nightly sweep moving the row to `cancelled`.
 */
export function entitledAssignmentSql(alias = 'um'): string {
  return `(${alias}.status = 'active' OR (${alias}.status = '${CANCELS_AT_PERIOD_END_STATUS}' AND ${alias}.ends_at >= UTC_DATE()))`;
}

/**
 * #2659 stage 2: what the end-of-period sweep moves to `cancelled` — a plan
 * cancelling at its period end whose last entitled day has passed. Idempotent
 * by construction: a moved row no longer matches.
 */
export function cancelAtPeriodEndDueSql(alias = 'um'): string {
  return `${alias}.status = '${CANCELS_AT_PERIOD_END_STATUS}' AND ${alias}.ends_at IS NOT NULL AND ${alias}.ends_at < UTC_DATE()`;
}
