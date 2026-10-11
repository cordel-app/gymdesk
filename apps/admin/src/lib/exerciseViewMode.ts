/**
 * Which presentation the Exercise lists use (#1386): the existing expandable
 * list, or the image-first card grid. Pure — no React, no storage global — so
 * the choice and its persistence rules are assertable on their own.
 *
 * Cards is the default on a first visit; a saved choice wins afterwards. Every
 * storage access is guarded, because `localStorage` can throw (private window,
 * blocked site data) and the page must render the same without it.
 */
export const EXERCISE_VIEW_MODES = ['cards', 'list'] as const;
export type ExerciseViewMode = (typeof EXERCISE_VIEW_MODES)[number];
export const DEFAULT_EXERCISE_VIEW_MODE: ExerciseViewMode = 'cards';
export const EXERCISE_VIEW_MODE_STORAGE_KEY = 'gd-exercise-view-mode';

export function parseExerciseViewMode(value: unknown): ExerciseViewMode {
  return value === 'list' || value === 'cards' ? value : DEFAULT_EXERCISE_VIEW_MODE;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function readExerciseViewMode(storage: StorageLike | null | undefined): ExerciseViewMode {
  try {
    return parseExerciseViewMode(storage?.getItem(EXERCISE_VIEW_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_EXERCISE_VIEW_MODE;
  }
}

export function writeExerciseViewMode(storage: StorageLike | null | undefined, mode: ExerciseViewMode): void {
  try {
    storage?.setItem(EXERCISE_VIEW_MODE_STORAGE_KEY, mode);
  } catch { /* a per-viewer convenience: losing it costs nothing */ }
}
