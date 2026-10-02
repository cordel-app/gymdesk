import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EVENT_STATUS_CHIP_STYLE,
  eventBackgroundColor,
  memberEventStatusLine,
  readableEventTextColor,
  type MemberEventDisplayInput,
} from '../lib/calendarEventDisplay';

// #976 — in the Members app a calendar event's colour is the *event's*, and
// the member's own booking state is text.
//
// The pure helpers are tested directly; the page is scanned, since apps/member
// has no component-test infra (same approach as members-background.test.ts
// (#725) and nutrition-food-carousel.test.ts (#722)).

const PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'calendar', 'page.tsx');
const LIB_PATH = join(__dirname, '..', 'lib', 'calendarEventDisplay.ts');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));
const libSrc = stripComments(readFileSync(LIB_PATH, 'utf-8'));

function session(over: Partial<MemberEventDisplayInput> = {}): MemberEventDisplayInput {
  return {
    color: '#3b82f6',
    status: 'scheduled',
    my_booking_status: null,
    my_waitlist_position: null,
    waitlist_count: 0,
    ...over,
  };
}

describe('the event box takes the event’s own colour (#976 §1)', () => {
  it('paints the configured colour', () => {
    expect(eventBackgroundColor({ color: '#ff8800' })).toBe('#ff8800');
    expect(eventBackgroundColor({ color: '#f80' })).toBe('#f80');
    expect(eventBackgroundColor({ color: '  #FF8800  ' })).toBe('#FF8800');
  });

  it('answers null for an event with no colour configured, so the theme paints it', () => {
    // #559 stage 2's `calendarEventBackground` is the fallback, and the only
    // way to reach it is to set no inline style at all.
    expect(eventBackgroundColor({ color: null })).toBeNull();
    expect(eventBackgroundColor({ color: '' })).toBeNull();
    expect(eventBackgroundColor({ color: '   ' })).toBeNull();
  });

  it('answers null for an unusable stored value rather than a transparent box', () => {
    // `calendar_events.color` is a plain VARCHAR(7) with no CHECK; an invalid
    // value in an inline style drops the declaration (the case
    // `calendarVarValue()` hardens for the tokens, #559 stage 4).
    expect(eventBackgroundColor({ color: 'rebeccapurple' })).toBeNull();
    expect(eventBackgroundColor({ color: '#12345' })).toBeNull();
    expect(eventBackgroundColor({ color: '#gggggg' })).toBeNull();
  });

  it('does not depend on the member’s booking state', () => {
    const colour = '#3b82f6';
    for (const my_booking_status of ['booked', 'waitlisted', null] as const) {
      expect(eventBackgroundColor(session({ color: colour, my_booking_status }))).toBe(colour);
    }
  });
});

describe('the event’s foreground reads against an arbitrary configured colour', () => {
  it('picks white on a dark colour and near-black on a light one', () => {
    expect(readableEventTextColor('#111827')).toBe('#ffffff');
    expect(readableEventTextColor('#6c63ff')).toBe('#ffffff');
    expect(readableEventTextColor('#fde68a')).toBe('#111827');
    expect(readableEventTextColor('#ffffff')).toBe('#111827');
  });

  it('expands a three-digit hex', () => {
    expect(readableEventTextColor('#fff')).toBe(readableEventTextColor('#ffffff'));
    expect(readableEventTextColor('#000')).toBe(readableEventTextColor('#000000'));
  });

  it('offers only black and white, so no new colour enters the palette', () => {
    const answers = new Set(
      ['#000000', '#ffffff', '#3b82f6', '#fde68a', '#6c63ff', '#22c55e'].map(readableEventTextColor),
    );
    expect([...answers].sort()).toEqual(['#111827', '#ffffff']);
  });
});

describe('the member’s own status, as text (#976 §2–§5)', () => {
  it('says nothing at all for an event the member never booked', () => {
    expect(memberEventStatusLine(session())).toBeNull();
    expect(memberEventStatusLine(session({ status: 'completed' }))).toBeNull();
    expect(memberEventStatusLine(session({ status: 'cancelled' }))).toBeNull();
    // Not even when the slot has a waitlist of its own: the count is the
    // event's, but the line is the member's, and they have no relationship
    // with this event.
    expect(memberEventStatusLine(session({ waitlist_count: 4 }))).toBeNull();
  });

  it('reads Booked for a booking on an upcoming or running event', () => {
    expect(memberEventStatusLine(session({ my_booking_status: 'booked' })))
      .toEqual({ key: 'event_status_booked', values: {} });
    expect(memberEventStatusLine(session({ my_booking_status: 'booked', status: 'running' })))
      .toEqual({ key: 'event_status_booked', values: {} });
  });

  it('reads Completed for a booking on a finished event', () => {
    expect(memberEventStatusLine(session({ my_booking_status: 'booked', status: 'completed' })))
      .toEqual({ key: 'event_status_completed', values: {} });
  });

  it('reads Cancelled only for a member who holds a booking on it', () => {
    expect(memberEventStatusLine(session({ my_booking_status: 'booked', status: 'cancelled' })))
      .toEqual({ key: 'event_status_cancelled', values: {} });
    expect(memberEventStatusLine(session({ my_booking_status: null, status: 'cancelled' }))).toBeNull();
  });

  it('reads the member’s waitlist position and the current total', () => {
    expect(memberEventStatusLine(session({ my_booking_status: 'waitlisted', my_waitlist_position: 2, waitlist_count: 4 })))
      .toEqual({ key: 'event_status_waitlist_position_waiting', values: { position: 2, waiting: 4 } });
    expect(memberEventStatusLine(session({ my_booking_status: 'waitlisted', my_waitlist_position: 2, waitlist_count: 1 })))
      .toEqual({ key: 'event_status_waitlist_position_waiting', values: { position: 2, waiting: 1 } });
  });

  it('reports the standing without a position when none is stored', () => {
    expect(memberEventStatusLine(session({ my_booking_status: 'waitlisted', my_waitlist_position: null })))
      .toEqual({ key: 'event_status_waitlist', values: {} });
    expect(memberEventStatusLine(session({ my_booking_status: 'waitlisted', my_waitlist_position: null, waitlist_count: 3 })))
      .toEqual({ key: 'event_status_waitlist_waiting', values: { waiting: 3 } });
  });

  it('carries the waitlist total beside Booked while the waitlist can still move', () => {
    expect(memberEventStatusLine(session({ my_booking_status: 'booked', waitlist_count: 3 })))
      .toEqual({ key: 'event_status_booked_waiting', values: { waiting: 3 } });
    // …and drops it once the class has happened: a total on a finished class
    // is noise, not information.
    expect(memberEventStatusLine(session({ my_booking_status: 'booked', status: 'completed', waitlist_count: 3 })))
      .toEqual({ key: 'event_status_completed', values: {} });
  });

  it('never reports a negative or fractional waitlist total', () => {
    expect(memberEventStatusLine(session({ my_booking_status: 'booked', waitlist_count: -2 })))
      .toEqual({ key: 'event_status_booked', values: {} });
    expect(memberEventStatusLine(session({ my_booking_status: 'booked', waitlist_count: 2.7 })))
      .toEqual({ key: 'event_status_booked_waiting', values: { waiting: 2 } });
    expect(memberEventStatusLine(session({ my_booking_status: 'booked', waitlist_count: NaN })))
      .toEqual({ key: 'event_status_booked', values: {} });
  });
});

describe('the status chip declares no colour of its own (#976 §11)', () => {
  it('inherits the event’s foreground and only darkens its background', () => {
    expect(EVENT_STATUS_CHIP_STYLE.color).toBe('inherit');
    expect(EVENT_STATUS_CHIP_STYLE.background).toBe('rgba(0,0,0,0.22)');
  });

  it('holds no hue — the module names no colour but black and white', () => {
    const hexes = libSrc.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect([...new Set(hexes)].sort()).toEqual(['#111827', '#ffffff']);
    for (const banned of ['purple', 'lilac', 'orange', 'yellow']) {
      expect(libSrc.toLowerCase()).not.toContain(banned);
    }
  });
});

describe('the member calendar page (#976)', () => {
  it('no longer colours an event by the member’s availability state', () => {
    expect(pageSrc).not.toContain('STATE_COLORS');
    expect(pageSrc).not.toContain('WAITLISTED_BY_MEMBER:');
  });

  it('asks the shared module for the colour, the foreground and the status', () => {
    expect(pageSrc).toContain('eventBackgroundColor(s)');
    expect(pageSrc).toContain('readableEventTextColor(background)');
    expect(pageSrc).toContain('memberEventStatusLine(s)');
  });

  it('sets no inline event colour when the event configured none', () => {
    // The spread is conditional: an event with no colour must reach
    // FullCalendar with no backgroundColor/borderColor/textColor at all, or
    // the inline style beats the theme (#559 stage 3's own reasoning).
    expect(pageSrc).toMatch(/\.\.\.\(background\s*\n?\s*\?\s*\{/);
    expect(pageSrc).toMatch(/backgroundColor: background/);
    expect(pageSrc).toMatch(/borderColor: background/);
  });

  it('declares no booking-state colour of its own in the event box', () => {
    const mapping = pageSrc.slice(pageSrc.indexOf('sessions.map'), pageSrc.indexOf('holidayBackgroundEvents'));
    expect(mapping).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('renders the status line only when there is one', () => {
    expect(pageSrc).toContain('{statusLine && (');
    expect(pageSrc).toContain('t(statusLine.key, statusLine.values)');
  });
});

describe('the status labels are translated everywhere (#976 §11)', () => {
  const KEYS = [
    'event_status_booked',
    'event_status_booked_waiting',
    'event_status_completed',
    'event_status_cancelled',
    'event_status_waitlist',
    'event_status_waitlist_waiting',
    'event_status_waitlist_position',
    'event_status_waitlist_position_waiting',
  ];

  for (const code of LOCALE_CODES) {
    it(`${code} carries every status key`, () => {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      for (const key of KEYS) {
        const value = messages.member_calendar?.[key];
        expect(value, `${code}.member_calendar.${key}`).toBeTypeOf('string');
        expect(String(value).length).toBeGreaterThan(0);
      }
    });
  }

  it('interpolates the same placeholders in every locale', () => {
    const byLocale = LOCALE_CODES.map((code) =>
      JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')).member_calendar,
    );
    for (const key of KEYS) {
      const placeholders = byLocale.map((m) =>
        [...String(m[key]).matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(','),
      );
      expect(new Set(placeholders).size, key).toBe(1);
    }
  });
});
