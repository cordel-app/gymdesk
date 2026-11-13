/**
 * #2781 — the status of one recurring Product line as the Members App's
 * *My Products* card shows it. It is the line's own state, never the Product
 * Set's status read off as the status of every Product in it:
 *
 * - a line this version **added** while the version is still a Draft or awaiting
 *   its first payment has not been contracted yet, so it reads `draft` /
 *   `pending_payment` — the same answer a Membership Plan no assignment holds yet
 *   gets on that read (#2663);
 * - a line carrying an end date has been removed and runs to its last paid day
 *   (#1914), so it reads `cancels_on_end_date`, the plans' own word (#2659);
 * - a line whose start date is still ahead reads `pending`;
 * - anything else is `active`.
 *
 * Every value is a key of the Members App's existing `membership.status` map,
 * so no new wording is introduced.
 */
export type ProductLineStatus = 'draft' | 'pending_payment' | 'cancels_on_end_date' | 'pending' | 'active';

export function productLineStatus(input: {
  setStatus: string;
  change: 'added' | 'inherited';
  /** The line's end date (YYYY-MM-DD), or null when it has none. */
  endsAt: string | null;
  /** The line's start date (YYYY-MM-DD), or null. */
  startsAt: string | null;
  /** Today's date (YYYY-MM-DD), in the same calendar as the two dates above. */
  today: string;
}): ProductLineStatus {
  if (input.change === 'added' && (input.setStatus === 'draft' || input.setStatus === 'pending_payment')) {
    return input.setStatus;
  }
  if (input.endsAt != null) return 'cancels_on_end_date';
  if (input.startsAt != null && input.startsAt > input.today) return 'pending';
  return 'active';
}
