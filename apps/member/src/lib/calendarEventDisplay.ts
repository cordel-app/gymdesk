/**
 * #976 — what a calendar event in the Members app looks like, and what it says
 * about *this* member.
 *
 * Two concepts the ticket insists on keeping apart:
 *
 *   • The **event's** colour is the event's own property. It is the same for
 *     every member, and it never encodes anybody's booking state. Before this
 *     ticket the member calendar painted the box from `availability_state` —
 *     yellow for "you are waitlisted", orange for "a waitlist you could join",
 *     green for "you are booked" — so the same class was a different colour
 *     for two members standing next to each other.
 *   • The **member's** relationship with the event (booked, waitlisted,
 *     completed) is text, never a hue.
 *
 * Everything here is pure: it resolves locale *keys* and plain style objects,
 * never calls `t()` and renders no JSX, so both halves of the decision can be
 * asserted directly (`apps/member/src/test/calendar-event-display.test.ts`).
 *
 * The admin calendar is deliberately untouched (#976's own scope note): its
 * events take the theme's Calendar event tokens and carry their status in a
 * pill badge (#559 stage 3).
 */

export interface MemberEventDisplayInput {
  /** `COALESCE(calendar_events.color, activity_types.color)` from `GET /me/schedule`. */
  color: string | null;
  /** The occurrence's own lifecycle, derived server-side from its times. */
  status: 'scheduled' | 'running' | 'completed' | 'cancelled';
  my_booking_status: 'booked' | 'waitlisted' | null;
  my_waitlist_position: number | null;
  waitlist_count: number;
}

/** A locale key plus its interpolation values — resolved by the page, not here. */
export interface MemberEventStatusLine {
  key: string;
  values: Record<string, string | number>;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The colour the event box is painted with, or `null` for "the theme's".
 *
 * `null` is not a failure: an event whose Activity Type never got a colour has
 * no colour configured, and the right answer is the gym's own
 * `calendarEventBackground` token (#559 stage 2) rather than a hue this module
 * invents. Returning `null` is what lets the caller leave FullCalendar's
 * inline style off entirely, so the themed base shows through.
 *
 * A stored value that is not a hex colour is treated the same way: the column
 * is a plain `VARCHAR(7)` with no CHECK, and an unusable value reaching an
 * inline style would drop the declaration and leave the box transparent —
 * `calendarVarValue()` reasons about exactly this case for the tokens (#559
 * stage 4).
 */
export function eventBackgroundColor(session: Pick<MemberEventDisplayInput, 'color'>): string | null {
  const raw = (session.color ?? '').trim();
  return HEX_RE.test(raw) ? raw : null;
}

/** The two foregrounds on offer — the app's own text colour, and white. */
export const EVENT_TEXT_COLORS = { dark: '#111827', light: '#ffffff' } as const;

/**
 * A foreground that reads against an arbitrary configured colour.
 *
 * The theme's `calendarEventText` is chosen against the theme's *own* event
 * background, so it cannot be trusted over a per-event hue a gym picked for a
 * different reason — hence this, for the inline case only; an event with no
 * colour configured keeps the token (`eventBackgroundColor()` answers `null`
 * and the caller sets no inline style).
 *
 * It scores both candidates with the WCAG 2.1 contrast formula — the same one
 * `apps/admin/src/lib/calendarContrast.ts` scores theme pairs with — and takes
 * the better of the two, rather than comparing the background against a fixed
 * luminance threshold: that threshold is derived for pure black, and the dark
 * candidate here is the app's `#111827`, which is not it. Only those two
 * colours are ever returned, so no new hue enters the palette.
 */
export function readableEventTextColor(background: string): string {
  const bg = relativeLuminance(background);
  if (bg == null) return EVENT_TEXT_COLORS.light;
  const dark = relativeLuminance(EVENT_TEXT_COLORS.dark) ?? 0;
  const light = relativeLuminance(EVENT_TEXT_COLORS.light) ?? 1;
  return contrastRatio(bg, dark) >= contrastRatio(bg, light)
    ? EVENT_TEXT_COLORS.dark
    : EVENT_TEXT_COLORS.light;
}

function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function relativeLuminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(channelLuminance);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseHex(hex: string): [number, number, number] | null {
  const raw = hex.trim();
  if (!HEX_RE.test(raw)) return null;
  const h = raw.slice(1);
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

function channelLuminance(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * The member's own status line, or `null` for "say nothing".
 *
 * `null` is the ticket's §2/§6 requirement and the reason this is a function
 * rather than a lookup table: a past event the member never booked reads as an
 * ordinary past event, with no `Not used`, no `Cancelled` and no `Past due`.
 * Those are the slot's operational states and are none of the member's
 * business — only a member who *has* a booking is told anything.
 *
 * The waitlist total rides along only while the waitlist is still something
 * that can move (§4): "Booked · 3 waiting" is information, "Completed · 3
 * waiting" is noise about a class that already happened.
 */
export function memberEventStatusLine(session: MemberEventDisplayInput): MemberEventStatusLine | null {
  const waiting = Number.isFinite(session.waitlist_count) ? Math.max(0, Math.trunc(session.waitlist_count)) : 0;
  const live = session.status === 'scheduled' || session.status === 'running';
  const withTotal = live && waiting > 0;

  if (session.my_booking_status === 'waitlisted') {
    const position = session.my_waitlist_position;
    if (position == null) {
      // A waitlisted booking with no stored position: report the standing
      // without inventing a number for it.
      return withTotal
        ? { key: 'event_status_waitlist_waiting', values: { waiting } }
        : { key: 'event_status_waitlist', values: {} };
    }
    return withTotal
      ? { key: 'event_status_waitlist_position_waiting', values: { position, waiting } }
      : { key: 'event_status_waitlist_position', values: { position } };
  }

  if (session.my_booking_status === 'booked') {
    // `completed` and `running` are derived server-side from the occurrence's
    // own times, so a member who attended a finished class reads "Completed"
    // with no attendance bookkeeping. `cancelled` is unreachable through
    // `GET /me/schedule` today (it only returns `status = 'scheduled'` rows),
    // but it is answered rather than ignored: a cancelled class the member
    // holds a booking for is the one cancellation that *is* theirs to know
    // (§7), and a future widening of that filter must not label it "Booked".
    if (session.status === 'completed') return { key: 'event_status_completed', values: {} };
    if (session.status === 'cancelled') return { key: 'event_status_cancelled', values: {} };
    return withTotal
      ? { key: 'event_status_booked_waiting', values: { waiting } }
      : { key: 'event_status_booked', values: {} };
  }

  return null;
}

/**
 * The chip the status line sits in.
 *
 * It declares no hue of its own (§11 — "do not introduce new
 * purple/lilac/orange/yellow colors specifically for booking states"): the
 * text is inherited from the event box, and the fill is a neutral 22% black,
 * which only ever darkens whatever the box is painted with. So it reads over a
 * colour the gym configured and over the theme's own event background alike,
 * without this module having to know which of the two it is sitting on.
 */
export const EVENT_STATUS_CHIP_STYLE = {
  background: 'rgba(0,0,0,0.22)',
  color: 'inherit',
  borderRadius: 999,
  padding: '0 6px',
  fontWeight: 700,
  display: 'inline-block',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;
