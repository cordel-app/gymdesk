import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { COLOR_GROUPS } from '../components/ThemeTokensEditor';
import { CALENDAR_THEME_CSS } from '../components/CalendarThemeStyles';
import {
  ADVANCED_ATTRIBUTES,
  CALENDAR_ADVANCED_VARS,
  CALENDAR_COLOR_VARS,
  DEFAULT_ADVANCED,
  DEFAULT_TOKENS,
  applyTokens,
  type ThemeTokens,
} from '../lib/themeTokens';

// #559 stage 2 — the Calendar tokens introduced in stage 1 now reach the
// calendar: applyTokens() writes one --gd-calendar-* variable per token, and
// CalendarThemeStyles' sheet is the single consumer of those variables.
// Stage 3 adds the event rules (per-status pill badge), so the three event
// variables are asserted to be emitted but NOT yet used by any CSS rule.

const calendarGroup = COLOR_GROUPS.find((g) => g.groupKey === 'group_calendar')!;
const calendarAdvanced = ADVANCED_ATTRIBUTES.filter((a) => a.group === 'group_calendar');

// Wired in stage 3 together with the per-status pill badge (#541 keeps event
// background/border derived from the booking status).
const EVENT_VARS = [
  '--gd-calendar-event-text',
  '--gd-calendar-event-radius',
  '--gd-calendar-event-selected-overlay',
];

/** Minimal `document` stand-in — these tests run in vitest's node environment. */
function stubDocument(): Record<string, string> {
  const written: Record<string, string> = {};
  (globalThis as any).document = {
    documentElement: {
      style: { setProperty: (name: string, value: string) => { written[name] = value; } },
    },
  };
  return written;
}

describe('Calendar theme CSS variables (#559 stage 2)', () => {
  let written: Record<string, string>;

  beforeEach(() => { written = stubDocument(); });
  afterEach(() => { delete (globalThis as any).document; });

  it('maps every editable calendar token to exactly one CSS variable', () => {
    expect(Object.keys(CALENDAR_COLOR_VARS).sort())
      .toEqual(calendarGroup.fields.map((f) => f.key as string).sort());
    expect(Object.keys(CALENDAR_ADVANCED_VARS).sort())
      .toEqual(calendarAdvanced.map((a) => a.key).sort());
    const names = [...Object.values(CALENDAR_COLOR_VARS), ...Object.values(CALENDAR_ADVANCED_VARS)];
    expect(new Set(names).size, 'two tokens share one CSS variable').toBe(names.length);
    for (const name of names) expect(name).toMatch(/^--gd-calendar-[a-z-]+$/);
  });

  it('emits every calendar variable for a fully configured theme', () => {
    applyTokens(DEFAULT_TOKENS);
    for (const [key, cssVar] of Object.entries(CALENDAR_COLOR_VARS)) {
      expect(written[cssVar], `${cssVar} not written`).toBe((DEFAULT_TOKENS.colors as any)[key]);
    }
    for (const [key, cssVar] of Object.entries(CALENDAR_ADVANCED_VARS)) {
      expect(written[cssVar], `${cssVar} not written`).toBe(String(DEFAULT_ADVANCED[key]));
    }
  });

  it('falls back to the defaults for a theme saved before #559', () => {
    // A pre-#559 theme: no calendar colors at all, and no `advanced` map.
    const legacy = {
      ...DEFAULT_TOKENS,
      colors: Object.fromEntries(
        Object.entries(DEFAULT_TOKENS.colors).filter(([k]) => !k.startsWith('calendar')),
      ),
    } as unknown as ThemeTokens;
    applyTokens(legacy);
    for (const [key, cssVar] of Object.entries(CALENDAR_COLOR_VARS)) {
      expect(written[cssVar], `${cssVar} not written for a legacy theme`)
        .toBe((DEFAULT_TOKENS.colors as any)[key]);
    }
    for (const [key, cssVar] of Object.entries(CALENDAR_ADVANCED_VARS)) {
      expect(written[cssVar], `${cssVar} not written for a legacy theme`)
        .toBe(String(DEFAULT_ADVANCED[key]));
    }
  });

  it('emits the configured value, not the default, once a token is set', () => {
    const themed = {
      ...DEFAULT_TOKENS,
      colors: { ...DEFAULT_TOKENS.colors, calendarTodayBackground: '#123456' },
      advanced: { calendarSlotHeight: '3em' },
    } as ThemeTokens;
    applyTokens(themed);
    expect(written['--gd-calendar-today-bg']).toBe('#123456');
    expect(written['--gd-calendar-slot-height']).toBe('3em');
    // Untouched siblings still resolve to their defaults.
    expect(written['--gd-calendar-grid-border']).toBe(DEFAULT_TOKENS.colors.calendarGridBorder);
    expect(written['--gd-calendar-nav-btn-radius']).toBe(DEFAULT_ADVANCED.calendarNavButtonBorderRadius);
  });
});

describe('Calendar theme stylesheet (#559 stage 2)', () => {
  it('consumes every non-event calendar variable', () => {
    const used = [...Object.values(CALENDAR_COLOR_VARS), ...Object.values(CALENDAR_ADVANCED_VARS)]
      .filter((v) => !EVENT_VARS.includes(v));
    for (const cssVar of used) {
      expect(CALENDAR_THEME_CSS, `${cssVar} is emitted but no rule reads it`).toContain(`var(${cssVar},`);
    }
  });

  it('leaves the event variables to stage 3', () => {
    for (const cssVar of EVENT_VARS) {
      expect(CALENDAR_THEME_CSS, `${cssVar} is wired — event colors are stage 3 (#541)`)
        .not.toContain(cssVar);
    }
  });

  it('gives every variable its default token value as the CSS fallback', () => {
    // The fallback is what an unthemed page renders with (no gym resolved yet,
    // or a theme with no calendar values) — it must match what applyTokens()
    // would have written, i.e. FullCalendar's own built-in appearance.
    const defaults = new Map<string, string>();
    for (const [key, cssVar] of Object.entries(CALENDAR_COLOR_VARS)) {
      defaults.set(cssVar, String((DEFAULT_TOKENS.colors as any)[key]));
    }
    for (const [key, cssVar] of Object.entries(CALENDAR_ADVANCED_VARS)) {
      defaults.set(cssVar, String(DEFAULT_ADVANCED[key]));
    }
    const uses = [...CALENDAR_THEME_CSS.matchAll(/var\((--gd-calendar-[a-z-]+),\s*([^)]+)\)/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, cssVar, fallback] of uses) {
      expect(defaults.get(cssVar), `${cssVar} is not a known calendar variable`).toBeDefined();
      expect(fallback.trim(), `${cssVar}'s CSS fallback drifted from its default token value`)
        .toBe(defaults.get(cssVar));
    }
  });

  it('scopes every rule to the .gd-calendar wrapper', () => {
    // Nothing here may leak into the rest of the app, or into a FullCalendar
    // instance that isn't the themed calendar.
    const selectors = CALENDAR_THEME_CSS
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}')
      .map((block) => block.split('{')[0].trim())
      .filter(Boolean)
      .flatMap((s) => s.split(',').map((x) => x.trim()));
    for (const selector of selectors) {
      expect(selector, `"${selector}" is not scoped to .gd-calendar`).toMatch(/^\.gd-calendar\b/);
    }
  });

  it('applies the styles and the wrapper class on the admin calendar page', () => {
    const src = readFileSync(join(__dirname, '..', 'app', '[locale]', 'calendar', 'page.tsx'), 'utf-8');
    expect(src).toContain('CalendarThemeStyles');
    expect(src).toContain('className="gd-calendar"');
  });
});
