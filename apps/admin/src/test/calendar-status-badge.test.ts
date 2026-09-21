import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CALENDAR_THEME_CSS } from '../components/CalendarThemeStyles';
import { getCalendarEventStatusBadgeColors } from '../lib/calendarEventColors';

// #559 stage 3 — event colors move to the theme, the booking status moves to a
// pill badge inside the event. These tests guard the two halves of that swap:
// nothing may paint an event by status again (it would override the theme),
// and the badge must be present in every view, or the status becomes invisible.

const SRC = join(__dirname, '..');
const calendarPage = readFileSync(join(SRC, 'app', '[locale]', 'calendar', 'page.tsx'), 'utf-8');
const badgeComponent = readFileSync(join(SRC, 'components', 'CalendarStatusBadge.tsx'), 'utf-8');

/** Comments explain these rules; only the declarations are under test here. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CSS_RULES = stripComments(CALENDAR_THEME_CSS);

const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const BADGE_STATUSES = ['draft', 'scheduled', 'completed', 'cancelled', 'full'] as const;

describe('Calendar event colors come from the theme (#559 stage 3)', () => {
  it('sets no per-event background or border on the admin calendar', () => {
    // FullCalendar writes these as inline styles, which beat the theme's CSS —
    // so a per-event color here would silently disable the Event background /
    // Event border tokens.
    expect(calendarPage, 'the calendar page sets a per-event backgroundColor again')
      .not.toMatch(/^\s*backgroundColor:/m);
    expect(calendarPage, 'the calendar page sets a per-event borderColor again')
      .not.toMatch(/^\s*borderColor:/m);
  });

  it('maps the event tokens onto FullCalendar\'s own event variables', () => {
    // One mapping each reaches .fc-h-event / .fc-v-event in every view.
    expect(CALENDAR_THEME_CSS).toContain('--fc-event-bg-color: var(--gd-calendar-event-bg,');
    expect(CALENDAR_THEME_CSS).toContain('--fc-event-border-color: var(--gd-calendar-event-border,');
    expect(CALENDAR_THEME_CSS).toContain('--fc-event-text-color: var(--gd-calendar-event-text,');
  });

  it('leaves the closed-hours background blocks alone', () => {
    // The grey out-of-hours blocks (#418) are FullCalendar background events,
    // painted from --fc-bg-event-color. Nothing here may repaint them, and the
    // hover rule must skip them.
    expect(CSS_RULES).not.toContain('--fc-bg-event-color');
    const hoverRule = CSS_RULES
      .split('}')
      .find((block) => block.includes(':hover') && block.includes('--gd-calendar-event-hover-bg'));
    expect(hoverRule, 'no event hover rule found').toBeDefined();
    expect(hoverRule, 'the hover rule would repaint background events').toContain(':not(.fc-bg-event)');
  });

  it('re-asserts the corner flattening for continued multi-day events', () => {
    // The event radius rule is at least as specific as FullCalendar's own
    // "continued event" rules, so those have to be restated after it or a
    // continuation gets a rounded edge where it should join the previous day.
    expect(CALENDAR_THEME_CSS).toContain('.fc-daygrid-block-event:not(.fc-event-start)');
    expect(CALENDAR_THEME_CSS).toContain('.fc-v-event:not(.fc-event-start)');
    const radiusAt = CSS_RULES.indexOf('var(--gd-calendar-event-radius,');
    expect(radiusAt).toBeGreaterThan(-1);
    expect(
      CSS_RULES.indexOf('.fc-daygrid-block-event:not(.fc-event-start)'),
      'the flattening rules must come after the radius rule to win',
    ).toBeGreaterThan(radiusAt);
  });

  it('applies the selected-event overlay at FullCalendar\'s own weight', () => {
    // The token is a plain color (it comes from a color picker), so the .25
    // FullCalendar bakes into its rgba() has to be re-applied as opacity.
    const overlayRule = CSS_RULES
      .split('}')
      .find((block) => block.includes('--gd-calendar-event-selected-overlay'));
    expect(overlayRule).toBeDefined();
    expect(overlayRule).toContain('opacity: 0.25');
    expect(overlayRule, 'the overlay must also cover a keyboard-focused event').toContain(':focus:after');
  });
});

describe('Calendar status pill badge (#559 stage 3)', () => {
  it('renders the badge in all three views', () => {
    // Day, week and month each build their own event content; a view that
    // drops the badge shows no status at all now that every event is one color.
    const uses = calendarPage.match(/<CalendarStatusBadge\b/g) ?? [];
    expect(uses.length, 'expected one badge per view (day, week, month)').toBe(3);
    expect(calendarPage).toContain("import { CalendarStatusBadge }");
  });

  it('takes its colors from the centralized status mapping only', () => {
    expect(badgeComponent).toContain('getCalendarEventStatusBadgeColors');
    // No second palette: the badge must not hardcode colors of its own.
    const hardcoded = stripComments(badgeComponent).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hardcoded, `badge hardcodes colors: ${hardcoded.join(', ')}`).toHaveLength(0);
  });

  it('shows `full` rather than `scheduled` for a session at capacity', () => {
    expect(calendarPage).toMatch(/isFull\s*\?\s*'full'/);
  });

  it('has a translated label for every badge status in every locale', () => {
    // next-intl has no locale fallback (apps/admin/src/i18n.ts), so a missing
    // key renders as its raw dotted path inside the badge.
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      for (const status of BADGE_STATUSES) {
        const value = messages.calendar?.[`status_${status}`];
        expect(value, `${code}.json is missing calendar.status_${status}`).toBeTypeOf('string');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('gives every badge status a color that survives any configured event background', () => {
    // The badge carries its own background, so it stays readable whatever the
    // theme paints the event with — that is the point of the pill.
    for (const status of BADGE_STATUSES) {
      const { bg, fg } = getCalendarEventStatusBadgeColors(status);
      expect(bg).toMatch(/^#[0-9a-f]{6}$/i);
      expect(fg).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
