/**
 * #980 stage 2 — an occurrence's Waitlist setting, and what each value means.
 *
 * `calendar_events.waitlist_mode` (migration 154, #503 stage 2) is **three**
 * states and nullable, which is one more question than the ticket's mock asks
 * (§3 words it as Enabled / Disabled). The thread settled it the other way —
 * *"Set the status: Open, Disabled or Closed"* — so the column as it stands is
 * the vocabulary, and this module is the one place that decides it:
 *
 *   - `open`     new members may join the queue;
 *   - `closed`   nobody new may join, and **the queue stays exactly as it is**;
 *   - `disabled` there is no queue at all, so writing it empties the one there
 *     was (§5) and alerts everybody it removed (§4);
 *   - `NULL`     the occurrence has no setting of its own and follows its
 *     Activity Type's, which is what every event written before this ticket
 *     means and what a newly created occurrence still means.
 *
 * The difference between the middle two is the load-bearing part, and it is
 * why `closed` must never be made to empty anything: it is the gentle half of
 * what §3 describes — a gym stopping new joins without telling forty members
 * their place is gone. `waitlistModeClosesQueue()` is the only place that
 * distinction is drawn, so a second writer cannot decide it differently.
 *
 * The browser mirror is `apps/admin/src/lib/waitlistModes.ts`, and the SQL
 * mirror is `chk_ce_waitlist_mode` / `chk_at_waitlist_mode` beside the two
 * columns (migration 154) — a new mode therefore goes in **three** places.
 */

export const WAITLIST_MODES = ['disabled', 'open', 'closed'] as const;
export type WaitlistMode = (typeof WAITLIST_MODES)[number];

export function isWaitlistMode(value: unknown): value is WaitlistMode {
  return typeof value === 'string' && (WAITLIST_MODES as readonly string[]).includes(value);
}

/**
 * Judge a request's `waitlist_mode`, the way `parseProfessionalServiceId()`
 * judges the sibling nullable column on the same route.
 *
 * Only ever called for a key the request actually sent: the `PUT` is a partial
 * write, so an absent field keeps what the occurrence is stored with and never
 * reaches here. `null` and `''` are the deliberate "follow the Activity Type
 * again" — the column's own natural state, which is why it is expressible even
 * though the panel offers the three explicit modes — and anything else is a
 * 400 rather than a coercion, because `closed` and `disabled` are opposite
 * promises to a member holding a place in the queue.
 */
export function parseWaitlistModeInput(
  value: unknown,
): { mode: WaitlistMode | null } | { error: string } {
  if (value === null || value === undefined || value === '') return { mode: null };
  if (isWaitlistMode(value)) return { mode: value };
  return { error: `waitlist_mode must be one of: ${WAITLIST_MODES.join(', ')}, or null` };
}

/**
 * Does writing this mode empty the occurrence's waiting list?
 *
 * `disabled` alone. Per the thread's `Q3`, disabling *removes* the members from
 * the waiting list — it is not a booking cancellation (§4: the alert "must not
 * be interpreted as a new booking or cancellation"), and a member holding a
 * `booked` row never had a place in the queue to lose, so they are untouched
 * and unalerted.
 */
export function waitlistModeClosesQueue(mode: WaitlistMode | null | undefined): boolean {
  return mode === 'disabled';
}

/**
 * What a member is actually subject to: the occurrence's own mode when it has
 * one, otherwise its Activity Type's. The same `COALESCE` every read of these
 * two tables already projects as `effective_waitlist_mode`, expressed once for
 * the paths that hold the two values rather than a SQL row.
 */
export function effectiveWaitlistMode(
  own: WaitlistMode | null | undefined,
  activityDefault: WaitlistMode | null | undefined,
): WaitlistMode {
  return own ?? activityDefault ?? 'disabled';
}
