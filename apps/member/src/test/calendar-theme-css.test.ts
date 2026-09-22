import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CALENDAR_THEME_CSS } from '../components/CalendarThemeStyles';
import {
  CALENDAR_ADVANCED_COLOR_KEYS,
  CALENDAR_ADVANCED_VARS,
  CALENDAR_COLOR_VARS,
  DEFAULT_CALENDAR_ADVANCED,
  DEFAULT_TOKENS,
  applyTokens,
  type ThemeTokens,
} from '../lib/themeTokens';

// #559 stage 2 — Member Web renders the same FullCalendar views off the same
// theme as Admin, so it applies the same Calendar tokens. Both files here are
// mirrors of their Admin counterparts (the convention lib/themeTokens.ts has
// followed since #489 stage 4); these tests fail if either copy drifts.

const ADMIN_DIR = join(__dirname, '..', '..', '..', 'admin', 'src');

function stubDocument(): Record<string, string> {
  const written: Record<string, string> = {};
  (globalThis as any).document = {
    documentElement: {
      style: { setProperty: (name: string, value: string) => { written[name] = value; } },
    },
  };
  return written;
}

describe('Member Web calendar theming (#559 stage 2)', () => {
  let written: Record<string, string>;

  beforeEach(() => { written = stubDocument(); });
  afterEach(() => { delete (globalThis as any).document; });

  it('emits every calendar variable, falling back to defaults for a pre-#559 theme', () => {
    const legacy = {
      ...DEFAULT_TOKENS,
      colors: Object.fromEntries(
        Object.entries(DEFAULT_TOKENS.colors).filter(([k]) => !k.startsWith('calendar')),
      ),
    } as unknown as ThemeTokens;
    applyTokens(legacy);
    for (const [key, cssVar] of Object.entries(CALENDAR_COLOR_VARS)) {
      expect(written[cssVar], `${cssVar} not written`).toBe((DEFAULT_TOKENS.colors as any)[key]);
    }
    for (const [key, cssVar] of Object.entries(CALENDAR_ADVANCED_VARS)) {
      expect(written[cssVar], `${cssVar} not written`).toBe(DEFAULT_CALENDAR_ADVANCED[key]);
    }
  });

  it('emits a configured value over the default', () => {
    applyTokens({
      ...DEFAULT_TOKENS,
      colors: { ...DEFAULT_TOKENS.colors, calendarHeaderBackground: '#abcdef' },
      advanced: { calendarNavButtonBorderRadius: '12px' },
    } as ThemeTokens);
    expect(written['--gd-calendar-header-bg']).toBe('#abcdef');
    expect(written['--gd-calendar-nav-btn-radius']).toBe('12px');
  });

  it('keeps the variable map, calendar defaults and stylesheet identical to Admin', () => {
    const adminTokensSrc = readFileSync(join(ADMIN_DIR, 'lib', 'themeTokens.ts'), 'utf-8');
    for (const [key, cssVar] of Object.entries({ ...CALENDAR_COLOR_VARS, ...CALENDAR_ADVANCED_VARS })) {
      expect(adminTokensSrc, `Admin has no ${key} → ${cssVar} mapping`).toContain(`'${cssVar}'`);
      expect(adminTokensSrc, `Admin has no ${key} token`).toContain(key);
    }
    for (const [key, value] of Object.entries(DEFAULT_TOKENS.colors)) {
      if (!key.startsWith('calendar')) continue;
      expect(adminTokensSrc, `Admin's default for ${key} is not ${value}`).toContain(String(value));
    }
    const adminCss = readFileSync(join(ADMIN_DIR, 'components', 'CalendarThemeStyles.tsx'), 'utf-8');
    expect(adminCss, "Admin's calendar stylesheet and Member Web's have drifted")
      .toContain(CALENDAR_THEME_CSS);
  });

  it('falls back to the default when a persisted value is not usable (#559 stage 4)', () => {
    applyTokens({
      ...DEFAULT_TOKENS,
      colors: { ...DEFAULT_TOKENS.colors, calendarSurfaceBackground: 'white', calendarEventText: '' },
      advanced: { calendarNavButtonHoverBackground: 'not-a-color', calendarSlotHeight: '  ' },
    } as unknown as ThemeTokens);
    expect(written['--gd-calendar-surface-bg']).toBe(DEFAULT_TOKENS.colors.calendarSurfaceBackground);
    expect(written['--gd-calendar-event-text']).toBe(DEFAULT_TOKENS.colors.calendarEventText);
    expect(written['--gd-calendar-nav-btn-hover-bg']).toBe(DEFAULT_CALENDAR_ADVANCED.calendarNavButtonHoverBackground);
    expect(written['--gd-calendar-slot-height']).toBe(DEFAULT_CALENDAR_ADVANCED.calendarSlotHeight);
  });

  it('agrees with Admin on which calendar advanced attributes are colors (#559 stage 4)', () => {
    // Admin derives this set from its editor metadata (`ADVANCED_ATTRIBUTES`),
    // which Member Web has no copy of — so the literal here is checked against
    // the attributes Admin marks `type: 'color'` in the Calendar group.
    const adminSrc = readFileSync(join(ADMIN_DIR, 'lib', 'themeTokens.ts'), 'utf-8');
    const adminColorKeys = [...adminSrc.matchAll(/\{ key: '(calendar\w+)',\s+labelKey: '[^']+',\s+group: 'group_calendar', type: 'color' \}/g)]
      .map((m) => m[1]);
    expect(adminColorKeys.length).toBeGreaterThan(0);
    expect([...CALENDAR_ADVANCED_COLOR_KEYS].sort()).toEqual(adminColorKeys.sort());
  });

  it('applies the styles and the wrapper class on the member calendar page', () => {
    const src = readFileSync(join(__dirname, '..', 'app', '[locale]', 'calendar', 'page.tsx'), 'utf-8');
    expect(src).toContain('CalendarThemeStyles');
    expect(src).toContain('className="gd-calendar"');
  });
});
