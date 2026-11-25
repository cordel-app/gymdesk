/**
 * #2659 stage 1 (#2125 lifecycle) — the stored statuses of a Membership Plan
 * assignment (`plan_snapshots.status`, and the anchor's `assignment_status`), declared once.
 *
 * `active_cancel_at_period_end` is the persisted form of what
 * `LIFECYCLE_STATUS_SQL` derived as *Cancels on End Date* since #2625: a plan
 * the member cancelled that still entitles them until its last paid day
 * (`ends_at`). Stage 1 adds the value and teaches every reader to give it the
 * answer it gives a `cancelled` row; nothing writes it yet, so no behaviour
 * moves. Stage 2 makes the cancel paths write it, moves the existing rows and
 * transitions it to `cancelled` once `ends_at` has passed.
 *
 * A new status goes in **three** places: `ASSIGNMENT_STATUSES`, the
 * `chk_plan_snapshots_status` CHECK (current definition: migration 485) and the anchor's
 * `chk_plan_snapshots_assignment_status` (migration 485).
 */
export const CANCELS_AT_PERIOD_END_STATUS = 'active_cancel_at_period_end' as const;

/**
 * #3007 stage 2(a): a plan with a cancellation pending, still running exactly like an `active` one
 * until the cancellation is committed. Stage 2(a) adds the value and teaches every reader to give
 * it the answer it gives `active`; nothing writes it yet (the writer is the next stage).
 */
export const PENDING_CANCELLATION_STATUS = 'to_be_canceled' as const;

/**
 * #3114: a plan cancelling at its period end (`active_cancel_at_period_end`) that staff marked for
 * reactivation in the owner's open In Cart. It keeps reading and entitling exactly like the cancelling
 * plan it still is (it is in `CANCELLED_ASSIGNMENT_STATUSES`) until the cart is committed, when it
 * becomes `active`; discarding the cart puts it back.
 */
export const PENDING_REACTIVATION_STATUS = 'to_be_reactivated' as const;

/**
 * #3358: a plan cancelling at its period end that staff marked, in the owner's open In Cart, to be
 * cancelled today (Cancel Immediately). Its End Date is today and its previous one is remembered;
 * it keeps reading and entitling like the cancelling plan it still is until the cart is committed,
 * when it becomes `cancelled`; discarding the cart puts it back.
 */
export const PENDING_IMMEDIATE_CANCELLATION_STATUS = 'to_be_canceled_immediately' as const;

export const ASSIGNMENT_STATUSES = [
  'in_cart', 'pending_payment', 'active', PENDING_CANCELLATION_STATUS, 'paused',
  CANCELS_AT_PERIOD_END_STATUS, PENDING_REACTIVATION_STATUS, PENDING_IMMEDIATE_CANCELLATION_STATUS,
  'cancelled', 'expired', 'superseded',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/**
 * The statuses of a plan that is running: `active`, and `to_be_canceled` (a pending cancellation
 * changes nothing until it is committed). Every reader that asks "is this plan running" asks this
 * set, never `'active'` alone.
 */
export const RUNNING_ASSIGNMENT_STATUSES = ['active', PENDING_CANCELLATION_STATUS] as const;
/** `RUNNING_ASSIGNMENT_STATUSES` as a SQL list body, for `status IN (…)`. */
export const RUNNING_ASSIGNMENT_STATUSES_SQL = RUNNING_ASSIGNMENT_STATUSES.map((s) => `'${s}'`).join(', ');

export function isRunningAssignmentStatus(status: unknown): boolean {
  return (RUNNING_ASSIGNMENT_STATUSES as readonly unknown[]).includes(status);
}

/**
 * The statuses a member's cancellation leaves an assignment in: the one still
 * running to its end date and the finished one. Every reader that asks "was
 * this plan cancelled" asks this set, never `'cancelled'` alone.
 */
export const CANCELLED_ASSIGNMENT_STATUSES = [
  CANCELS_AT_PERIOD_END_STATUS, PENDING_REACTIVATION_STATUS, PENDING_IMMEDIATE_CANCELLATION_STATUS, 'cancelled',
] as const;

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
  return `(${alias}.status IN (${RUNNING_ASSIGNMENT_STATUSES_SQL}) OR (${alias}.status IN ('${CANCELS_AT_PERIOD_END_STATUS}', '${PENDING_REACTIVATION_STATUS}', '${PENDING_IMMEDIATE_CANCELLATION_STATUS}') AND ${alias}.ends_at >= UTC_DATE()))`;
}

/**
 * #2659 stage 2: what the end-of-period sweep moves to `cancelled` — a plan
 * cancelling at its period end whose last entitled day has passed. Idempotent
 * by construction: a moved row no longer matches.
 */
export function cancelAtPeriodEndDueSql(alias = 'um'): string {
  return `${alias}.status = '${CANCELS_AT_PERIOD_END_STATUS}' AND ${alias}.ends_at IS NOT NULL AND ${alias}.ends_at < UTC_DATE()`;
}
