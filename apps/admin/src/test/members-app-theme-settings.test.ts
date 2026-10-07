import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MEMBERS_APP_FONT_SIZE,
  MEMBERS_APP_HORIZONTAL_ALIGNMENTS,
  MEMBERS_APP_SECTIONS,
  MEMBERS_APP_SETTINGS,
  MEMBERS_APP_VERTICAL_ALIGNMENTS,
  adminSourceValue,
  alignmentCssValue,
  effectiveMembersAppValue,
  inheritedMembersAppValue,
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

/**
 * §8's mapping, transcribed from the ticket — Members App setting → Admin
 * source label — plus #1152's eight: the three Title fonts and the five
 * Section Cards text settings, of which the size and the two positions
 * inherit from nothing (`null`) because the Admin theme has no counterpart.
 */
const TICKET_MAPPING: [string, string | null][] = [
  ['label_members_header_color', 'Header Background'],
  ['label_members_header_text_color', 'Header Text'],
  ['label_members_header_text_font', 'Header text font'],
  ['label_members_header_sep_color', 'Header Separator Color'],
  ['label_members_header_sep_width', 'Separator Height (px)'],
  ['label_members_background_color', 'Page Background'],
  ['label_members_card_border_color', 'Card Border'],
  ['label_members_card_border_width', 'Card border width'],
  ['label_members_card_text_color', 'Primary Text Color'],
  ['label_members_card_text_size', null],
  ['label_members_card_text_font', 'Typography body Font Family'],
  ['label_members_card_text_vertical', null],
  ['label_members_card_text_horizontal', null],
  ['label_members_title1_color', 'Typography h1 Color'],
  ['label_members_title1_font', 'Typography h1 Font Family'],
  ['label_members_title2_color', 'Typography h2 Color'],
  ['label_members_title2_font', 'Typography h2 Font Family'],
  ['label_members_title3_color', 'Typography h3 Color'],
  ['label_members_title3_font', 'Typography h3 Font Family'],
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
      if (sourceLabel === null) {
        expect(setting!.source, `${labelKey} inherits from something`).toBeNull();
        expect(setting!.default, `${labelKey} inherits from nothing and declares no default`).toBeDefined();
      } else {
        expect(setting!.source, `${labelKey} inherits from nothing`).not.toBeNull();
        expect(en[setting!.source!.labelKey], `${labelKey} has no label for its source`).toBe(sourceLabel);
      }
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
      if (source === null) continue;
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
        expect(DEFAULT_TOKENS.typography[source.level][source.field]).toBeDefined();
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
      expect(effectiveMembersAppValue(clean, setting)).toBe(inheritedMembersAppValue(clean, setting));
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
      'members_default_value',
      'members_badge_default',
      'members_restore_default',
      ...MEMBERS_APP_VERTICAL_ALIGNMENTS.map((a) => `members_align_${a}`),
      ...MEMBERS_APP_HORIZONTAL_ALIGNMENTS.map((a) => `members_align_${a}`),
      ...MEMBERS_APP_SECTIONS,
      ...MEMBERS_APP_SETTINGS.map((s) => s.labelKey),
      ...MEMBERS_APP_SETTINGS.flatMap((s) => (s.source ? [s.source.labelKey] : [])),
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

describe('#1152 Members App typography and Section Card text', () => {
  const clean = DEFAULT_TOKENS;
  const by = (key: string) => MEMBERS_APP_SETTINGS.find((s) => s.key === key)!;

  it('renames the Text section to Typography, in every locale, and keeps its id (§1)', () => {
    // A section id is what its settings are stored and rendered under; a
    // label is renamed by its six values (#1026/#970's rule, #1151's for a slot).
    expect(MEMBERS_APP_SECTIONS).toContain('group_members_text');
    for (const ns of NAMESPACES) {
      expect(locales.en[ns].group_members_text).toBe('Typography (Members App)');
      expect(locales.es[ns].group_members_text).toBe('Tipografía (App de Miembros)');
      expect(locales.ca[ns].group_members_text).toBe('Tipografia (App de Membres)');
      expect(String(locales.en[ns].group_members_text)).not.toMatch(/^Text /);
    }
  });

  it('gives each Title a Font Family beside its Color, both halves of one typography level (§2, §5)', () => {
    for (const level of ['h1', 'h2', 'h3'] as const) {
      const n = level.slice(1);
      const color = by(`title${n}Color`);
      const font = by(`title${n}Font`);
      expect(color.source).toEqual({ kind: 'typography', level, field: 'color', labelKey: `source_typography_${level}` });
      expect(font.source).toEqual({ kind: 'typography', level, field: 'fontFamily', labelKey: `source_typography_${level}_font` });
      expect(font.type).toBe('font');
      expect(font.section).toBe('group_members_text');
      // The override writes into the level's own font variable, as the colour
      // writes into its colour variable: one variable per concept.
      expect(font.cssVar).toBe(`--gd-font-${level}`);
      expect(color.cssVar).toBe(`--gd-color-${level}`);
      // The two halves of the level render in the editor in that order.
      const keys = membersAppSettingsFor('group_members_text').map((s) => s.key);
      expect(keys.indexOf(`title${n}Font`)).toBe(keys.indexOf(`title${n}Color`) + 1);
    }
    // No second font catalogue: the font options are FONT_STACKS, which the
    // editor already renders for every `font` setting.
    expect(componentSrc).toContain('FONT_STACKS.map(');
    expect(componentSrc).not.toMatch(/MEMBERS_APP_FONTS|membersAppFonts/);
  });

  it('inherits a Title font from the Admin typography level and overrides it per Title', () => {
    const edited = {
      ...clean,
      typography: { ...clean.typography, h2: { ...clean.typography.h2, fontFamily: FONT_STACK_VALUES[1] } },
    } as ThemeTokens;
    expect(effectiveMembersAppValue(edited, by('title2Font'))).toBe(FONT_STACK_VALUES[1]);
    expect(effectiveMembersAppValue(edited, by('title1Font'))).toBe(clean.typography.h1.fontFamily);
    const over = withMembersAppOverride(edited, 'title2Font', FONT_STACK_VALUES[2]);
    expect(membersAppCssVars(over)['--gd-font-h2']).toBe(FONT_STACK_VALUES[2]);
    expect(membersAppCssVars(over)['--gd-color-h2']).toBe(clean.typography.h2.color);
  });

  it('declares the five Section Cards text settings, in the Section Cards section (§3)', () => {
    const keys = membersAppSettingsFor('group_members_section_cards').map((s) => s.key);
    expect(keys).toEqual([
      'sectionCardsBorderColor',
      'sectionCardsBorderWidth',
      'sectionCardsTextColor',
      'sectionCardsTextSize',
      'sectionCardsTextFont',
      'sectionCardsTextVertical',
      'sectionCardsTextHorizontal',
    ]);
    expect(by('sectionCardsTextColor').source).toEqual({ kind: 'color', key: 'textColor', labelKey: 'label_text_color' });
    expect(by('sectionCardsTextFont').source).toEqual({ kind: 'typography', level: 'body', field: 'fontFamily', labelKey: 'source_typography_body_font' });
    expect(by('sectionCardsTextSize')).toMatchObject({ type: 'font-size', source: null, default: 13 });
    expect(by('sectionCardsTextVertical')).toMatchObject({ type: 'align-v', source: null, default: 'center' });
    expect(by('sectionCardsTextHorizontal')).toMatchObject({ type: 'align-h', source: null, default: 'center' });
  });

  it('resolves a sourceless setting to its default, stores only an override, and restores by removing it', () => {
    const size = by('sectionCardsTextSize');
    expect(isMembersAppOverridden(clean, size.key)).toBe(false);
    expect(inheritedMembersAppValue(clean, size)).toBe(13);
    expect(effectiveMembersAppValue(clean, size)).toBe(13);
    expect(membersAppCssVars(clean)['--gd-members-card-text-size']).toBe('13px');
    const over = withMembersAppOverride(clean, size.key, 18);
    expect(over.membersApp).toEqual({ sectionCardsTextSize: 18 });
    expect(membersAppCssVars(over)['--gd-members-card-text-size']).toBe('18px');
    expect(withMembersAppInherited(over, size.key).membersApp).toBeUndefined();
  });

  it('maps a stored position to the CSS the card paints with, and falls back to the default otherwise', () => {
    expect(alignmentCssValue('align-v', 'top')).toBe('flex-start');
    expect(alignmentCssValue('align-v', 'center')).toBe('center');
    expect(alignmentCssValue('align-v', 'bottom')).toBe('flex-end');
    expect(alignmentCssValue('align-v', 'left')).toBeNull();
    expect(alignmentCssValue('align-h', 'left')).toBe('left');
    expect(alignmentCssValue('align-h', 'right')).toBe('right');
    expect(alignmentCssValue('align-h', 'top')).toBeNull();
    const vars = membersAppCssVars({
      ...clean,
      membersApp: { sectionCardsTextVertical: 'bottom', sectionCardsTextHorizontal: 'left' },
    } as ThemeTokens);
    expect(vars['--gd-members-card-text-vertical']).toBe('flex-end');
    expect(vars['--gd-members-card-text-horizontal']).toBe('left');
    const broken = membersAppCssVars({
      ...clean,
      membersApp: { sectionCardsTextVertical: 'left', sectionCardsTextHorizontal: 'up', sectionCardsTextSize: 400 },
    } as unknown as ThemeTokens);
    expect(broken['--gd-members-card-text-vertical']).toBe('center');
    expect(broken['--gd-members-card-text-horizontal']).toBe('center');
    expect(broken['--gd-members-card-text-size']).toBe('13px');
  });

  it('bounds the text size as the API does', () => {
    expect(MEMBERS_APP_FONT_SIZE).toEqual({ min: 8, max: 48 });
    const apiSrc = readFileSync(API_MIRROR, 'utf-8');
    expect(apiSrc).toContain('MEMBERS_APP_FONT_SIZE = { min: 8, max: 48 }');
    expect(apiSrc).toContain("MEMBERS_APP_VERTICAL_ALIGNMENTS = ['top', 'center', 'bottom']");
    expect(apiSrc).toContain("MEMBERS_APP_HORIZONTAL_ALIGNMENTS = ['left', 'center', 'right']");
  });

  it('offers the two positions as the declared sets and the size inside its bounds, in the one editor', () => {
    expect(componentSrc).toContain("setting.type === 'align-v' ? MEMBERS_APP_VERTICAL_ALIGNMENTS : MEMBERS_APP_HORIZONTAL_ALIGNMENTS");
    expect(componentSrc).toContain('t(`members_align_${o}`)');
    expect(componentSrc).toContain('min={MEMBERS_APP_FONT_SIZE.min}');
    expect(componentSrc).toContain('max={MEMBERS_APP_FONT_SIZE.max}');
    // A sourceless setting says it holds its default rather than naming a
    // source it does not have, and restores to that default.
    expect(componentSrc).toContain("t('members_default_value')");
    expect(componentSrc).toContain("t('members_badge_default')");
    expect(componentSrc).toContain("setting.source ? t('members_restore_inherited') : t('members_restore_default')");
  });
});

describe('#833 Members App settings: the mirrors', () => {
  const memberSrc = readFileSync(MEMBER_MIRROR, 'utf-8');
  const apiSrc = readFileSync(API_MIRROR, 'utf-8');

  it('declares every setting in the Members App copy, with the same source and variable', () => {
    for (const setting of MEMBERS_APP_SETTINGS) {
      const { key, cssVar, type, source } = setting;
      expect(memberSrc, `the Members App mirror has no ${key}`).toContain(`key: '${key}'`);
      expect(memberSrc, `the Members App mirror does not write ${cssVar}`).toContain(`cssVar: '${cssVar}'`);
      expect(memberSrc, `the Members App mirror has no ${type} setting`).toContain(`type: '${type}'`);
      if (source === null) {
        // A sourceless setting's default is what the Members App paints while
        // nothing overrides it, so the two copies must agree on it.
        const dflt = typeof setting.default === 'string' ? `'${setting.default}'` : String(setting.default);
        expect(memberSrc, `the Members App mirror has another default for ${key}`)
          .toMatch(new RegExp(`key: '${key}',[\\s\\S]*?source: null,\\s*default: ${dflt},`));
      } else if (source.kind !== 'typography') {
        expect(memberSrc).toContain(`key: '${source.key}', labelKey: '${source.labelKey}'`);
      } else {
        expect(memberSrc).toContain(`level: '${source.level}', field: '${source.field}', labelKey: '${source.labelKey}'`);
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
