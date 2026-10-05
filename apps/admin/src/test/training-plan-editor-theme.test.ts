import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  treeAddBtnStyle, treeControlBox, weekdayChipStyle, weekdaySelectStyle,
} from '@/components/workoutChrome';
import { dashedAddBtnStyle } from '@/components/formChrome';
import { DEFAULT_TOKENS, applyTokens } from '@/lib/themeTokens';

// #971 — the Training Plan editor followed no Theme and was always an editor.
//
// Two separate defects, both on the Assigned Training Plans card
// (`[locale]/training-plans`) and the shared `WorkoutBlockBuilder` it renders:
//
//  1. `+ Add Workout`, `+ Block`, `+ Exercise`, the day selector and the tree's
//     own inputs were a lilac (`#eef0ff` / `#4b45c6` / `#b9b5ee` / `#6c63ff`) or
//     `--brand` (the *sidebar's* colour, which reads red on a themed gym) that
//     the Theme's Buttons and Inputs groups could not reach.
//  2. Expanding a plan rendered the whole editor, so a reader saw `+ Add
//     Workout`, name inputs, drag handles and per-workout `⋮` menus — the
//     opposite of CLAUDE.md's "Expanding a list card reads; `⋮ → Edit` writes".
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// shared chrome is asserted directly and the page wiring is pinned by scanning
// the sources, exactly as theme-primary-buttons.test.ts (#912/#954) does.

const SRC = join(__dirname, '..');
const COMPONENTS = join(SRC, 'components');
const APP = join(SRC, 'app', '[locale]');

const PLANS_PAGE = join(APP, 'training-plans', 'page.tsx');
const BLOCK_BUILDER = join(APP, 'workout-templates', 'WorkoutBlockBuilder.tsx');
const TEMPLATE_TREE = join(APP, 'training-plan-templates', 'TrainingPlanTree.tsx');
const WORKOUT_CHROME = join(COMPONENTS, 'workoutChrome.ts');

/** Every file's comments name the colours that were removed, so the scans run on code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));

const plansSrc = read(PLANS_PAGE);
const builderSrc = read(BLOCK_BUILDER);
const templateTreeSrc = read(TEMPLATE_TREE);
const chromeSrc = read(WORKOUT_CHROME);

/** The lilacs this ticket removed, in every spelling the three files carried. */
const LILACS = ['#eef0ff', '#4b45c6', '#b9b5ee', '#6c63ff', '#f0eeff'];

describe('workoutChrome: the tree\'s two controls, in one place (#971 §1, §7)', () => {
  it('dresses the weekday chip from the Theme\'s input pair', () => {
    expect(weekdayChipStyle.border).toBe('1px solid var(--gd-input-border, #d1d5db)');
    expect(weekdayChipStyle.background).toBe('var(--gd-input-bg, #ffffff)');
    // The fallbacks are the shipped defaults, so nothing flashes a colour no
    // Theme configures before `applyTokens()` has run.
    expect(weekdayChipStyle.border).toContain(`, ${DEFAULT_TOKENS.colors.inputBorderColor})`);
    expect(weekdayChipStyle.background).toContain(`, ${DEFAULT_TOKENS.colors.inputBackgroundColor})`);
  });

  it('gives the read-only chip and its selector the same box', () => {
    // #971 §4: the value a reader sees and the `<select>` an editor gets are one
    // pill, so entering Edit mode does not move the row sideways.
    const { cursor, fontFamily, ...box } = weekdaySelectStyle;
    expect(box).toEqual(weekdayChipStyle);
    expect(cursor).toBe('pointer');
  });

  it('builds + Block / + Exercise from the shared dashed add affordance', () => {
    // §2: lightweight, because they are secondary actions — but the app's own
    // `+ Add …` look rather than a dashed lilac link of this tree's own.
    expect(treeAddBtnStyle.border).toBe(dashedAddBtnStyle.border);
    expect(treeAddBtnStyle.background).toBe(dashedAddBtnStyle.background);
    expect(treeAddBtnStyle.color).toBe(dashedAddBtnStyle.color);
    expect(treeAddBtnStyle.border).toBe('1px dashed var(--gd-input-border, #c8c8d0)');
  });

  it('declares no colour of its own', () => {
    for (const lilac of LILACS) expect(chromeSrc).not.toContain(lilac);
    // Every colour it names is a Theme variable with a literal fallback.
    const hexes = chromeSrc.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
    for (const hex of hexes) {
      expect(chromeSrc, `${hex} is spelled outside a var() fallback`).toMatch(
        new RegExp(`var\\(--gd-[a-z-]+, ${hex}\\)|color: '${hex}'`),
      );
    }
  });
});

describe('The Assigned Training Plans card follows the Theme (#971 §1–§3)', () => {
  it('renders its filled actions through the shared primary helper', () => {
    // `+ New Training Plan`, `+ Add Workout` and the two Save buttons. `btnStyle()`
    // resolves through `--brand` (sidebarSelectedItemBackground), which is the
    // "red if red is not the configured action colour" of §3.
    expect(plansSrc).toMatch(
      /import \{[^}]*\bprimaryBtnStyle\b[^}]*\} from '@\/components\/ui'/,
    );
    expect(plansSrc.match(/primaryBtnStyle\(\)/g) ?? []).toHaveLength(4);
    expect(plansSrc).not.toMatch(/\bbtnStyle\(\)/);
    expect(plansSrc).toContain('style={readOnlyStyle(primaryBtnStyle(), !canWrite)}');
  });

  it('takes its field chrome and its Cancel from formChrome, not a local copy', () => {
    for (const name of [
      'formControlStyle', 'formFieldLabelStyle', 'formFieldErrorStyle',
      'formActionsRowStyle', 'secondaryBtnStyle',
    ]) {
      expect(plansSrc, `the page no longer uses ${name}`).toContain(name);
    }
    // The page-local restatements of the same three things are gone.
    expect(plansSrc).not.toContain('inlineInputStyle');
    expect(plansSrc).not.toContain('inlineLabelStyle');
    expect(plansSrc).not.toContain('cancelBtnStyle');
  });

  it('spells no lilac, and routes its two accents through a Theme variable', () => {
    for (const lilac of ['#eef0ff', '#6c63ff', '#f0eeff']) {
      expect(plansSrc, `the page still spells ${lilac}`).not.toContain(lilac);
    }
    // #4b45c6 survives only as the fallback of the sorted-title and edit accents.
    expect(plansSrc.match(/#4b45c6/g) ?? []).toHaveLength(2);
    expect(plansSrc).toContain("color: active ? 'var(--gd-link, #4b45c6)' : 'inherit'");
    expect(plansSrc).toContain("boxShadow: 'inset 3px 0 0 var(--brand, #4b45c6)'");
  });

  it('uses the shared card surface for a workout card', () => {
    expect(plansSrc).toMatch(/import \{[^}]*\bcardSurfaceStyle\b[^}]*\} from '@\/components\/ui'/);
    expect(plansSrc).toContain('...cardSurfaceStyle, padding: \'10px 14px\'');
  });
});

describe('Expanding a plan reads; ⋮ → Edit writes (#971 §4, §5)', () => {
  it('gates every control in the tree on Edit mode', () => {
    // One expression does it: the tree's `canWrite` — which each of `+ Add
    // Workout`, the name input, the drag handle, the per-workout `⋮` and
    // `WorkoutBlockBuilder` already keys off — now also requires `editing`.
    expect(plansSrc).toContain('canWrite={canWrite && editing && !isCompleted}');
    expect(plansSrc).not.toContain('canWrite={canWrite && !isCompleted}');
  });

  it('leaves the read-only tree able to show the whole structure', () => {
    // §4: a reader still inspects the plan — the weekday, the workout name and
    // the blocks all render as values.
    expect(plansSrc).toContain('<span style={weekdayChipStyle}>');
    expect(plansSrc).toMatch(/\{canWrite \? \([\s\S]{0,400}<select/);
    expect(plansSrc).toContain('<WorkoutBlockBuilder');
    // And the builder's own read-only half is what draws them.
    expect(builderSrc).toContain('canWrite ? (');
  });

  it('keeps `⋮ → Edit` the single entry point, and keeps it expanding the row', () => {
    // CLAUDE.md: Edit expands the row it opens, so Cancel reveals the read-only
    // view rather than collapsing it.
    expect(plansSrc).toMatch(/function startEdit\(row: TrainingPlanRow\) \{[\s\S]*?setExpanded/);
    expect(plansSrc).toContain("onEdit={() => guardUnsaved(() => startEdit(row))}");
  });
});

describe('WorkoutBlockBuilder carries no colour of its own (#971 §1, §2)', () => {
  it('renders + Block and + Exercise as the shared dashed add button', () => {
    // #1031 grouped that import with the rest of the tree's shared chrome.
    expect(builderSrc).toMatch(/treeAddBtnStyle[\s\S]*?from '@\/components\/workoutChrome'/);
    expect(builderSrc.match(/treeAddBtnStyle/g) ?? []).toHaveLength(4);
    expect(builderSrc).not.toContain('inlineAddStyle');
  });

  it('dresses its compact controls from the Theme\'s input pair', () => {
    // #1031 moved `treeControlBox` and the four controls derived from it out of
    // this file and into `workoutChrome.ts`, because the *other* tree
    // (`WorkoutTemplateTree`) kept its own un-themed copy of all of them. The
    // intent is unchanged and is now asserted one level up: the shared box
    // names the two variables, and the builder spreads the shared controls
    // rather than declaring any of its own.
    expect(treeControlBox.border).toBe('1px solid var(--gd-input-border, #ddd)');
    expect(treeControlBox.background).toBe('var(--gd-input-bg, #fafafa)');
    for (const name of [
      'treeHeaderInputStyle', 'treeHeaderSelectStyle', 'treeCellInputStyle', 'treeComboTriggerStyle',
    ] as const) {
      expect(chromeSrc, `${name} does not share the one control box`)
        .toMatch(new RegExp(`export const ${name}: React\\.CSSProperties = \\{\\s*\\.\\.\\.treeControlBox`));
      expect(builderSrc, `the builder redeclares ${name}`).not.toContain(`const ${name}`);
    }
    expect(builderSrc).not.toContain('const treeControlBox');
  });

  it('spells none of the lilacs it used to', () => {
    for (const lilac of LILACS) {
      expect(builderSrc, `the builder still spells ${lilac}`).not.toContain(lilac);
    }
  });
});

describe('The Training Plan Templates tree shares the same chip (#971 §1)', () => {
  it('imports it rather than declaring a second one', () => {
    expect(templateTreeSrc).toMatch(/import \{ weekdayChipStyle \} from '@\/components\/workoutChrome'/);
    expect(templateTreeSrc).not.toContain('const weekdayBadge');
    expect(templateTreeSrc).toContain("...weekdayChipStyle, cursor: canWrite ? 'pointer' : 'default'");
    expect(templateTreeSrc).toContain('primaryBtnStyle()');
  });

  it('spells no lilac in a control', () => {
    for (const lilac of LILACS) {
      expect(templateTreeSrc, `the templates tree still spells ${lilac}`).not.toContain(lilac);
    }
  });
});

describe('A Theme change reaches the editor (#971 §7, expected result)', () => {
  /** Minimal `document` stand-in — these tests run in vitest's node environment. */
  function written(): Record<string, string> {
    const out: Record<string, string> = {};
    (globalThis as any).document = {
      documentElement: { style: { setProperty: (n: string, v: string) => { out[n] = v; } } },
    };
    return out;
  }

  it('writes the variables the tree\'s controls read', () => {
    const out = written();
    try {
      applyTokens({
        ...DEFAULT_TOKENS,
        colors: {
          ...DEFAULT_TOKENS.colors,
          inputBorderColor: '#112233',
          inputBackgroundColor: '#445566',
          primaryButton: '#778899',
        },
      });
      expect(out['--gd-input-border']).toBe('#112233');
      expect(out['--gd-input-bg']).toBe('#445566');
      expect(out['--gd-primary-btn']).toBe('#778899');
      // The link from the edited token to the rendered control: the chip and the
      // add button name exactly the variables `applyTokens` has just written.
      expect(weekdayChipStyle.border).toContain('var(--gd-input-border,');
      expect(treeAddBtnStyle.border).toContain('var(--gd-input-border,');
    } finally {
      delete (globalThis as any).document;
    }
  });
});
