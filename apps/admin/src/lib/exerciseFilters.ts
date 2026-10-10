/**
 * The exercise lists' filter state, and the query it becomes (#969).
 *
 * JSX-free on purpose: the three screens the ticket names — Base Exercises, the
 * Import modal and a gym's own Exercises — render **one** toolbar
 * (`components/exercises/ExerciseFilterBar.tsx`) over this one declaration, so
 * "do not create three independent implementations of the same filtering UX"
 * (§19) holds at the level of the state as well as the markup, and the mapping
 * onto the API's parameters is assertable without a DOM.
 *
 * Nothing here filters anything: the rows are narrowed server-side
 * (`api/src/domain/exerciseListFilters.ts`, §16/§17), which is also the
 * repository's standing rule against a second copy of a business rule in the
 * frontend. What this module decides is only what the controls hold, what the
 * request carries and which chips the active filters read as (§12).
 */

/** Whether several checked muscles mean OR or AND (§6). Mirrors the API's set. */
export type ExerciseMuscleMatch = 'any' | 'all';

/** Which role a checked muscle has to be in (§7). `any` is either. */
export type ExerciseMuscleRole = 'any' | 'primary' | 'secondary';

export interface ExerciseFilterState {
  /** Name or translation, in any language (§3/§18) — never only the one on screen. */
  q: string;
  /** `''` = every status (§10). */
  status: string;
  muscles: string[];
  muscleMatch: ExerciseMuscleMatch;
  muscleRole: ExerciseMuscleRole;
  /**
   * The ticket's `[ Exercise Type ▾ ]`, which the thread settled is the
   * dataset's **equipment** axis (Bodyweight, Machine, Dumbbell, …) — there is
   * no `exercises.exercise_type` column to filter, migration 074 dropped it.
   */
  equipment: string[];
  category: string[];
}

export const EMPTY_EXERCISE_FILTER: ExerciseFilterState = {
  q: '',
  status: '',
  muscles: [],
  muscleMatch: 'any',
  muscleRole: 'any',
  equipment: [],
  category: [],
};

/** Which parameter a muscle role sends — the three the API already understands. */
const MUSCLE_PARAM: Record<ExerciseMuscleRole, string> = {
  any: 'muscle',
  primary: 'primary_muscle',
  secondary: 'secondary_muscle',
};

/** Whether the list is narrowed at all — what gates the chips and `Clear`. */
export function isExerciseFilterActive(state: ExerciseFilterState): boolean {
  return state.q.trim() !== ''
    || state.status !== ''
    || state.muscles.length > 0
    || state.equipment.length > 0
    || state.category.length > 0;
}

/**
 * The query string the list request carries — `''` when nothing is filtered.
 *
 * The muscle role chooses **which** parameter the values go in rather than
 * sending a fourth one, because `?primary_muscle=chest` is what the endpoint
 * has understood since #964; `muscle_match` rides along only when it can change
 * the answer (two or more muscles), so an unfiltered-looking request stays
 * unfiltered.
 */
export function exerciseFilterQuery(state: ExerciseFilterState): string {
  const params = new URLSearchParams();
  const q = state.q.trim();
  if (q) params.set('q', q);
  if (state.status) params.set('status', state.status);
  if (state.muscles.length > 0) {
    params.set(MUSCLE_PARAM[state.muscleRole], state.muscles.join(','));
    if (state.muscles.length > 1) params.set('muscle_match', state.muscleMatch);
  }
  if (state.equipment.length > 0) params.set('equipment', state.equipment.join(','));
  if (state.category.length > 0) params.set('category', state.category.join(','));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * A free-text facet value as a label.
 *
 * `equipment` and `category` are preserved verbatim from the Free Exercise DB
 * (#964 §7, §11), so there is no locale key per value and there must not be
 * one: a value the dataset adds tomorrow would print the key verbatim, which is
 * what next-intl does with a missing key. Humanizing the stored value is the
 * honest answer, and it is decided here rather than inside a `t()` call.
 */
export function exerciseFacetValueLabel(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** One active-filter chip: what it reads, and the state removing it produces. */
export interface ExerciseFilterChip {
  key: string;
  label: string;
  next: ExerciseFilterState;
}

/**
 * The chips §12 asks for: compact, inline, one per applied criterion, each
 * removable on its own.
 *
 * The labels are the page's — a muscle's comes from the shared `useMuscleLabel`
 * hook and a status's from the `status` namespace — so this module resolves no
 * locale key and the chip row can be asserted without a translator.
 */
export function exerciseFilterChips(
  state: ExerciseFilterState,
  labels: {
    search: (value: string) => string;
    status: (value: string) => string;
    muscle: (key: string) => string;
    equipment: (value: string) => string;
    category: (value: string) => string;
  },
): ExerciseFilterChip[] {
  const chips: ExerciseFilterChip[] = [];
  const q = state.q.trim();
  if (q) chips.push({ key: 'q', label: labels.search(q), next: { ...state, q: '' } });
  if (state.status) {
    chips.push({ key: `status:${state.status}`, label: labels.status(state.status), next: { ...state, status: '' } });
  }
  for (const muscle of state.muscles) {
    chips.push({
      key: `muscle:${muscle}`,
      label: labels.muscle(muscle),
      next: { ...state, muscles: state.muscles.filter((m) => m !== muscle) },
    });
  }
  for (const value of state.equipment) {
    chips.push({
      key: `equipment:${value}`,
      label: labels.equipment(value),
      next: { ...state, equipment: state.equipment.filter((v) => v !== value) },
    });
  }
  for (const value of state.category) {
    chips.push({
      key: `category:${value}`,
      label: labels.category(value),
      next: { ...state, category: state.category.filter((v) => v !== value) },
    });
  }
  return chips;
}
