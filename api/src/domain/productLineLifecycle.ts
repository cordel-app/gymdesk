/**
 * #3358 stage 2 — the cancellation lifecycle of a recurring Product line, in the vocabulary a
 * Membership Plan uses (`assignmentStatus.ts`): `active`, `to_be_canceled`,
 * `to_be_canceled_immediately`, `active_cancel_at_period_end` and `cancelled`. It replaces
 * #1882's `pending_termination` flag.
 *
 * Nothing here is stored. A line's lifecycle is read from its own end dates: the line the
 * owner's Active (committed) version holds, the copy the owner's open In Cart Draft holds (a
 * Draft writer copies a line before changing it, `ownRecurringLine()`), and — for a committed
 * line that was itself such a copy — the end date of the line it was copied from
 * (`copied_from_periodical_snapshot_id`). So a discarded or expired Draft takes its marks with
 * it, and a failed Save & Pay commits nothing, with no restore step.
 *
 * Dates are `YYYY-MM-DD` strings (compared as strings).
 */

export type ProductLineLifecycle =
  | 'active'
  | 'to_be_canceled'
  | 'to_be_canceled_immediately'
  | 'active_cancel_at_period_end'
  | 'cancelled';

export interface ProductLineDates {
  /** The committed line's end date (`null` = open-ended). */
  committedEndsOn: string | null;
  /**
   * The end date of the line the committed one was copied from, when it is a copy; `null` when it
   * is not a copy or its source was open-ended.
   */
  committedSourceEndsOn: string | null;
  /**
   * The owner's open Draft: `undefined` when there is none; otherwise whether it still carries the
   * line (by `line_ref`) and with which end date.
   */
  draft?: { carries: boolean; endsOn: string | null };
  today: string;
}

export function productLineLifecycle(d: ProductLineDates): ProductLineLifecycle {
  if (d.draft) {
    // A line the Draft no longer carries (a future-start line it deleted) is removed by the commit.
    if (!d.draft.carries) return 'to_be_canceled';
    const draftEnds = d.draft.endsOn;
    if (d.committedEndsOn == null && draftEnds != null) return 'to_be_canceled';
    if (d.committedEndsOn != null && draftEnds != null && draftEnds < d.committedEndsOn) {
      return 'to_be_canceled_immediately';
    }
  }
  if (d.committedEndsOn == null) return 'active';
  // A committed line whose end was brought forward from its source's end date was cancelled
  // immediately: it is no longer entitled, like an immediately cancelled plan.
  if (d.committedSourceEndsOn != null && d.committedEndsOn < d.committedSourceEndsOn
      && d.committedEndsOn <= d.today) {
    return 'cancelled';
  }
  return 'active_cancel_at_period_end';
}

/**
 * Whether Cancel Immediately may be offered for a line: its cancellation is committed and its end
 * date is still ahead (a line ending today has nothing to bring forward).
 */
export function canCancelLineImmediately(status: string, committedEndsOn: string | null, today: string): boolean {
  return status === 'active_cancel_at_period_end' && committedEndsOn != null && committedEndsOn > today;
}
