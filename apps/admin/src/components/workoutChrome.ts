import React from 'react';

// #971 — the chrome the workout hierarchy draws, in one place.
//
// `listChrome.ts` does this for a list's header band and rows and
// `formChrome.ts` for the inside of a card; what neither covered is the
// Training Plan → Workout → Day → Block → Exercises tree, which three screens
// render: the Assigned Training Plans card (`[locale]/training-plans`), the
// Training Plan Templates card (`[locale]/training-plan-templates`) and the
// Workout Templates card (`[locale]/workout-templates`, through the shared
// `WorkoutBlockBuilder`).
//
// Each of them had grown its own copy of the two controls below, in a lilac
// (`#eef0ff` / `#4b45c6` / `#6c63ff`) that no Theme setting reaches — so a gym
// that configured its colours got them everywhere except inside a training
// plan. These carry the Theme's own input variables instead (`--gd-input-bg` /
// `--gd-input-border`, the pair `formChrome.ts` already dresses every
// `<input>`/`<select>` from), with the pre-token literal as the `var()`
// fallback for the frames before `applyTokens()` has run — never as a second
// source of truth.
//
// #1031 widened it from those two controls to every control the tree draws
// (see the second half of this file): the block header's input and select,
// the exercise table, the exercise picker and the drop target: the Workout
// Templates tree had kept its own copy of all of them, so #971's sweep had
// reached one of the two trees and not the other.

import { dashedAddBtnStyle } from './formChrome';
import { cardSurfaceStyle } from './ui';

/**
 * The training day a workout is scheduled on — `Mon`, `No day`.
 *
 * One object for both halves of the read-only/Edit split (#971 §4): the
 * `<select>` an editor renders and the value a reader sees are the same pill,
 * so switching modes does not move the row. A weekday *selector* is a select,
 * so it wears the Theme's input box at a pill radius rather than a colour of
 * its own.
 */
export const weekdayChipStyle: React.CSSProperties = {
  borderRadius: 999,
  padding: '3px 10px',
  fontSize: 12.5,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  border: '1px solid var(--gd-input-border, #d1d5db)',
  background: 'var(--gd-input-bg, #ffffff)',
  color: '#444',
};

/** The same pill as the control that changes it. */
export const weekdaySelectStyle: React.CSSProperties = {
  ...weekdayChipStyle,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

/**
 * `+ Block` / `+ Exercise` — an add affordance *inside* the tree.
 *
 * #971 §2: these are secondary actions and stay visually lightweight, so they
 * are `formChrome`'s dashed `+ Add …` affordance at the tree's own denser size
 * rather than a filled button (that is `+ Add Workout`, which opens the row's
 * own editor) and rather than the dashed lilac link they were.
 */
export const treeAddBtnStyle: React.CSSProperties = {
  ...dashedAddBtnStyle,
  padding: '3px 10px',
  fontSize: 12.5,
  fontWeight: 600,
  marginTop: 0,
  marginBottom: 6,
};

/* ───────────────────────────── the tree's controls ──────────────────────────
 *
 * #1031: the two files that render this hierarchy — `WorkoutBlockBuilder.tsx`
 * (the Training Plans card) and `WorkoutTemplateTree.tsx` (the Workout
 * Templates card) — each carried their own copy of every control below, and
 * #971 only reached the first of them. So the same block header was dressed
 * from the Theme's input pair on one screen and from a hardcoded `#ddd` on
 * `#fafafa` on the other, `+ Block` was the dashed neutral affordance here and
 * a dashed lilac text link there, and the drop target that accepts a block
 * dragged between templates highlighted in a lilac (`#eef0ff` / `#6c63ff`) no
 * Theme setting reaches.
 *
 * They are declared once here instead, and both files spread them. The
 * geometry is the tree's own — compact, because a block header is not a form
 * field — and every colour is a Theme variable with the pre-token literal as
 * the `var()` fallback, never as a second source of truth.
 */

/**
 * The one control box of the tree: `<input>`, `<select>` and the exercise
 * picker's trigger all wear it, so the controls on one row line up with each
 * other and follow the same two Theme settings `formChrome`'s full-size
 * `formControlStyle` does (#971 §1).
 */
export const treeControlBox: React.CSSProperties = {
  borderRadius: 5,
  border: '1px solid var(--gd-input-border, #ddd)',
  background: 'var(--gd-input-bg, #fafafa)',
};

/** A block's name, and its configuration number beside it. */
export const treeHeaderInputStyle: React.CSSProperties = {
  ...treeControlBox, padding: '4px 8px', fontSize: 13.5, minWidth: 90, maxWidth: 200,
};

/** A block's type — `Standard`, `Circuit`, `Superset`. */
export const treeHeaderSelectStyle: React.CSSProperties = {
  ...treeControlBox, padding: '4px 8px', fontSize: 13, cursor: 'pointer',
};

/** A number or unit cell inside the exercise table. */
export const treeCellInputStyle: React.CSSProperties = {
  ...treeControlBox, padding: '4px 6px', fontSize: 13, width: 56, boxSizing: 'border-box',
};

/**
 * The card one block sits in — the app's own themed card surface (#677) rather
 * than a border colour of this tree's own, which is what the Workout Templates
 * copy had (`1px solid #ececf0` under a themed background, so a gym that
 * changed its Card Border got it everywhere except here).
 */
export const treeBlockCardStyle: React.CSSProperties = {
  ...cardSurfaceStyle, padding: '10px 14px', marginBottom: 10,
};

/** The `⠿` that reorders a block. */
export const treeDragHandleStyle: React.CSSProperties = {
  cursor: 'grab', color: '#bbb', fontSize: 16,
  userSelect: 'none', touchAction: 'none', flexShrink: 0,
};

/** The same handle one level down, on an exercise row. */
export const treeRowDragHandleStyle: React.CSSProperties = {
  ...treeDragHandleStyle, color: '#ccc', fontSize: 13,
};

/** The exercise table inside a block. */
export const treeTableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse', fontSize: 13,
};

/** Its column headers. */
export const treeThStyle: React.CSSProperties = {
  textAlign: 'left', padding: '4px 8px 6px', color: '#888', fontSize: 12,
  borderBottom: '1px solid var(--gd-card-border, #eee)', fontWeight: 500, whiteSpace: 'nowrap',
};

/** And its cells. */
export const treeTdStyle: React.CSSProperties = {
  padding: '4px 8px', verticalAlign: 'middle',
};

/** The exercise picker's trigger — a `<select>` in everything but markup. */
export const treeComboTriggerStyle: React.CSSProperties = {
  ...treeControlBox,
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 8px', fontSize: 13.5, cursor: 'pointer',
  whiteSpace: 'nowrap', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis',
};

/** The prompt inside it while nothing is picked. */
export const treeComboPlaceholderStyle: React.CSSProperties = { color: '#aaa' };

/** Its `▾`. */
export const treeComboCaretStyle: React.CSSProperties = {
  marginLeft: 4, fontSize: 10, color: '#888',
};

/** The panel it opens. */
export const treeComboDropdownStyle: React.CSSProperties = {
  position: 'absolute', top: '100%', left: 0, zIndex: 200,
  background: 'var(--gd-card-bg, #ffffff)',
  border: '1px solid var(--gd-input-border, #ddd)', borderRadius: 7,
  boxShadow: '0 4px 16px rgba(0,0,0,0.12)', minWidth: 220, marginTop: 2,
};

/** The search field at the top of that panel. */
export const treeComboSearchStyle: React.CSSProperties = {
  display: 'block', width: '100%', padding: '8px 10px', border: 'none',
  borderBottom: '1px solid var(--gd-card-border, #eee)', fontSize: 13.5, outline: 'none',
  borderRadius: '7px 7px 0 0', boxSizing: 'border-box',
};

/** The options under it. */
export const treeComboListStyle: React.CSSProperties = {
  listStyle: 'none', margin: 0, padding: '4px 0', maxHeight: 220, overflowY: 'auto',
};

/** One option. */
export const treeComboItemStyle: React.CSSProperties = {
  padding: '7px 12px', cursor: 'pointer', fontSize: 13.5,
};

/** And the line a search with no match reads. */
export const treeComboItemEmptyStyle: React.CSSProperties = {
  padding: '7px 12px', color: '#aaa', fontSize: 13,
};

/**
 * The option that is already selected — the Theme's app background rather than
 * the lilac tint (`#f0eeff`) it was in both files, so it stays legible on a
 * themed surface instead of going light-on-light.
 */
export const TREE_COMBO_ITEM_SELECTED_BG = 'var(--gd-app-bg, #f0f0f0)';

/**
 * The `✕` that discards a draft exercise row before it is saved.
 *
 * Deliberately *not* `formChrome`'s `rowRemoveBtnStyle` (#1029): that one is
 * red because it removes something that exists, and this one abandons a row
 * nothing has been written for yet.
 */
export const treeDraftRemoveBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#aaa',
  cursor: 'pointer', fontSize: 14, padding: '2px 6px',
};

/** The sentence a block list with no blocks reads. */
export const treeEmptyTextStyle: React.CSSProperties = {
  color: '#888', fontSize: 14, margin: '8px 0 4px',
};

/** The quieter one a block with no exercises reads. */
export const treeNestedEmptyTextStyle: React.CSSProperties = {
  color: '#bbb', fontSize: 12.5, margin: '4px 0 4px',
};

/** The label a configuration input is named by — `Rounds`, `Minutes`. */
export const treeControlLabelStyle: React.CSSProperties = {
  color: '#666', fontSize: 13,
};

/** The unit after one — `min`. */
export const treeControlUnitStyle: React.CSSProperties = {
  color: '#888', fontSize: 12,
};

/** The `•` and the `–` that separate two controls on a row. */
export const treeSeparatorTextStyle: React.CSSProperties = {
  color: '#aaa', fontSize: 13,
};

/** A block's configuration, summarised beside its name outside Edit mode. */
export const treeSummaryTextStyle: React.CSSProperties = {
  fontWeight: 400, color: '#888', fontSize: 12.5, marginLeft: 6,
};

/**
 * The area that accepts a block dragged in from another template.
 *
 * `active` is "a foreign block is over it": the highlight is the Theme's own
 * app background and input border rather than the lilac pair it was, for the
 * reason {@link TREE_COMBO_ITEM_SELECTED_BG} is — a drop affordance is not a
 * primary action and must not borrow an action's colour either.
 */
export function treeDropTargetStyle(active: boolean): React.CSSProperties {
  return {
    margin: '-6px -8px', padding: '6px 8px', borderRadius: 6,
    background: active ? 'var(--gd-app-bg, #f0f0f0)' : undefined,
    outline: active ? '2px dashed var(--gd-input-border, #c8c8d0)' : 'none',
    transition: 'background 0.1s',
  };
}
