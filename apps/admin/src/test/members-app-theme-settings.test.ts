import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MEMBERS_APP_SECTIONS,
  MEMBERS_APP_SETTINGS,
  adminSourceValue,
  effectiveMembersAppValue,
  isMembersAppOverridden,
  membersAppCssVars,
  membersAppSettingsFor,
  withMembersAppInherited,
  withMembersAppOverride,
} from '../lib/membersAppTokens';
import {
  ADVANCED_ATTRIBUTES,
  DEFAULT_ADVANCED,
  DEFAULT_TOKENS,
  FONT_STACK_VALUES,
  type ThemeTokens,
} from '../lib/themeTokens';

// #833 — Members App theme settings with per-setting inheritance from the
// Admin settings.
//
// This repo has no component-test infra for apps/admin (see
// docs/architecture.md's TL;DR), so the declaration and the resolution rules
// are asserted directly and the editor's structure is pinned down by scanning
// its source and the locale files — the same shape theme-colors-collapsible.ts
// (#632) uses.

const COMPONENT_PATH = join(__dirname, '..', 'components', 'ThemeMembersAppEditor.tsx');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const NAMESPACES = ['themes', 'gym_themes'] as const;
const PAGES = {
  'Custom Themes': join(__dirname, '..', 'app', '[locale]', 'themes', 'page.tsx'),
  'Base Themes': join(__dirname, '..', 'app', '[locale]', 'system', 'themes', 'page.tsx'),
};
// The two mirrors of the declaration: the Members App resolves the effective
// values, the API validates what may be written.
const MEMBER_MIRROR = join(__dirname, '..', '..', '..', 'member', 'src', 'lib', 'membersAppTokens.ts');
const API_MIRROR = join(__dirname, '..', '..', '..', '..', 'api', 'src', 'domain', 'membersAppTokens.ts');

// The component's own comments name the ticket and describe what it must not
// do, so the structural scans below run on comment-free code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const componentSrc = stripComments(readFileSync(COMPONENT_PATH, 'utf-8'));
const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, unknown>>>;

/** §8's mapping, transcribed from the ticket — Members App setting → Admin source label. */
const TICKET_MAPPING: [string, string][] = [
  ['label_members_header_color', 'Header Background'],
  ['label_members_header_text_color', 'Header Text'],
  ['label_members_header_text_font', 'Header text font'],
  ['label_members_header_sep_color', 'Header Separator Color'],
  ['label_members_header_sep_width', 'Separator Height (px)'],
  ['label_members_background_color', 'Page Background'],
  ['label_members_card_border_color', 'Card Border'],
  ['label_members_card_border_width', 'Card border width'],
  ['label_members_title1_color', 'Typography h1 Color'],
  ['label_members_title2_color', 'Typography h2 Color'],
  ['label_members_title3_color', 'Typography h3 Color'],
  ['label_members_calendar_bg', 'Calendar background'],
  ['label_members_calendar_header_color', 'Calendar header background'],
  ['label_members_calendar_buttons_color', 'Navigation button background'],
  ['label_members_calendar_time_col_bg', 'Time column background'],
  ['label_members_calendar_time_col_text', 'Time column text'],
  ['label_members_calendar_modal_bg', 'Modal Background'],
  ['label_members_calendar_modal_input_bg', 'Input Background Color'],
];

describe('#833 Members App settings: the declaration', () => {
  it('declares the five sections the ticket names, in order', () => {
    expect(MEMBERS_APP_SECTIONS).toEqual([
      'group_members_header',
      'group_members_background',
      'group_members_section_cards',
      'group_members_text',
      'group_members_calendar',
    ]);
    // Every section has at least one setting, and every setting belongs to one
    // of them — so a setting can never be declared into a section that is
    // never rendered.
    for (const section of MEMBERS_APP_SECTIONS) {
      expect(membersAppSettingsFor(section).length, `${section} renders nothing`).toBeGreaterThan(0);
    }
    for (const setting of MEMBERS_APP_SETTINGS) {
      expect(MEMBERS_APP_SECTIONS).toContain(setting.section);
    }
  });

  it('covers every row of §8, with the Admin source the ticket names', () => {
    expect(MEMBERS_APP_SETTINGS).toHaveLength(TICKET_MAPPING.length);
    const en = locales.en.gym_themes as Record<string, string>;
    for (const [labelKey, sourceLabel] of TICKET_MAPPING) {
      const setting = MEMBERS_APP_SETTINGS.find((s) => s.labelKey === labelKey);
      expect(setting, `no Members App setting labelled ${labelKey}`).toBeDefined();
      expect(en[setting!.source.labelKey], `${labelKey} has no label for its source`).toBe(sourceLabel);
    }
  });

  it('gives every setting one CSS variable of its own', () => {
    const vars = MEMBERS_APP_SETTINGS.map((s) => s.cssVar);
    expect(new Set(vars).size, 'two Members App settings share one CSS variable').toBe(vars.length);
    const keys = MEMBERS_APP_SETTINGS.map((s) => s.key);
    expect(new Set(keys).size, 'two settings share one override key').toBe(keys.length);
  });

  it('points every setting at an Admin setting that exists', () => {
    for (const { key, source } of MEMBERS_APP_SETTINGS) {
      if (source.kind === 'color') {
        expect(
          (DEFAULT_TOKENS.colors as Record<string, unknown>)[source.key as string],
          `${key} inherits from a colour token that does not exist`,
        ).toBeDefined();
      } else if (source.kind === 'advanced') {
        expect(DEFAULT_ADVANCED[source.key], `${key} inherits from an advanced attribute with no default`).toBeDefined();
        expect(
          ADVANCED_ATTRIBUTES.some((a) => a.key === source.key),
          `${key} inherits from ${source.key}, which the Admin editor does not expose`,
        ).toBe(true);
      } else {
        expect(DEFAULT_TOKENS.typography[source.level].color).toBeDefined();
      }
    }
  });

  it('adds the two Admin sources §2 and §4 asked for, wired to a real CSS variable', () => {
    // Header Text Font (§2) and Card Border Width (§4) did not exist. Both are
    // exposed in the Admin editor beside the settings they belong to, and both
    // reach a CSS variable — an editable attribute no variable carries would
    // be a setting that changes nothing (the #677 defect).
    const font = ADVANCED_ATTRIBUTES.find((a) => a.key === 'headerTextFont');
    expect(font?.group).toBe('group_header');
    expect(font?.type).toBe('select');
    expect(font?.options).toEqual(FONT_STACK_VALUES);
    const width = ADVANCED_ATTRIBUTES.find((a) => a.key === 'cardBorderWidth');
    expect(width?.group).toBe('group_cards');
    expect(width?.type).toBe('text');

    const themeTokensSrc = readFileSync(join(__dirname, '..', 'lib', 'themeTokens.ts'), 'utf-8');
    expect(themeTokensSrc).toContain("'--gd-header-font'");
    expect(themeTokensSrc).toContain("cardBorderWidth: '--gd-card-border-width'");
    const uiSrc = readFileSync(join(__dirname, '..', 'components', 'ui.tsx'), 'utf-8');
    expect(uiSrc, 'the card border width never reaches a card').toContain('var(--gd-card-border-width, 1px) solid');
  });

  it('reuses the existing Admin equivalents rather than duplicating them (§7, §14)', () => {
    // "Application Surface" and "Input Background" are the two §14 flagged as
    // possibly missing. Both already existed, so the modal settings inherit
    // from them instead of from new duplicates — and never from Calendar
    // Background, which §7 rules out explicitly.
    const modal = MEMBERS_APP_SETTINGS.find((s) => s.key === 'calendarModalBackgroundColor')!;
    expect(modal.source).toEqual({ kind: 'advanced', key: 'modalBackground', labelKey: 'adv_modal_bg' });
    const input = MEMBERS_APP_SETTINGS.find((s) => s.key === 'calendarModalInputBackgroundColor')!;
    expect(input.source).toEqual({ kind: 'color', key: 'inputBackgroundColor', labelKey: 'label_input_background_color' });
    for (const key of ['calendarModalBackgroundColor', 'calendarModalInputBackgroundColor']) {
      const setting = MEMBERS_APP_SETTINGS.find((s) => s.key === key)!;
      expect(setting.cssVar, 'the modal shares the calendar background variable')
        .not.toBe(MEMBERS_APP_SETTINGS.find((s) => s.key === 'calendarBackgroundColor')!.cssVar);
    }
    // §6 — the time column stays a separate surface from the calendar itself.
    expect(MEMBERS_APP_SETTINGS.find((s) => s.key === 'calendarTimeColumnBackgroundColor')!.cssVar)
      .not.toBe(MEMBERS_APP_SETTINGS.find((s) => s.key === 'calendarBackgroundColor')!.cssVar);
  });
});

describe('#833 Members App settings: inheritance', () => {
  const clean = DEFAULT_TOKENS;

  it('inherits every setting on a Theme that overrides nothing (§13)', () => {
    expect((clean as ThemeTokens).membersApp).toBeUndefined();
    for (const setting of MEMBERS_APP_SETTINGS) {
      expect(isMembersAppOverridden(clean, setting.key)).toBe(false);
      expect(effectiveMembersAppValue(clean, setting)).toBe(adminSourceValue(clean, setting.source));
    }
  });

  it('follows the current Admin value rather than a snapshot (§13, §18)', () => {
    const header = MEMBERS_APP_SETTINGS.find((s) => s.key === 'headerColor')!;
    const edited = { ...clean, colors: { ...clean.colors, headerBackground: '#eeeeee' } } as ThemeTokens;
    expect(effectiveMembersAppValue(edited, header)).toBe('#eeeeee');
    expect(membersAppCssVars(edited)['--gd-members-header-bg']).toBe('#eeeeee');
  });

  it('overrides one setting and leaves every other inherited (§10, §12)', () => {
    const next = withMembersAppOverride(clean, 'headerColor', '#000000');
    expect(next.membersApp).toEqual({ headerColor: '#000000' });
    for (const setting of MEMBERS_APP_SETTINGS) {
      expect(isMembersAppOverridden(next, setting.key)).toBe(setting.key === 'headerColor');
    }
    // An Admin edit no longer reaches the overridden one, and still reaches
    // the others.
    const adminEdited = {
      ...next,
      colors: { ...next.colors, headerBackground: '#eeeeee', headerText: '#123456' },
    } as ThemeTokens;
    expect(effectiveMembersAppValue(adminEdited, MEMBERS_APP_SETTINGS.find((s) => s.key === 'headerColor')!)).toBe('#000000');
    expect(effectiveMembersAppValue(adminEdited, MEMBERS_APP_SETTINGS.find((s) => s.key === 'headerTextColor')!)).toBe('#123456');
  });

  it('restores inheritance by removing the override, not by storing the Admin value (§11, §19)', () => {
    const overridden = withMembersAppOverride(clean, 'headerColor', '#000000');
    const restored = withMembersAppInherited(overridden, 'headerColor');
    // No `membersApp` map at all once nothing is overridden, so "inherited"
    // never reaches the database as a value.
    expect(restored.membersApp).toBeUndefined();
    expect(isMembersAppOverridden(restored, 'headerColor')).toBe(false);
    expect(effectiveMembersAppValue(restored, MEMBERS_APP_SETTINGS.find((s) => s.key === 'headerColor')!))
      .toBe(clean.colors.headerBackground);
    // Restoring one leaves the others overridden.
    const two = withMembersAppOverride(withMembersAppOverride(clean, 'headerColor', '#000000'), 'headerTextColor', '#ffffff');
    expect(withMembersAppInherited(two, 'headerColor').membersApp).toEqual({ headerTextColor: '#ffffff' });
  });

  it('treats an explicit null as inherited', () => {
    const nulled = { ...clean, membersApp: { headerColor: null } } as ThemeTokens;
    expect(isMembersAppOverridden(nulled, 'headerColor')).toBe(false);
    expect(membersAppCssVars(nulled)['--gd-members-header-bg']).toBe(clean.colors.headerBackground);
  });

  it('falls back to the inherited value for a stored value that is unusable', () => {
    const broken = {
      ...clean,
      membersApp: {
        headerColor: 'blue-ish',
        headerTextFont: 'Comic Sans',
        sectionCardsBorderWidth: '   ',
        headerSeparatorWidth: 99,
      },
    } as unknown as ThemeTokens;
    const vars = membersAppCssVars(broken);
    expect(vars['--gd-members-header-bg']).toBe(clean.colors.headerBackground);
    expect(vars['--gd-members-header-font']).toBe(DEFAULT_ADVANCED.headerTextFont);
    expect(vars['--gd-members-card-border-width']).toBe(DEFAULT_ADVANCED.cardBorderWidth);
    expect(vars['--gd-header-sep-height']).toBe(`${clean.colors.headerSeparatorHeight}px`);
  });

  it('resolves a Theme saved before this ticket, with no advanced map at all', () => {
    const legacy = { ...clean } as ThemeTokens;
    delete (legacy as any).advanced;
    const vars = membersAppCssVars(legacy);
    expect(vars['--gd-members-header-font']).toBe(DEFAULT_ADVANCED.headerTextFont);
    expect(vars['--gd-members-card-border-width']).toBe(DEFAULT_ADVANCED.cardBorderWidth);
    expect(vars['--gd-members-calendar-modal-bg']).toBe(DEFAULT_ADVANCED.modalBackground);
  });
});

describe('#833 Members App settings: the editor', () => {
  it('renders one collapsible section per Members App section, from the shared list', () => {
    expect(componentSrc).toMatch(/MEMBERS_APP_SECTIONS\.map\(\(sectionKey\)/);
    expect(componentSrc).toContain('const open = openSections.has(sectionKey)');
    const header = componentSrc.match(/<button[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(header).toContain('type="button"');
    expect(header).toContain('aria-expanded={open}');
    expect(header, 'the section header does not render its name').toContain('{t(sectionKey)}');
    // Independent sections, not an accordion.
    expect(componentSrc).toMatch(/useState<Set<string>>\(new Set\(\)\)/);
  });

  it('shows, for every inherited setting, which Admin setting it comes from (§9)', () => {
    expect(componentSrc).toContain("t('members_inherited_from')");
    expect(componentSrc).toContain('t(setting.source.labelKey)');
    expect(componentSrc).toContain("t('members_custom_value')");
  });

  it('offers Restore inherited value per setting, and only when overridden (§11)', () => {
    expect(componentSrc).toContain("t('members_restore_inherited')");
    expect(componentSrc).toMatch(/overridden && !readOnly && \(/);
    expect(componentSrc).toContain('withMembersAppInherited(tokens, setting.key)');
    // Editing writes exactly one override.
    expect(componentSrc).toContain('withMembersAppOverride(tokens, setting.key, next)');
  });

  it('participates in the Theme editor’s own Save/Cancel and dirty state (§17)', () => {
    // It only ever calls `onChange` with a new token draft — no endpoint, no
    // save state, no fetch of its own — so the page's existing Save/Cancel and
    // `isDirty()` cover these settings, restoring inheritance included.
    expect(componentSrc).not.toContain('fetch(');
    expect(componentSrc).not.toContain('apiFetch');
    expect(componentSrc).not.toMatch(/\/api\//);
    expect(componentSrc).not.toContain('useEffect');
    expect(componentSrc, 'the editor persists on its own').not.toContain('saving');
    for (const [label, path] of Object.entries(PAGES)) {
      const src = readFileSync(path, 'utf-8');
      // Matched as a pattern rather than one line since #1038, which hands the
      // editor its `images` subsection and so wraps the call over several
      // lines. What is asserted is unchanged: the props are the page's own
      // token draft and its `updateTokens`.
      expect(src, `${label} tokens are not the draft the editor edits`)
        .toMatch(/<ThemeMembersAppEditor\s+tokens=\{editForm\.tokens\}\s+onChange=\{updateTokens\}/);
    }
  });

  it('builds no Members App preview (§16)', () => {
    for (const needle of ['iframe', 'preview', 'Preview']) {
      expect(componentSrc, `the editor introduces a ${needle}`).not.toContain(needle);
    }
  });

  it('is the one editor both Theme screens render (§15)', () => {
    for (const [label, path] of Object.entries(PAGES)) {
      const src = readFileSync(path, 'utf-8');
      expect(src, `${label} does not render the shared Members App editor`).toContain('ThemeMembersAppEditor');
      expect(src).toContain("t('section_members_app')");
    }
    // The Custom Themes screen shows a Base Theme read-only, as it does for
    // every other section (#678).
    const custom = readFileSync(PAGES['Custom Themes'], 'utf-8');
    expect(custom).toMatch(/<ThemeMembersAppEditor\s+tokens=\{editForm\.tokens\}\s+onChange=\{updateTokens\}\s+t=\{t\}\s+readOnly=\{isBase\}/);
  });

  it('has every label in every locale, in both namespaces', () => {
    const needed = [
      'section_members_app',
      'members_inherited_from',
      'members_custom_value',
      'members_restore_inherited',
      'adv_header_text_font',
      'adv_card_border_width',
      ...MEMBERS_APP_SECTIONS,
      ...MEMBERS_APP_SETTINGS.map((s) => s.labelKey),
      ...MEMBERS_APP_SETTINGS.map((s) => s.source.labelKey),
    ];
    for (const code of LOCALE_CODES) {
      for (const ns of NAMESPACES) {
        const keys = locales[code][ns] as Record<string, unknown>;
        expect(keys, `${code}.json has no "${ns}" namespace`).toBeDefined();
        for (const key of needed) {
          expect(keys[key], `${code}.json is missing ${ns}.${key}`).toBeDefined();
        }
      }
    }
  });

  it('keeps the "(Members App)" suffix on every section name (§1)', () => {
    const en = locales.en.gym_themes as Record<string, string>;
    for (const section of MEMBERS_APP_SECTIONS) {
      expect(en[section]).toContain('(Members App)');
    }
  });
});

describe('#833 Members App settings: the mirrors', () => {
  const memberSrc = readFileSync(MEMBER_MIRROR, 'utf-8');
  const apiSrc = readFileSync(API_MIRROR, 'utf-8');

  it('declares every setting in the Members App copy, with the same source and variable', () => {
    for (const { key, cssVar, type, source } of MEMBERS_APP_SETTINGS) {
      expect(memberSrc, `the Members App mirror has no ${key}`).toContain(`key: '${key}'`);
      expect(memberSrc, `the Members App mirror does not write ${cssVar}`).toContain(`cssVar: '${cssVar}'`);
      expect(memberSrc, `the Members App mirror has no ${type} setting`).toContain(`type: '${type}'`);
      if (source.kind !== 'typography') {
        expect(memberSrc).toContain(`key: '${source.key}', labelKey: '${source.labelKey}'`);
      } else {
        expect(memberSrc).toContain(`level: '${source.level}', labelKey: '${source.labelKey}'`);
      }
    }
  });

  it('accepts every setting on the API side, with the same type', () => {
    for (const { key, type } of MEMBERS_APP_SETTINGS) {
      expect(apiSrc, `the API rejects ${key}`).toMatch(new RegExp(`${key}:\\s*'${type}'`));
    }
  });

  it('keeps the advanced-source defaults the Members App needs in step with Admin', () => {
    for (const key of ['headerTextFont', 'cardBorderWidth', 'modalBackground']) {
      expect(memberSrc).toContain(`${key}: '${DEFAULT_ADVANCED[key]}'`);
    }
    for (const value of FONT_STACK_VALUES) {
      expect(memberSrc, `the Members App mirror does not allow ${value}`).toContain(value);
    }
  });
});
