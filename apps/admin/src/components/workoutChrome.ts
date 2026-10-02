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

import { dashedAddBtnStyle } from './formChrome';

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
