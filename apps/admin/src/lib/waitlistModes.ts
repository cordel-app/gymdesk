/**
 * #980 stage 2 — the browser mirror of `api/src/domain/waitlistMode.ts`.
 *
 * Two screens offer this vocabulary now: the Activity Type form (its default)
 * and the calendar event's own detail panel (that occurrence's override), so
 * the list is declared once here rather than a third and fourth time in the
 * JSX. A new mode goes in **three** places — the domain module, this mirror,
 * and the `chk_ce_waitlist_mode` / `chk_at_waitlist_mode` CHECKs beside the
 * two columns (migration 154).
 *
 * The labels are not here: each page resolves `waitlist_mode_<value>` in its
 * own namespace, because `activity_types` and `calendar` word the same stored
 * value for two different readers.
 */

export const WAITLIST_MODES = ['disabled', 'open', 'closed'] as const;
export type WaitlistMode = (typeof WAITLIST_MODES)[number];

/**
 * Does choosing this mode empty the occurrence's waiting list?
 *
 * The mirror of the server's `waitlistModeClosesQueue()`, and what the panel
 * asks to decide whether Save needs a confirmation first (§3). `closed` does
 * not: it stops new joins and leaves everybody's place exactly where it is.
 */
export function waitlistModeClosesQueue(mode: WaitlistMode | null | undefined): boolean {
  return mode === 'disabled';
}
