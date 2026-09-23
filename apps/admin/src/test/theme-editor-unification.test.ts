import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #678 — the Base Theme editor uses the same expanded editing model as the
// Custom Theme editor.
//
// Custom Themes (`[locale]/themes`) is the reference implementation: expanding
// a card opens a structured editor of collapsible sections (Assignments /
// Branding / Colors / Typography) with a Save + Cancel footer. Base Themes
// (`[locale]/system/themes`) used to expand into a read-only grid of colour
// swatches and hid every other setting behind a separate "Edit" step.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like theme-colors-collapsible.test.ts (#632) — this pins the
// structure down by scanning the page/component sources and the locale files.

const SRC = join(__dirname, '..');
const BASE_PAGE = join(SRC, 'app', '[locale]', 'system', 'themes', 'page.tsx');
const CUSTOM_PAGE = join(SRC, 'app', '[locale]', 'themes', 'page.tsx');
const SHARED = join(SRC, 'components', 'ThemeSectionEditor.tsx');
const TOKENS_EDITOR = join(SRC, 'components', 'ThemeTokensEditor.tsx');
const ADVANCED = join(SRC, 'components', 'ThemeAdvancedSection.tsx');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, Record<string, unknown>>;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(path: string): string {
  return stripComments(readFileSync(path, 'utf-8'));
}

const basePage = read(BASE_PAGE);
const customPage = read(CUSTOM_PAGE);
const shared = read(SHARED);
const tokensEditor = read(TOKENS_EDITOR);
const advanced = read(ADVANCED);

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Messages>;

// Every label the shared Branding block renders, plus the section titles both
// editors use. next-intl has no locale fallback (apps/admin/src/i18n.ts), so a
// key missing from one namespace renders as its raw dotted path.
const SHARED_KEYS = [
  'section_branding', 'section_colors', 'section_typography',
  'label_name', 'label_description', 'label_logo',
  'logo_hint', 'logo_upload', 'logo_clear', 'logo_contains_gym_name', 'logo_no_preview',
];

describe('Base Theme editor unified with the Custom Theme editor (#678)', () => {
  it('drops the Base Theme swatch-summary expanded view', () => {
    expect(basePage, 'the read-only swatch grid is still rendered').not.toContain('renderReadOnly');
    // That view was the only consumer of COLOR_GROUPS on this page — the colour
    // groups now reach it through the shared ThemeColorsEditor, like Custom Themes.
    expect(basePage).not.toContain('COLOR_GROUPS');
  });

  it('opens the structured editor as soon as a Base Theme row is expanded', () => {
    expect(basePage, 'expanding a row no longer opens the editor').toMatch(
      /function toggleExpand\(theme: Theme\)[\s\S]*?openEditor\(theme\)/,
    );
    // One expanded body, not a read-only/edit fork.
    const expanded = basePage.match(/function renderExpanded[\s\S]*?\n  }\n/)?.[0] ?? '';
    expect(expanded, 'renderExpanded could not be located').not.toBe('');
    expect(expanded).toContain('renderEditForm');
    expect(expanded, 'the expanded row still branches on an edit mode').not.toContain('editingId ===');
  });

  it('gives the Base Theme editor the Custom editor’s applicable sections', () => {
    // Assignments is gym-level (centers), so it has no platform counterpart.
    expect(basePage).toContain("type SectionKey = 'branding' | 'colors' | 'typography'");
    for (const section of ['branding', 'colors', 'typography']) {
      expect(basePage, `the ${section} section is missing`).toContain(`renderSection('${section}'`);
    }
    expect(basePage, 'Colors is no longer the only thing the expanded card exposes')
      .toContain('ThemeTypographyEditor');
    expect(basePage).toContain('ThemeBrandingEditor');
  });

  it('keeps the Custom Theme editor as it was — all four sections, unchanged', () => {
    for (const section of ['assignments', 'branding', 'colors', 'typography']) {
      expect(customPage, `the ${section} section is missing`).toContain(`, '${section}', `);
    }
    expect(customPage).toContain('renderAssignmentsContent');
    expect(customPage).toContain('handleSaveAll');
  });

  it('renders both editors from the same shared components', () => {
    for (const [label, src] of [['Base Themes', basePage], ['Custom Themes', customPage]] as const) {
      expect(src, `${label} does not use the shared section wrapper`).toContain('ThemeSection');
      expect(src, `${label} does not use the shared branding editor`).toContain('ThemeBrandingEditor');
      expect(src, `${label} does not use the shared colors editor`).toContain('ThemeColorsEditor');
      expect(src, `${label} does not use the shared typography editor`).toContain('ThemeTypographyEditor');
      expect(src, `${label} no longer imports the shared editor chrome`)
        .toContain("@/components/ThemeSectionEditor");
      // The duplicated markup each page used to carry.
      expect(src, `${label} still hand-rolls the logo file input`).not.toContain('editFileInputRef');
    }
    expect(shared).toContain('export function ThemeSection');
    expect(shared).toContain('export function ThemeBrandingEditor');
  });

  it('exposes a Base Theme’s settings read-only inside a gym rather than hiding them', () => {
    // The Custom Themes screen also lists the platform's Base Themes. They stay
    // read-only there (`PUT /system/themes/:id` only accepts this gym's themes),
    // but every section is now shown, disabled, instead of only Colors.
    expect(customPage, 'base themes still get a reduced section list')
      .not.toMatch(/isBase \? \['assignments', 'colors'\]/);
    for (const editor of ['ThemeBrandingEditor', 'ThemeColorsEditor', 'ThemeTypographyEditor']) {
      const call = customPage.match(new RegExp(`<${editor}[\\s\\S]*?/>`))?.[0] ?? '';
      expect(call, `${editor} is not rendered on the Custom Themes page`).not.toBe('');
      expect(call, `${editor} does not honour the read-only Base Theme`).toContain('readOnly={isBase}');
    }
    expect(customPage, 'the read-only hint was dropped').toContain("t('read_only_hint')");
    // Read-only means disabled controls, never a different set of controls.
    expect(shared).toContain('disabled={readOnly}');
    expect(tokensEditor).toContain('disabled={readOnly}');
    expect(advanced).toContain('disabled={readOnly}');
    expect(tokensEditor, 'advanced attributes are still hidden from a read-only theme')
      .toMatch(/<ThemeAdvancedSection[\s\S]*?readOnly=\{readOnly\}/);
  });

  it('saves and activates exactly as before', () => {
    // Same endpoints, same payload, same status control — this ticket is an
    // editor-model change, not a persistence or theme-engine change.
    expect(basePage).toContain('`/platform/themes/${id}`');
    expect(basePage).toContain("method: 'PUT'");
    expect(basePage).toContain('tokens: editForm.tokens');
    expect(basePage, 'the Status control left the editor').toContain("t('label_status')");
    expect(basePage).toContain('EDITABLE_STATUSES.map');
    expect(basePage, 'the live preview of a draft was dropped').toContain('applyTokens');
    expect(basePage, 'the unsaved-changes guard was dropped').toContain('guardUnsaved');
  });

  it('introduces no modal editor', () => {
    expect(shared).not.toContain('CrudModal open');
    for (const src of [basePage, customPage]) {
      const form = src.match(/function renderEditForm[\s\S]*?\n  }\n/)?.[0]
        ?? src.match(/function renderInlineEditor[\s\S]*?\n  }\n/)?.[0] ?? '';
      expect(form, 'the editor body could not be located').not.toBe('');
      expect(form, 'the editor became a modal').not.toContain('CrudModal');
    }
  });

  it('needs no new translation keys — both namespaces already carry them', () => {
    for (const code of LOCALE_CODES) {
      for (const ns of ['themes', 'gym_themes'] as const) {
        const keys = locales[code][ns] as Record<string, unknown>;
        expect(keys, `${code}.json has no "${ns}" namespace`).toBeDefined();
        for (const key of SHARED_KEYS) {
          expect(keys[key], `${code}.json is missing ${ns}.${key}`).toBeTypeOf('string');
        }
      }
      // Status lives in the Base editor's Branding section only.
      expect((locales[code].themes as Record<string, unknown>).label_status, `${code}.json is missing themes.label_status`).toBeTypeOf('string');
    }
  });
});
