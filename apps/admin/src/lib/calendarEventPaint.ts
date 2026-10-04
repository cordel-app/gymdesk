import { contrastRatio } from './calendarContrast';

/**
 * #975 — what colour an event is painted with on the **Admin** calendar.
 *
 * The ticket's answer, confirmed on the thread (`Q1 event colour`), is the
 * same one #976 gave the Members app and it keeps two concepts apart:
 *
 *   • the **event's** colour identifies the event — it is the gym's own
 *     configuration (`COALESCE(calendar_events.color, activity_types.color)`),
 *     identical for every viewer and for every state the event passes through;
 *   • the **status** — booking, capacity, or the execution status #977
 *     derives — is carried by `CalendarStatusBadge`, as text, and never by the
 *     box's fill.
 *
 * That is the third design in this place in three tickets, so it is worth
 * saying what each one decided and why this is not a relapse into the first.
 * #541 painted the event *by status*; #559 stage 3 overturned it, moved the
 * status into the badge and gave the box the theme's Calendar event tokens —
 * and in doing so left `calendar_events.color` editable and unread, which is
 * the #677 defect shape. #975 restores the configured colour **only**: the
 * status stays in the badge, where stage 3 put it, and nothing here looks at a
 * status at all. A caller that reaches for one is reintroducing #541.
 *
 * Everything in this module is pure — plain values, no JSX, no `t()` — so both
 * halves of the decision are directly assertable
 * (`apps/admin/src/test/calendar-event-paint.test.ts`).
 */

export interface CalendarEventPaintSource {
  /** `calendar_events.color` — the event's own, when a gym overrode it. */
  color?: string | null;
  /** `activity_types.color` — what the event inherits when it has none. */
  activity_type_color?: string | null;
}

export interface CalendarEventPaint {
  backgroundColor: string;
  borderColor: string;
  /** Scored against the background, never assumed — see below. */
  textColor: string;
  classNames: string[];
}

/**
 * Marks an event FullCalendar is painting from an inline colour.
 *
 * The theme's hover and focus rules are stylesheet declarations, so an inline
 * `background-color` beats them (that is the whole reason #559 stage 3 stopped
 * setting one). The class is what lets `CalendarThemeStyles` keep both
 * affordances for a coloured event without weakening them for an uncoloured
 * one — a filter rather than a second colour, and a ring in the event's own
 * text colour.
 */
export const COLORED_EVENT_CLASS = 'gd-event-colored';

/** The two foregrounds on offer — the app's own text colour, and white. */
export const EVENT_TEXT_COLORS = { dark: '#111827', light: '#ffffff' } as const;

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** `#abc` → `#aabbcc`; anything that is not a hex colour → `null`. */
function normalizeHex(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!HEX_RE.test(value)) return null;
  const digits = value.slice(1);
  const full = digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits;
  return `#${full.toLowerCase()}`;
}

/**
 * The colour the event box is painted with, or `null` for "the theme's".
 *
 * The event's own colour wins over its Activity Type's, which is the same
 * `COALESCE` order the API applies for the member calendar and the same order
 * the event editor assumes (its picker pre-fills from the Activity Type, so a
 * stored value is a deliberate override).
 *
 * `null` is not a failure: an event whose Activity Type never got a colour has
 * none configured, and the right answer is then the gym's own
 * `calendarEventBackground` token (#559 stage 2) rather than a hue this module
 * invents. Returning `null` is what lets the caller leave FullCalendar's
 * inline style off entirely, so the themed base shows through.
 *
 * A stored value that is not a hex colour is treated the same way. The column
 * is a plain `VARCHAR(7)` with no CHECK, and an unusable value reaching an
 * inline style would drop the declaration and leave the box transparent —
 * `calendarVarValue()` reasons about exactly this case for the tokens.
 */
export function eventBackgroundColor(event: CalendarEventPaintSource): string | null {
  return normalizeHex(event.color) ?? normalizeHex(event.activity_type_color);
}

/**
 * A foreground that reads against an arbitrary configured colour.
 *
 * The theme's `calendarEventText` is chosen against the theme's *own* event
 * background (that is the pair `calendarContrast.ts` scores), so it cannot be
 * trusted over a per-event hue a gym picked for a different reason — hence
 * this, for the inline case only; an event with no colour configured keeps the
 * token, because `eventBackgroundColor()` answers `null` and the caller sets
 * no inline style.
 *
 * Both candidates are scored with the WCAG 2.1 contrast formula — the same
 * implementation the theme editor's contrast report uses, deliberately, so the
 * admin app has one — and the better one is taken, rather than comparing the
 * background against a fixed luminance threshold: such a threshold is derived
 * for pure black, and the dark candidate here is the app's `#111827`, which is
 * not it. Only those two colours are ever returned, so no new hue enters the
 * palette.
 */
export function readableEventTextColor(background: string): string {
  const bg = normalizeHex(background);
  if (!bg) return EVENT_TEXT_COLORS.light;
  return contrastRatio(bg, EVENT_TEXT_COLORS.dark) >= contrastRatio(bg, EVENT_TEXT_COLORS.light)
    ? EVENT_TEXT_COLORS.dark
    : EVENT_TEXT_COLORS.light;
}

/**
 * The inline paint for one calendar event, or `null` for "leave it to the
 * theme".
 *
 * Spread onto the FullCalendar event object: `...(paint ?? {})`. The `null`
 * branch has to add *nothing* — an explicit `backgroundColor: undefined` is
 * fine for FullCalendar but makes the "no inline style" rule unreadable, and
 * a literal fallback hue here would override a gym's Theme.
 *
 * The border takes the background rather than a derived shade: the event box
 * is one solid colour in this app, and a second derived hue would be a colour
 * decision nobody configured.
 */
export function calendarEventPaint(event: CalendarEventPaintSource): CalendarEventPaint | null {
  const background = eventBackgroundColor(event);
  if (!background) return null;
  return {
    backgroundColor: background,
    borderColor: background,
    textColor: readableEventTextColor(background),
    classNames: [COLORED_EVENT_CLASS],
  };
}
