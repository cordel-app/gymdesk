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
