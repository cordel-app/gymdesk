/**
 * #3281 stage 2: the Member's Membership Plan Status (`enrollment_status`, derived by the API's
 * `latestEnrollmentStatusSql()`) is the **exact** status of the plan it was derived from, so it is
 * worded by the very key the plan's own row uses — the `status` namespace — and never by a
 * Member-level label of its own. That label set (`members.enrollment_status_*`) is what turned a
 * plan reading *To Be Canceled* on the Products tab into *Active (cancellation pending)* in the
 * header; it is gone.
 *
 * The Members list filter offers every value the column can show, in #3113's priority order.
 */
export const MEMBER_PLAN_STATUS_FILTER_VALUES = [
  'active',
  'to_be_canceled',
  'paused',
  'active_cancel_at_period_end',
  'to_be_reactivated',
  'cancelled',
  'expired',
  'superseded',
] as const;

/** The locale key a Member's Plan Status reads under — the plan row's own (`status.<value>`). */
export function memberPlanStatusLabelKey(status: string): string {
  return `status.${status}`;
}
