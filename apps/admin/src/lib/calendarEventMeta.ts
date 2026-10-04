/**
 * #981 — which secondary facts an **Admin** calendar event box carries, and
 * how they are laid out when the box is small.
 *
 * The ticket's requirement is that an admin can read *who is delivering the
 * session and where it takes place* without opening the event, in the Day and
 * Week views. Two properties of that are the rule rather than the
 * implementation, and this module is the one place either is decided:
 *
 *   • **The values are the occurrence's own** (§3). `GET /calendar-events`,
 *     `GET /class-sessions` and `GET /me/schedule` all project `space_name` /
 *     `trainer_name` by joining `ce.space_id` / `ce.trainer_membership_id`, so
 *     an event retargeted away from its Activity Type's defaults reads as
 *     *Jane Smith · Studio 2* and never as the Activity's *John Smith ·
 *     Studio 1*. Nothing here reads an Activity Type default, and no caller
 *     may pass one in as a fallback.
 *   • **Missing means absent, never a placeholder** (§6). A blank, whitespace
 *     or null name resolves to `null`, and `null` produces no line at all —
 *     no `N/A`, no `Unknown`, no `Not assigned`. That is also why this module
 *     returns the lines to render rather than a pre-joined string with
 *     separators in it: a trailing ` · ` is exactly the empty placeholder the
 *     ticket forbids.
 *
 * It says nothing about colour (§8): the box is painted by
 * `calendarEventPaint()` from the event's own configured colour (#975), and
 * trainer and space are secondary *text*. A caller that turned either of them
 * into a hue would be reintroducing #541.
 *
 * Everything here is pure — plain strings, no JSX, no `t()`, no locale key,
 * because a person's name and a room's name are data and not copy — so the
 * decision is directly assertable
 * (`apps/admin/src/test/calendar-event-meta.test.ts`). The Members app has its
 * own counterpart under the same rules (`memberEventMeta()` in
 * `apps/member/src/lib/calendarEventDisplay.ts`); the two apps share no
 * frontend module, as #975/#976 already established for the colour.
 */

export interface CalendarEventMetaSource {
  /** `gym_memberships.name` for `ce.trainer_membership_id`. */
  trainer_name?: string | null;
  /**
   * `gym_memberships.name` for `ce.effective_trainer_membership_id` — who
   * actually delivered the occurrence (#193). Only a session read projects it,
   * so a manual calendar entry falls through to its own trainer.
   */
  effective_trainer_name?: string | null;
  /** `spaces.name` for `ce.space_id`. */
  space_name?: string | null;
}

export interface CalendarEventMeta {
  trainer: string | null;
  space: string | null;
}

/**
 * How much room the box has for this information.
 *
 * `full` is the Day view, where §4 puts the trainer and the space on lines of
 * their own; `compact` is the Week view, where §7 asks for one truncated
 * `Trainer · Space` line instead, because a week column is a few characters
 * wide and a second line costs height the event may not have.
 */
export type CalendarEventMetaLayout = 'full' | 'compact';

/** `' · '` — the separator the Day view's own counts line has always used. */
export const META_SEPARATOR = ' · ';

function cleanName(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The occurrence's trainer and space, each `null` when it has none. */
export function calendarEventMeta(source: CalendarEventMetaSource): CalendarEventMeta {
  return {
    trainer: cleanName(source.effective_trainer_name) ?? cleanName(source.trainer_name),
    space: cleanName(source.space_name),
  };
}

/**
 * The lines to render, in order — empty when the occurrence has neither.
 *
 * `compact` collapses both onto one line and `full` keeps them apart, but
 * neither ever emits a line for a value that is missing, so an event with a
 * trainer and no space reads the same in both layouts.
 */
export function calendarEventMetaLines(
  meta: CalendarEventMeta,
  layout: CalendarEventMetaLayout,
): string[] {
  const parts = [meta.trainer, meta.space].filter((p): p is string => !!p);
  if (parts.length === 0) return [];
  return layout === 'compact' ? [parts.join(META_SEPARATOR)] : parts;
}

/** One truncated line of the parts given, or `null` when none of them exists. */
export function joinMetaParts(parts: (string | null)[]): string | null {
  const present = parts.filter((p): p is string => !!p && p.trim().length > 0);
  return present.length > 0 ? present.join(META_SEPARATOR) : null;
}
