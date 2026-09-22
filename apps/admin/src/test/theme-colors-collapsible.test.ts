import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { COLOR_GROUPS } from '../components/ThemeTokensEditor';

// Regression test for #632 — the Colors section's groups are collapsible cards.
//
// This is a presentation-only ticket: the groups, the color settings and the
// controls inside them must be untouched, and only their framing changes. This
// repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like promotions-section-editing.test.ts (#627) — this pins the
// structure down by scanning the component source and the locale files.

const EDITOR_PATH = join(__dirname, '..', 'components', 'ThemeTokensEditor.tsx');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const NAMESPACES = ['themes', 'gym_themes'] as const;

type Messages = Record<string, Record<string, unknown>>;

// Comments in the source name #632 and describe the collapsing behaviour, so
// every scan below runs on comment-free code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const editorSrc = stripComments(readFileSync(EDITOR_PATH, 'utf-8'));
// `ThemeColorsEditor` only — the typography editor below it is out of scope.
const colorsEditorSrc = editorSrc.match(/export function ThemeColorsEditor[\s\S]*?\n}\n/)?.[0] ?? '';

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Messages>;

describe('Theme Colors: collapsible groups (#632)', () => {
  it('extracts the ThemeColorsEditor body to scan', () => {
    expect(colorsEditorSrc, 'ThemeColorsEditor could not be located in the source').not.toBe('');
  });

  it('renders every Colors group as a collapsible card from the one shared map', () => {
    // Every group goes through the same renderer, so the card treatment can't
    // be applied to some groups and missed on others.
    expect(colorsEditorSrc).toMatch(/COLOR_GROUPS\.map\(\(\{ groupKey, fields \}\)/);
    expect(colorsEditorSrc, 'no per-group open state').toMatch(/const open = openGroups\.has\(groupKey\)/);
  });

  it('covers the groups the ticket names by name', () => {
    // Application / Text / Inputs / Header are called out in the acceptance
    // criteria; the rest follow from the shared renderer above.
    for (const groupKey of ['group_application', 'group_text', 'group_inputs', 'group_header']) {
      expect(
        COLOR_GROUPS.some((g) => g.groupKey === groupKey),
        `COLOR_GROUPS no longer has a ${groupKey} entry`,
      ).toBe(true);
    }
  });

  it('makes the whole group header a clickable, accessible toggle', () => {
    const header = colorsEditorSrc.match(/<button[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(header, 'the group header is not a <button>').not.toBe('');
    expect(header).toContain('type="button"');
    expect(header, 'the header does not toggle its own group').toContain('onClick={() => toggleGroup(groupKey)}');
    expect(header, 'the disclosure state is not exposed to assistive tech').toContain('aria-expanded={open}');
    expect(header, 'the header does not render the group name').toContain('{t(groupKey)}');
    expect(header, 'the header has no expand/collapse indicator').toContain('▾');
    // A full-width header so the entire card header is the click target.
    expect(header).toContain("width: '100%'");
  });

  it('hides a collapsed group’s controls and shows them when expanded', () => {
    expect(colorsEditorSrc, "the group body is not gated on its open state").toMatch(/\{open && \(/);
    // The controls live inside that gate, not outside it.
    const body = colorsEditorSrc.match(/\{open && \([\s\S]*$/)?.[0] ?? '';
    expect(body).toContain('type="color"');
    expect(body).toContain('ThemeAdvancedSection');
  });

  it('keeps the groups independent rather than turning them into an accordion', () => {
    // A Set of open keys — opening Text must not close Application.
    expect(colorsEditorSrc).toMatch(/useState<Set<string>>\(new Set\(\)\)/);
    const toggle = colorsEditorSrc.match(/function toggleGroup[\s\S]*?\n  }\n/)?.[0] ?? '';
    expect(toggle, 'toggleGroup could not be located').not.toBe('');
    expect(toggle, 'toggling does not remove an already-open group').toContain('next.delete(groupKey)');
    expect(toggle, 'toggling does not add the group being opened').toContain('next.add(groupKey)');
    expect(toggle, 'toggling replaces the open set — that is an accordion, not independent groups')
      .not.toMatch(/new Set\(\[/);
  });

  it('never touches theme values when a group is collapsed or expanded', () => {
    const toggle = colorsEditorSrc.match(/function toggleGroup[\s\S]*?\n  }\n/)?.[0] ?? '';
    expect(toggle, 'collapsing a group writes to the theme').not.toContain('onChange');
    expect(toggle, 'collapsing a group reads or writes tokens').not.toContain('tokens');
    // Open state is component-local and separate from the token draft.
    expect(colorsEditorSrc).toMatch(/const \[openGroups, setOpenGroups\]/);
  });

  it('leaves the existing controls inside each group unchanged', () => {
    // The same three things every group could render before #632.
    expect(colorsEditorSrc, 'the color pickers no longer map over the group fields')
      .toMatch(/fields\.map\(\(\{ key, labelKey \}\)/);
    expect(colorsEditorSrc).toContain('tokens.colors[key] ?? DEFAULT_TOKENS.colors[key]');
    expect(colorsEditorSrc, 'the Header separator height control was dropped')
      .toContain("groupKey === 'group_header'");
    expect(colorsEditorSrc).toContain('headerSeparatorHeight');
    expect(colorsEditorSrc, 'the Calendar contrast report was dropped')
      .toMatch(/groupKey === 'group_calendar' && <CalendarContrastReport/);
    // Read-only themes (Base Themes viewed from Custom Themes) still disable
    // their inputs rather than becoming editable behind a collapsed header.
    expect(colorsEditorSrc).toContain('disabled={readOnly}');
  });

  it('introduces no modal and no new screen', () => {
    expect(editorSrc).not.toContain('CrudModal');
    expect(editorSrc).not.toContain('Modal');
  });

  it('applies to both the Custom Themes and Base Themes editors', () => {
    // Both pages render the Colors section through this one shared component,
    // so neither can miss the change.
    const pages = {
      'Custom Themes': join(__dirname, '..', 'app', '[locale]', 'themes', 'page.tsx'),
      'Base Themes': join(__dirname, '..', 'app', '[locale]', 'system', 'themes', 'page.tsx'),
    };
    for (const [label, path] of Object.entries(pages)) {
      const src = readFileSync(path, 'utf-8');
      expect(src, `${label} no longer renders the shared ThemeColorsEditor`).toContain('ThemeColorsEditor');
    }
  });

  it('needs no new translation keys — every group header label already exists', () => {
    // The card header reuses the group's existing label, so a collapsed card
    // can never render an untranslated key.
    for (const code of LOCALE_CODES) {
      for (const ns of NAMESPACES) {
        const keys = locales[code][ns] as Record<string, unknown>;
        expect(keys, `${code}.json has no "${ns}" namespace`).toBeDefined();
        for (const { groupKey } of COLOR_GROUPS) {
          expect(keys[groupKey], `${code}.json is missing ${ns}.${groupKey}`).toBeDefined();
        }
      }
    }
  });
});
