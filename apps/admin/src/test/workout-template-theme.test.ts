import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  TREE_COMBO_ITEM_SELECTED_BG, treeAddBtnStyle, treeBlockCardStyle, treeCellInputStyle,
  treeComboDropdownStyle, treeComboTriggerStyle, treeControlBox, treeDragHandleStyle,
  treeDropTargetStyle, treeHeaderInputStyle, treeHeaderSelectStyle, treeRowDragHandleStyle,
  treeThStyle,
} from '@/components/workoutChrome';
import { cardSurfaceStyle, primaryBtnSmall, primaryBtnStyle } from '@/components/ui';
import {
  dashedAddBtnStyle, formControlStyle, formFieldLabelStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { filterControlStyle } from '@/components/FilterBar';
import { DEFAULT_TOKENS, applyTokens } from '@/lib/themeTokens';

// #1031 — the Workout Templates editor is the application's own design system.
//
// #971 put the workout hierarchy's chrome in one place and swept the Training
// Plans card and the Training Plan Templates card onto it. It did not reach the
// *third* screen that renders the same tree: `[locale]/workout-templates` draws
// it through `WorkoutTemplateTree.tsx`, which kept its own copy of every
// control — `+ Block` and `+ Exercise` as a dashed lilac text link
// (`#b9b5ee` / `#6c63ff`), the block header's input and select on a hardcoded
// `#ddd` over `#fafafa`, the block card on a `#ececf0` border under a themed
// background, the picker's selected option in `#f0eeff`, and the drop target
// that accepts a block dragged in from another template highlighting in
// `#eef0ff` behind a `#6c63ff` dashed outline. So a gym that configured its
// Theme saw it everywhere in the editor except on the screen the ticket's
// screenshot is of.
//
// Every control the tree draws is declared once in `workoutChrome.ts` now and
// both files spread it, and the page's own form takes `formChrome`. This is a
// styling ticket: no payload, endpoint, validation or handler moved with it.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// shared chrome is asserted directly and each screen's wiring is pinned by
// scanning its source — exactly as #912/#954/#968/#971's own tests do.

const SRC = join(__dirname, '..');
const COMPONENTS = join(SRC, 'components');
const APP = join(SRC, 'app', '[locale]');

const WORKOUT_CHROME = join(COMPONENTS, 'workoutChrome.ts');
const TEMPLATE_TREE = join(APP, 'workout-templates', 'WorkoutTemplateTree.tsx');
const BLOCK_BUILDER = join(APP, 'workout-templates', 'WorkoutBlockBuilder.tsx');
const TEMPLATES_PAGE = join(APP, 'workout-templates', 'page.tsx');
const BASE_PAGE = join(APP, 'cordel', 'workout-templates', 'page.tsx');

/** The comments name the colours that were removed, so the scans run on code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));

const chromeSrc = read(WORKOUT_CHROME);
const treeSrc = read(TEMPLATE_TREE);
const builderSrc = read(BLOCK_BUILDER);
const pageSrc = read(TEMPLATES_PAGE);
const baseSrc = read(BASE_PAGE);

/** The lilacs the editor used to spell, none of which any Theme setting reaches. */
const LILACS = ['#6c63ff', '#eef0ff', '#f0eeff', '#b9b5ee', '#4b45c6'];

/** The controls both trees render, and the one name each of them now has. */
const SHARED_CONTROLS = [
  'treeControlBox', 'treeHeaderInputStyle', 'treeHeaderSelectStyle', 'treeCellInputStyle',
  'treeBlockCardStyle', 'treeDragHandleStyle', 'treeRowDragHandleStyle',
  'treeTableStyle', 'treeThStyle', 'treeTdStyle',
  'treeComboTriggerStyle', 'treeComboDropdownStyle', 'treeComboSearchStyle',
  'treeComboListStyle', 'treeComboItemStyle', 'treeComboItemEmptyStyle',
  'treeDraftRemoveBtnStyle',
] as const;

describe('The tree has one declaration of each control (#1031)', () => {
  it('declares them in workoutChrome and nowhere else', () => {
    for (const name of SHARED_CONTROLS) {
      expect(chromeSrc, `${name} is not declared in workoutChrome`)
        .toContain(`export const ${name}`);
      // The two trees had one copy each; neither may keep a local one, or the
      // next Theme change reaches one screen and not the other again.
      for (const [label, src] of [['the templates tree', treeSrc], ['the block builder', builderSrc]] as const) {
        expect(src, `${label} redeclares ${name}`).not.toMatch(new RegExp(`const ${name}\\b`));
      }
    }
  });

  it('leaves neither tree a `---- Styles ----` block of its own', () => {
    for (const [label, src] of [['the templates tree', treeSrc], ['the block builder', builderSrc]] as const) {
      expect(src, `${label} still declares page-local control styles`)
        .not.toMatch(/const (inlineAddStyle|headerInput|headerSelect|cellInput|comboTrigger|comboDropdown|comboSearch|comboList|comboItem|comboItemEmpty|cancelBtnStyle|tableStyle|thStyle|tdStyle)\b/);
    }
  });

  it('has both of them import the shared chrome', () => {
    for (const src of [treeSrc, builderSrc]) {
      expect(src).toMatch(/from '@\/components\/workoutChrome'/);
    }
  });
});

describe('Every control follows the Theme, not a colour of its own (#1031)', () => {
  it('spells no lilac in either tree or in the shared chrome', () => {
    for (const [label, src] of [
      ['the templates tree', treeSrc], ['the block builder', builderSrc], ['workoutChrome', chromeSrc],
    ] as const) {
      for (const lilac of LILACS) {
        expect(src, `${label} still spells ${lilac}`).not.toContain(lilac);
      }
    }
  });

  it('dresses the one control box from the Theme\'s input pair', () => {
    expect(treeControlBox.border).toBe('1px solid var(--gd-input-border, #ddd)');
    expect(treeControlBox.background).toBe('var(--gd-input-bg, #fafafa)');
    for (const control of [treeHeaderInputStyle, treeHeaderSelectStyle, treeCellInputStyle, treeComboTriggerStyle]) {
      expect(control.border).toBe(treeControlBox.border);
      expect(control.background).toBe(treeControlBox.background);
      expect(control.borderRadius).toBe(treeControlBox.borderRadius);
    }
  });

  it('keeps the tree\'s own denser geometry rather than the form\'s', () => {
    // §"preserve semantic hierarchy": a block header is not a form field, so the
    // compact padding and type size stay — only the colours are shared with
    // `formChrome`'s full-size control.
    expect(treeHeaderInputStyle.padding).toBe('4px 8px');
    expect(treeHeaderInputStyle.fontSize).toBe(13.5);
    expect(formControlStyle.padding).toBe('8px 10px');
    expect(treeControlBox.border).not.toBe(formControlStyle.border);
    expect(String(treeControlBox.border)).toContain('var(--gd-input-border,');
    expect(String(formControlStyle.border)).toContain('var(--gd-input-border,');
  });

  it('builds + Block / + Exercise from the shared dashed add affordance', () => {
    expect(treeAddBtnStyle.border).toBe(dashedAddBtnStyle.border);
    expect(treeAddBtnStyle.color).toBe(dashedAddBtnStyle.color);
    // Three usages in each file — `+ Block`, and `+ Exercise` in both the
    // empty and the populated branch of a block — plus the import that names it.
    expect(treeSrc.match(/treeAddBtnStyle/g) ?? []).toHaveLength(4);
    expect(builderSrc.match(/treeAddBtnStyle/g) ?? []).toHaveLength(4);
  });

  it('puts a block in the app\'s own card surface', () => {
    for (const key of ['border', 'borderRadius', 'background'] as const) {
      expect(treeBlockCardStyle[key]).toBe(cardSurfaceStyle[key]);
    }
    expect(treeSrc).not.toContain('#ececf0');
  });

  it('highlights a cross-template drop target in Theme colours', () => {
    const active = treeDropTargetStyle(true);
    expect(active.background).toBe('var(--gd-app-bg, #f0f0f0)');
    expect(active.outline).toBe('2px dashed var(--gd-input-border, #c8c8d0)');
    // Idle is unchanged — the geometry is the same either way, so the box does
    // not move when a drag starts.
    const idle = treeDropTargetStyle(false);
    expect(idle.background).toBeUndefined();
    expect(idle.outline).toBe('none');
    expect(idle.padding).toBe(active.padding);
    expect(treeSrc).toContain('treeDropTargetStyle(isOver && foreignBlock)');
  });

  it('marks the picker\'s selected option with the app background', () => {
    expect(TREE_COMBO_ITEM_SELECTED_BG).toBe('var(--gd-app-bg, #f0f0f0)');
    for (const src of [treeSrc, builderSrc]) {
      expect(src).toContain('TREE_COMBO_ITEM_SELECTED_BG');
    }
    expect(treeComboDropdownStyle.background).toBe('var(--gd-card-bg, #ffffff)');
    expect(treeComboDropdownStyle.border).toBe('1px solid var(--gd-input-border, #ddd)');
  });

  it('draws the exercise table\'s rule in the themed card border', () => {
    expect(treeThStyle.borderBottom).toBe('1px solid var(--gd-card-border, #eee)');
  });

  it('names every colour as a Theme variable or a neutral text colour', () => {
    const hexes = chromeSrc.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
    expect(hexes.length).toBeGreaterThan(0);
    for (const hex of hexes) {
      expect(chromeSrc, `${hex} is spelled outside a var() fallback`).toMatch(
        new RegExp(`var\\(--gd-[a-z-]+, ${hex}\\)|color: '${hex}'`),
      );
    }
  });

  it('gives the two drag handles one declaration and two sizes', () => {
    expect(treeRowDragHandleStyle.cursor).toBe(treeDragHandleStyle.cursor);
    expect(treeRowDragHandleStyle.touchAction).toBe('none');
    expect(treeRowDragHandleStyle.fontSize).not.toBe(treeDragHandleStyle.fontSize);
  });
});

describe('The Workout Templates page\'s own form is formChrome (#1031)', () => {
  it('declares no label, input, select or error line of its own', () => {
    expect(pageSrc).not.toMatch(/const (inlineLabelStyle|inlineInputStyle|inlineSelectStyle|filterInputStyle|errorStyle)\b/);
    expect(pageSrc).toContain('formFieldLabelStyle');
    expect(pageSrc).toContain('formControlStyle');
    expect(pageSrc).toContain('formErrorStyle');
    // No control may carry a border colour the Theme cannot move.
    expect(pageSrc).not.toContain("border: '1px solid #ccc'");
  });

  it('renders the two filters with the app\'s filter control', () => {
    expect(pageSrc.match(/style=\{filterControlStyle\}/g) ?? []).toHaveLength(2);
    expect(String(filterControlStyle.border)).toContain('var(--gd-input-border,');
  });

  it('keeps the primary/secondary hierarchy, both themed', () => {
    // §"preserve semantic hierarchy": Add and Save stay the filled primary
    // action, Cancel stays the neutral one. `btnStyle()` was neither — its
    // default is `--brand`, the *sidebar's* colour (#912/#954).
    expect(pageSrc).toContain('readOnlyStyle(primaryBtnStyle(), !canWrite)');
    expect(pageSrc.match(/primaryBtnSmall\(\)/g) ?? []).toHaveLength(2);
    expect(pageSrc.match(/style=\{secondaryBtnSmall\}/g) ?? []).toHaveLength(2);
    expect(pageSrc).not.toContain("btnSmall('#888')");
    expect(pageSrc).not.toContain('btnStyle()');
    expect(primaryBtnStyle().background).toBe(primaryBtnSmall().background);
    expect(secondaryBtnSmall.background).toBe('var(--gd-input-bg, #ffffff)');
  });

  it('renders its sections and read-only rows through the shared components', () => {
    expect(pageSrc).not.toMatch(/function (SectionHeader|DetailRow)\(/);
    expect(pageSrc).toContain("import { CardSection } from '@/components/CardSection'");
    expect(pageSrc).toContain("import { CardDetailRow } from '@/components/CardDetailRow'");
    // Both halves of the card render the same three sections in the same order,
    // the first of them carrying no hairline above it (#929 §4).
    for (const label of ['section_general', 'section_workout_structure', 'section_notes']) {
      expect(pageSrc.match(new RegExp(`CardSection label=\\{t\\('${label}'\\)\\}`, 'g')) ?? []).toHaveLength(2);
    }
    expect(pageSrc.match(/<CardSection label=\{t\('section_general'\)\} first>/g) ?? []).toHaveLength(2);
    expect(formFieldLabelStyle.fontWeight).toBe(600);
  });

  it('changes no behaviour of the editor', () => {
    // A styling ticket: the same endpoints, the same guards, the same tree.
    expect(pageSrc).toContain('/workout-templates');
    expect(pageSrc).toContain('disabled={editSaving}');
    expect(pageSrc).toContain('disabled={!canWrite || inlineNew !== null}');
    expect(pageSrc.match(/<WorkoutTemplateTree/g) ?? []).toHaveLength(2);
    for (const endpoint of [
      '/blocks', '/exercises?status=active',
    ]) {
      expect(treeSrc, `the tree stopped calling ${endpoint}`).toContain(endpoint);
    }
    // Both trees keep every action they had, including drag-and-drop.
    for (const src of [treeSrc, builderSrc]) {
      expect(src).toContain('useSortable');
      expect(src).toContain('ContextMenu');
      expect(src).toContain('ConfirmDialog');
    }
  });

  it('names the draft row\'s ✕ for a screen reader', () => {
    // A glyph has no text of its own (#1029's rule for `rowRemoveBtnStyle`),
    // and this one abandons an unsaved row rather than removing a saved one, so
    // it stays the tree's neutral affordance and gains the missing label.
    for (const src of [treeSrc, builderSrc]) {
      expect(src).toContain('style={treeDraftRemoveBtnStyle} aria-label={cancelLabel}');
      expect(src).toContain("cancelLabel={t('block_exercises.cancel')}");
    }
  });
});

describe('Base Workout Templates follows the same theme (#1031)', () => {
  it('renders + New Template as the themed primary action', () => {
    expect(baseSrc).toContain('style={primaryBtnStyle()}');
    expect(baseSrc).not.toContain('btnStyle()');
  });

  it('renders its search with the app\'s filter control', () => {
    expect(baseSrc).toContain('...filterControlStyle');
    expect(baseSrc).not.toContain("border: '1px solid #ccc'");
  });
});

describe('A Theme change reaches every control the editor draws (#1031)', () => {
  /** Minimal `document` stand-in — these tests run in vitest's node environment. */
  function written(): Record<string, string> {
    const out: Record<string, string> = {};
    (globalThis as any).document = {
      documentElement: { style: { setProperty: (n: string, v: string) => { out[n] = v; } } },
    };
    return out;
  }

  it('writes each variable the shared chrome reads', () => {
    const out = written();
    try {
      applyTokens({
        ...DEFAULT_TOKENS,
        colors: {
          ...DEFAULT_TOKENS.colors,
          inputBorderColor: '#112233',
          inputBackgroundColor: '#445566',
          cardBorder: '#778899',
          pageBackground: '#aabbcc',
          primaryButton: '#ddeeff',
        },
      });
      for (const [variable, value] of [
        ['--gd-input-border', '#112233'],
        ['--gd-input-bg', '#445566'],
        ['--gd-card-border', '#778899'],
        ['--gd-app-bg', '#aabbcc'],
        ['--gd-primary-btn', '#ddeeff'],
      ] as const) {
        expect(out[variable], `applyTokens does not write ${variable}`).toBe(value);
        expect(chromeSrc + String(primaryBtnStyle().background), `nothing reads ${variable}`)
          .toContain(variable);
      }
    } finally {
      delete (globalThis as any).document;
    }
  });
});
