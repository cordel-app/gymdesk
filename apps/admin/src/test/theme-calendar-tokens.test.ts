import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { COLOR_GROUPS } from '../components/ThemeTokensEditor';
import { ADVANCED_ATTRIBUTES, DEFAULT_ADVANCED, DEFAULT_TOKENS } from '../lib/themeTokens';

// #559 stages 1 & 3 — the Calendar section in the Base Themes and Custom
// Themes editors: the tokens, their defaults, and the editor section. Their
// wiring to --gd-calendar-* CSS variables and to FullCalendar landed in stage
// 2 and is covered separately by theme-calendar-css.test.ts; the status pill
// badge stage 3 adds is covered by calendar-status-badge.test.ts.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const NAMESPACES = ['themes', 'gym_themes'] as const;
const HEX_RE = /^#[0-9a-f]{6}$/i;

type Messages = Record<string, Record<string, unknown>>;

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Messages>;

const calendarGroup = COLOR_GROUPS.find((g) => g.groupKey === 'group_calendar');
const calendarAdvanced = ADVANCED_ATTRIBUTES.filter((a) => a.group === 'group_calendar');

describe('Calendar theme section (#559 stage 1)', () => {
  it('is registered as a color group in the shared theme editor', () => {
    expect(calendarGroup, 'COLOR_GROUPS has no group_calendar entry').toBeDefined();
    expect(calendarGroup!.fields.length).toBeGreaterThan(0);
  });

  it('renders in BOTH the Base Themes and Custom Themes editors', () => {
    // Both pages get the section from the same shared renderer, which maps over
    // COLOR_GROUPS — that shared import is the mechanism, so assert it directly
    // rather than duplicating the group list per page.
    const pages = {
      'Base Themes': join(__dirname, '..', 'app', '[locale]', 'system', 'themes', 'page.tsx'),
      'Custom Themes': join(__dirname, '..', 'app', '[locale]', 'themes', 'page.tsx'),
    };
    for (const [label, path] of Object.entries(pages)) {
      const src = readFileSync(path, 'utf-8');
      expect(src, `${label} no longer renders the shared ThemeColorsEditor`).toContain('ThemeColorsEditor');
      expect(src, `${label} no longer imports from ThemeTokensEditor`).toContain('@/components/ThemeTokensEditor');
    }
  });

  it('gives every calendar color field a valid hex default', () => {
    for (const { key } of calendarGroup!.fields) {
      const value = DEFAULT_TOKENS.colors[key];
      expect(value, `DEFAULT_TOKENS.colors.${key} is missing`).toBeTypeOf('string');
      expect(String(value), `DEFAULT_TOKENS.colors.${key} is not a #rrggbb hex`).toMatch(HEX_RE);
    }
  });

  it('gives every calendar advanced attribute a default value', () => {
    expect(calendarAdvanced.length).toBeGreaterThan(0);
    for (const attr of calendarAdvanced) {
      expect(DEFAULT_ADVANCED[attr.key], `DEFAULT_ADVANCED.${attr.key} is missing`).toBeDefined();
    }
  });

  it('exposes the event color tokens added in stage 3', () => {
    const keys = calendarGroup!.fields.map((f) => f.key as string);
    expect(keys).toContain('calendarEventBackground');
    expect(keys).toContain('calendarEventBorder');
    expect(keys).toContain('calendarEventText');
  });

  // next-intl has no locale fallback (apps/admin/src/i18n.ts), so a key present
  // in en.json but missing from es.json/ca.json renders as its raw dotted key
  // path. Both theme editors use their own namespace, hence the 2x sweep.
  it.each(LOCALE_CODES)('has the Calendar group title in %s for both theme namespaces', (code) => {
    for (const ns of NAMESPACES) {
      const value = locales[code][ns]?.group_calendar;
      expect(value, `${code}.json is missing ${ns}.group_calendar`).toBeTypeOf('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it('has every calendar color label translated in every locale and namespace', () => {
    for (const { labelKey } of calendarGroup!.fields) {
      for (const code of LOCALE_CODES) {
        for (const ns of NAMESPACES) {
          const value = locales[code][ns]?.[labelKey];
          expect(value, `${code}.json is missing ${ns}.${labelKey}`).toBeTypeOf('string');
          expect((value as string).length, `${code}.json has an empty ${ns}.${labelKey}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('has every calendar advanced label translated in every locale and namespace', () => {
    for (const { labelKey } of calendarAdvanced) {
      for (const code of LOCALE_CODES) {
        for (const ns of NAMESPACES) {
          const value = locales[code][ns]?.[labelKey];
          expect(value, `${code}.json is missing ${ns}.${labelKey}`).toBeTypeOf('string');
          expect((value as string).length, `${code}.json has an empty ${ns}.${labelKey}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('leaves every pre-existing theme token untouched (backward compatibility)', () => {
    // #559 must not change how existing themes look: the only new keys in
    // DEFAULT_TOKENS.colors are the calendar ones.
    const calendarKeys = new Set(calendarGroup!.fields.map((f) => f.key as string));
    const nonCalendar = Object.keys(DEFAULT_TOKENS.colors).filter((k) => !calendarKeys.has(k));
    expect(nonCalendar).toContain('pageBackground');
    expect(nonCalendar.some((k) => k.startsWith('calendar'))).toBe(false);
  });
});
