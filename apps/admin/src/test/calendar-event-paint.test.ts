import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  COLORED_EVENT_CLASS,
  EVENT_TEXT_COLORS,
  calendarEventPaint,
  eventBackgroundColor,
  readableEventTextColor,
} from '../lib/calendarEventPaint';
import { AA_NON_TEXT_RATIO, contrastRatio } from '../lib/calendarContrast';
import { CALENDAR_THEME_CSS } from '../components/CalendarThemeStyles';

// #975 — the Admin calendar's event colour.
//
// The ticket's rule is two sentences: the box is the event's configured colour
// (`COALESCE(calendar_events.color, activity_types.color)`), and the status is
// the badge's business. These tests cover the three answers that are the rule
// rather than the implementation — the COALESCE order, `null` for "leave it to
// the theme", and a foreground that is scored rather than assumed — plus the
// two affordances an inline background would otherwise swallow.

const SRC = join(__dirname, '..');
const paintModule = readFileSync(join(SRC, 'lib', 'calendarEventPaint.ts'), 'utf-8');
const calendarPage = readFileSync(join(SRC, 'app', '[locale]', 'calendar', 'page.tsx'), 'utf-8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Which colour an event is painted with (#975 §1/§5)', () => {
  it('prefers the event\'s own colour over its Activity Type\'s', () => {
    expect(eventBackgroundColor({ color: '#123456', activity_type_color: '#abcdef' })).toBe('#123456');
    expect(eventBackgroundColor({ color: null, activity_type_color: '#abcdef' })).toBe('#abcdef');
    expect(eventBackgroundColor({ activity_type_color: '#ABCDEF' })).toBe('#abcdef');
  });

  it('accepts the shorthand form the column can hold', () => {
    // `VARCHAR(7)` with no CHECK: the pickers emit `#rrggbb`, but a row
    // written elsewhere may be shorthand, and it is a usable colour.
    expect(eventBackgroundColor({ color: '#0af' })).toBe('#00aaff');
  });

  it('answers null for an event with no usable colour, so the theme paints it', () => {
    // Each of these would otherwise reach an inline style, where an invalid
    // value drops the declaration and leaves the box transparent.
    for (const color of [null, undefined, '', '   ', 'blue', '#12345', 'rgb(1,2,3)', '#1234567']) {
      expect(
        eventBackgroundColor({ color: color as any, activity_type_color: null }),
        `${String(color)} should not reach an inline style`,
      ).toBeNull();
    }
    expect(calendarEventPaint({ color: null, activity_type_color: null })).toBeNull();
  });

  it('never derives a second hue: the border is the background', () => {
    const paint = calendarEventPaint({ color: '#3366cc' })!;
    expect(paint.backgroundColor).toBe('#3366cc');
    expect(paint.borderColor).toBe('#3366cc');
    expect(paint.classNames).toEqual([COLORED_EVENT_CLASS]);
  });
});

describe('The foreground is scored, not assumed (#975 §6)', () => {
  it('offers exactly two candidates and no third', () => {
    expect(Object.values(EVENT_TEXT_COLORS).sort()).toEqual(['#111827', '#ffffff']);
  });

  it('takes the better of the two for any configured colour', () => {
    // A light fill reads with the app's dark text; a dark one with white.
    expect(readableEventTextColor('#ffeb3b')).toBe(EVENT_TEXT_COLORS.dark);
    expect(readableEventTextColor('#1a237e')).toBe(EVENT_TEXT_COLORS.light);
    // And it is a comparison, not a luminance threshold tuned for black: the
    // chosen colour must never be the worse-contrasting of the two.
    for (const bg of ['#ffffff', '#000000', '#6c63ff', '#ff9800', '#4caf50', '#795548', '#9e9e9e', '#0af']) {
      const chosen = readableEventTextColor(bg);
      const other = chosen === EVENT_TEXT_COLORS.dark ? EVENT_TEXT_COLORS.light : EVENT_TEXT_COLORS.dark;
      const full = bg.length === 4
        ? `#${bg.slice(1).split('').map((c) => c + c).join('')}`
        : bg;
      expect(contrastRatio(full, chosen), `${bg} picked the worse foreground`)
        .toBeGreaterThanOrEqual(contrastRatio(full, other));
    }
  });

  it('never does worse than the blanket white it replaces', () => {
    // The property that is actually guaranteed. The picker is a free hex
    // field, so no absolute threshold can be promised for every input — and
    // AA text (4.5:1) is not reachable on the app's own lilac at all: white
    // on `#6c63ff` scores 4.32 and `#111827` 4.11, which is why the theme
    // editor's contrast report is advisory rather than a save blocker (#559
    // stage 4). What this scoring buys is that the foreground is never the
    // worse of the two, which a fixed `#ffffff` would be on every light fill.
    for (const bg of ['#6c63ff', '#1a237e', '#c0392b', '#1e7e40', '#ffeb3b', '#ffffff', '#111827', '#ff9800', '#9e9e9e']) {
      const chosen = contrastRatio(bg, readableEventTextColor(bg));
      expect(chosen, `${bg} reads worse than plain white`)
        .toBeGreaterThanOrEqual(contrastRatio(bg, EVENT_TEXT_COLORS.light));
      // And it clears the 3:1 bar WCAG sets for large text and UI boundaries
      // on every colour of that palette, including the two extremes.
      expect(chosen, `${bg} fails even 3:1`).toBeGreaterThanOrEqual(AA_NON_TEXT_RATIO);
    }
  });

  it('falls back to white rather than throwing on an unusable background', () => {
    expect(readableEventTextColor('nonsense')).toBe(EVENT_TEXT_COLORS.light);
  });
});

describe('The module decides a colour and nothing else', () => {
  it('cannot see a booking, capacity or execution status', () => {
    // #541 painted the event by status and #559 stage 3 overturned it; #975
    // restores the *configured* colour only. A status reaching this module is
    // the relapse.
    const src = stripComments(paintModule);
    for (const forbidden of ['status', 'booked_count', 'waitlist', 'capacity', 'attendance']) {
      expect(src, `the paint module reads ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('is pure — no JSX, no translation, no fetch', () => {
    const src = stripComments(paintModule);
    expect(src).not.toContain('useTranslations');
    expect(src).not.toContain('apiFetch');
    expect(src).not.toMatch(/<[A-Za-z]/);
  });

  it('reuses the app\'s one WCAG implementation', () => {
    // Rather than a second copy of the formula beside the theme editor's.
    expect(paintModule).toContain("from './calendarContrast'");
  });
});

describe('An inline colour keeps the hover and focus affordances', () => {
  const RULES = stripComments(CALENDAR_THEME_CSS);

  it('darkens a coloured event on hover instead of recolouring it', () => {
    // The themed hover rule sets `background-color`, which an inline
    // background beats — so a coloured event needs a declaration an inline
    // style cannot win against, and it must not replace the gym's colour.
    const rule = RULES.split('}').find(
      (block) => block.includes(`.${COLORED_EVENT_CLASS}`) && block.includes(':hover'),
    );
    expect(rule, 'no hover rule for a coloured event').toBeDefined();
    expect(rule).toContain('filter: brightness(');
    expect(rule, 'the hover rule would repaint background events').toContain(':not(.fc-bg-event)');
  });

  it('draws the focus ring in the event\'s own text colour', () => {
    // The theme's `calendarEventText` is scored against the theme's event
    // background, so it is not guaranteed to read over a per-event hue.
    const rule = RULES.split('}').find(
      (block) => block.includes(`.${COLORED_EVENT_CLASS}`) && block.includes(':focus-visible'),
    );
    expect(rule, 'no focus rule for a coloured event').toBeDefined();
    expect(rule).toContain('outline-color: currentColor');
  });

  it('leaves an uncoloured event on the theme tokens', () => {
    expect(RULES).toContain('--fc-event-bg-color: var(--gd-calendar-event-bg,');
    expect(stripComments(calendarPage)).toContain('calendarEventPaint(');
  });
});
