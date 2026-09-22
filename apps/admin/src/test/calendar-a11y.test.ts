import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { COLOR_GROUPS } from '../components/ThemeTokensEditor';
import { CALENDAR_THEME_CSS } from '../components/CalendarThemeStyles';
import {
  AA_NON_TEXT_RATIO,
  AA_TEXT_RATIO,
  CALENDAR_CONTRAST_PAIRS,
  checkCalendarContrast,
  contrastRatio,
  relativeLuminance,
  resolveCalendarColor,
} from '../lib/calendarContrast';
import {
  ADVANCED_ATTRIBUTES,
  CALENDAR_ADVANCED_COLOR_KEYS,
  CALENDAR_ADVANCED_VARS,
  CALENDAR_COLOR_VARS,
  DEFAULT_ADVANCED,
  DEFAULT_TOKENS,
  applyTokens,
  isHexColor,
  type ThemeTokens,
} from '../lib/themeTokens';

// #559 stage 4 — the accessibility pass over the Calendar theme section:
// the contrast report the editors show while colors are being picked, the
// focus indicators the themed calendar has to keep, and the fallback that
// stops an unusable persisted value from reaching a CSS variable.
//
// The token layer itself is covered by theme-calendar-tokens.test.ts, the
// variable wiring by theme-calendar-css.test.ts and the status badge by
// calendar-status-badge.test.ts.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const NAMESPACES = ['themes', 'gym_themes'] as const;

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, string>>>;

const calendarGroup = COLOR_GROUPS.find((g) => g.groupKey === 'group_calendar')!;
const calendarAdvanced = ADVANCED_ATTRIBUTES.filter((a) => a.group === 'group_calendar');

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

describe('WCAG contrast math (#559 stage 4)', () => {
  it('scores the extremes of the scale', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('is symmetric — which color is the foreground does not change the ratio', () => {
    expect(contrastRatio('#6b7280', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#6b7280'), 10);
  });

  it('agrees with the published ratio for a known pair', () => {
    // #6b7280 (the muted grey the calendar's other-month dates default to) on
    // white is 4.83:1 — just over AA.
    expect(contrastRatio('#6b7280', '#ffffff')).toBeCloseTo(4.83, 2);
  });

  it('is case-insensitive about the hex it is given', () => {
    expect(contrastRatio('#ABCDEF', '#ffffff')).toBeCloseTo(contrastRatio('#abcdef', '#ffffff'), 10);
  });
});

describe('Calendar contrast pairs (#559 stage 4)', () => {
  it('names only real calendar tokens on both sides', () => {
    const known = new Set([...Object.keys(CALENDAR_COLOR_VARS), ...Object.keys(CALENDAR_ADVANCED_VARS)]);
    for (const pair of CALENDAR_CONTRAST_PAIRS) {
      expect(known.has(pair.fg), `${pair.id}: "${pair.fg}" is not a calendar token`).toBe(true);
      expect(known.has(pair.bg), `${pair.id}: "${pair.bg}" is not a calendar token`).toBe(true);
      expect(pair.fg).not.toBe(pair.bg);
    }
  });

  it('gives every pair a unique id and one of the two AA thresholds', () => {
    const ids = CALENDAR_CONTRAST_PAIRS.map((p) => p.id);
    expect(new Set(ids).size, 'duplicate pair id').toBe(ids.length);
    for (const pair of CALENDAR_CONTRAST_PAIRS) {
      expect([AA_TEXT_RATIO, AA_NON_TEXT_RATIO]).toContain(pair.minRatio);
    }
  });

  it('only names tokens the editor can label, in every locale and namespace', () => {
    // The report prints each side with the same label as the picker above it,
    // looked up from the section definitions — so every token in a pair must
    // carry a label key that actually translates.
    const labelKeys = new Map<string, string>([
      ...calendarGroup.fields.map(({ key, labelKey }) => [key as string, labelKey] as const),
      ...calendarAdvanced.map((a) => [a.key, a.labelKey] as const),
    ]);
    for (const pair of CALENDAR_CONTRAST_PAIRS) {
      for (const key of [pair.fg, pair.bg]) {
        const labelKey = labelKeys.get(key);
        expect(labelKey, `${key} has no label key in the Calendar section`).toBeDefined();
        for (const locale of LOCALE_CODES) {
          for (const ns of NAMESPACES) {
            expect(locales[locale][ns][labelKey!], `${locale}.${ns}.${labelKey} missing`).toBeTruthy();
          }
        }
      }
    }
  });

  it('scores every pair against what the calendar will actually paint', () => {
    const results = checkCalendarContrast(DEFAULT_TOKENS);
    expect(results.map((r) => r.pair.id)).toEqual(CALENDAR_CONTRAST_PAIRS.map((p) => p.id));
    for (const r of results) {
      expect(isHexColor(r.fgColor)).toBe(true);
      expect(isHexColor(r.bgColor)).toBe(true);
      expect(r.passes).toBe(r.ratio >= r.pair.minRatio);
    }
  });

  it('scores a missing or unusable token as the default it will render with', () => {
    const broken = {
      ...DEFAULT_TOKENS,
      colors: { ...DEFAULT_TOKENS.colors, calendarHeaderBackground: 'rebeccapurple' },
      advanced: { calendarEventHoverBackground: '' },
    } as unknown as ThemeTokens;
    expect(resolveCalendarColor(broken, 'calendarHeaderBackground'))
      .toBe(DEFAULT_TOKENS.colors.calendarHeaderBackground);
    expect(resolveCalendarColor(broken, 'calendarEventHoverBackground'))
      .toBe(DEFAULT_ADVANCED.calendarEventHoverBackground);
    // A pre-#559 theme carries no calendar keys at all.
    const legacy = { ...DEFAULT_TOKENS, colors: {}, advanced: undefined } as unknown as ThemeTokens;
    expect(resolveCalendarColor(legacy, 'calendarDayText')).toBe(DEFAULT_TOKENS.colors.calendarDayText);
  });

  it('flags a combination an admin makes unreadable', () => {
    const unreadable = {
      ...DEFAULT_TOKENS,
      colors: { ...DEFAULT_TOKENS.colors, calendarHeaderText: '#f0f0f0', calendarHeaderBackground: '#ffffff' },
    } as ThemeTokens;
    const result = checkCalendarContrast(unreadable).find((r) => r.pair.id === 'header_text')!;
    expect(result.passes).toBe(false);
    expect(result.ratio).toBeLessThan(AA_TEXT_RATIO);
  });

  it('records exactly which shipped defaults fall short of AA', () => {
    // Locks in the defaults' accessibility, so changing one is a deliberate
    // act. The single shortfall is the event text on the event background:
    // white on #6c63ff is 4.32:1, just under AA. That purple is the color
    // `scheduled` events were already painted with before #559, and the
    // ticket requires an unconfigured calendar to keep its current
    // appearance — so the default stands and the report says so instead.
    const failing = checkCalendarContrast(DEFAULT_TOKENS).filter((r) => !r.passes);
    expect(failing.map((r) => r.pair.id)).toEqual(['event_text']);
    expect(failing[0].ratio).toBeCloseTo(4.32, 2);
  });
});

describe('Calendar contrast report in the theme editors (#559 stage 4)', () => {
  const editorSrc = readFileSync(join(__dirname, '..', 'components', 'ThemeTokensEditor.tsx'), 'utf-8');

  it('renders under the Calendar section of the shared editor', () => {
    // One shared renderer means both the Base Themes and the Custom Themes
    // editor get the report, the same way they get the section itself.
    expect(editorSrc).toContain('checkCalendarContrast');
    expect(editorSrc).toMatch(/groupKey === 'group_calendar' && <CalendarContrastReport/);
  });

  it('never blocks a save — it only reports', () => {
    // The report reads the draft and renders; it must not touch the save path.
    const start = editorSrc.indexOf('function CalendarContrastReport');
    const body = editorSrc.slice(start, editorSrc.indexOf('\n}\n', start));
    expect(body, 'CalendarContrastReport was not found in the editor').toContain('checkCalendarContrast');
    expect(body, 'the contrast report must not write to the theme').not.toContain('onChange');
    // And the API-side validator stays a pure format check.
    const apiValidator = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'api', 'src', 'domain', 'themeTokens.ts'), 'utf-8');
    expect(apiValidator).not.toMatch(/contrast/i);
  });

  it('translates its three labels in every locale and namespace', () => {
    for (const key of ['calendar_contrast_title', 'calendar_contrast_summary', 'calendar_contrast_min']) {
      for (const locale of LOCALE_CODES) {
        for (const ns of NAMESPACES) {
          expect(locales[locale][ns][key], `${locale}.${ns}.${key} missing`).toBeTruthy();
        }
      }
    }
  });
});

describe('Calendar focus indicators (#559 stage 4)', () => {
  it('draws a focus ring on a keyboard-focused event, from the event text token', () => {
    expect(CALENDAR_THEME_CSS).toMatch(
      /\.gd-calendar \.fc \.fc-event:focus-visible \{[^}]*outline: 2px solid var\(--gd-calendar-event-text/);
    // Inside the box, so a neighbouring event can't clip it.
    expect(CALENDAR_THEME_CSS).toMatch(
      /\.fc-event:focus-visible \{[^}]*outline-offset: -2px/);
  });

  it('replaces the nav buttons\' untheme-able focus shadow with a themed outline', () => {
    const rule = CALENDAR_THEME_CSS.split('}').find((b) => b.includes('.fc-button:focus-visible'))!;
    expect(rule).toContain('outline: 2px solid var(--gd-calendar-day-text');
    expect(rule).toContain('outline-offset: 2px');
    // FullCalendar's own shadow is keyed to its default button color, so it
    // has to go rather than sit under the new ring.
    expect(rule).toContain('box-shadow: none');
    // …including at the higher specificity FullCalendar declares it with for
    // an active button, which a plain `:focus` selector would lose to.
    expect(rule).toContain('.fc-button-primary:not(:disabled):active:focus');
  });

  it('keeps the selected/focused event overlay from stage 3', () => {
    expect(CALENDAR_THEME_CSS).toContain('.gd-calendar .fc .fc-event:focus:after');
  });

  it('is mirrored byte-for-byte in Member Web', () => {
    const memberCss = readFileSync(
      join(__dirname, '..', '..', '..', 'member', 'src', 'components', 'CalendarThemeStyles.tsx'), 'utf-8');
    for (const marker of [':focus-visible', 'outline-offset: -2px', 'box-shadow: none']) {
      expect(memberCss, `Member Web's sheet is missing "${marker}"`).toContain(marker);
    }
  });
});

describe('Unusable calendar token values (#559 stage 4)', () => {
  let written: Record<string, string>;

  beforeEach(() => { written = stubDocument(); });
  afterEach(() => { delete (globalThis as any).document; });

  it('knows which calendar advanced attributes are colors', () => {
    expect([...CALENDAR_ADVANCED_COLOR_KEYS].sort())
      .toEqual(calendarAdvanced.filter((a) => a.type === 'color').map((a) => a.key).sort());
  });

  it('falls back to the default instead of writing a value CSS cannot use', () => {
    applyTokens({
      ...DEFAULT_TOKENS,
      colors: {
        ...DEFAULT_TOKENS.colors,
        calendarSurfaceBackground: 'white',   // a valid CSS color, but not the #rrggbb the pickers emit
        calendarEventBackground: '',
        calendarGridBorder: null,
      },
      advanced: {
        calendarEventHoverBackground: 'not-a-color',
        calendarSlotHeight: '   ',
        calendarNavButtonBorderRadius: 4,     // a bare number is not a CSS length
      },
    } as unknown as ThemeTokens);
    expect(written['--gd-calendar-surface-bg']).toBe(DEFAULT_TOKENS.colors.calendarSurfaceBackground);
    expect(written['--gd-calendar-event-bg']).toBe(DEFAULT_TOKENS.colors.calendarEventBackground);
    expect(written['--gd-calendar-grid-border']).toBe(DEFAULT_TOKENS.colors.calendarGridBorder);
    expect(written['--gd-calendar-event-hover-bg']).toBe(DEFAULT_ADVANCED.calendarEventHoverBackground);
    expect(written['--gd-calendar-slot-height']).toBe(DEFAULT_ADVANCED.calendarSlotHeight);
    expect(written['--gd-calendar-nav-btn-radius']).toBe(DEFAULT_ADVANCED.calendarNavButtonBorderRadius);
  });

  it('still writes a usable configured value through untouched', () => {
    applyTokens({
      ...DEFAULT_TOKENS,
      colors: { ...DEFAULT_TOKENS.colors, calendarEventBackground: '#123456' },
      advanced: { calendarSlotHeight: '2.25em', calendarEventSelectedOverlay: '#ABCDEF' },
    } as ThemeTokens);
    expect(written['--gd-calendar-event-bg']).toBe('#123456');
    expect(written['--gd-calendar-slot-height']).toBe('2.25em');
    expect(written['--gd-calendar-event-selected-overlay']).toBe('#ABCDEF');
  });
});
