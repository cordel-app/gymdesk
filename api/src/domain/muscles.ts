/**
 * #1368 stage 2: the `muscles` table is the runtime catalogue (routers, filters and
 * the importer read and write it through `api/exercise-muscles.ts`). This list is
 * what migration 253 seeded and what the pure importer uses to tell a known
 * muscle from a new one; it is no longer authoritative for what is offered.
 *
 * #62: muscles are a fixed catalog, not per-gym DB rows. Keys are stable
 * slugs stored on exercise_muscles.muscle; display names are an admin-app
 * i18n concern. Legacy keys migrated from the old muscles table may fall
 * outside this list — they stay valid on existing links but are not offered
 * for new selections.
 *
 * #964 extended it: the Free Exercise DB import maps the dataset's own muscle
 * names onto this catalogue and §8 requires that a source muscle which is not
 * here yet be **created** rather than dropped. There is no muscles table to
 * insert into (migration 052 dropped it), so "created" means two things, and the
 * second one is this list:
 *
 *   1. `exercise_muscles.muscle` accepts any key matching `MUSCLE_KEY_PATTERN`,
 *      so the link is stored whatever happens and the import never fails over a
 *      muscle (§8, §16);
 *   2. a key listed here is **offered** by `GET /muscles`, by
 *      `GET /platform/exercises/lookups` and therefore by the shared Exercise
 *      editor's picker, and is shown under its translated label.
 *
 * So adding a muscle goes in **two** places: this list and a `muscles.<key>`
 * entry in `apps/admin/locales/base/{en,es,ca}.json` — next-intl prints a missing
 * key verbatim, and `useMuscleLabel()` only falls back to a humanized key for a
 * muscle that is *not* in this list. The eight keys after `core` are the Free
 * Exercise DB values that had no existing counterpart; `quadriceps` and
 * `abdominals` are not among them because they are this catalogue's `quads` and
 * `core` under another name, which `FREE_EXERCISE_DB_MUSCLE_ALIASES`
 * (`domain/freeExerciseDb.ts`) is what decides.
 */
export const MUSCLE_KEYS = [
  'chest', 'back', 'shoulders', 'biceps', 'triceps',
  'quads', 'hamstrings', 'glutes', 'calves', 'core',
  'lats', 'middle_back', 'lower_back', 'traps',
  'forearms', 'adductors', 'abductors', 'neck',
] as const;

export type MuscleKey = (typeof MUSCLE_KEYS)[number];

const MUSCLE_KEY_PATTERN = /^[a-z0-9_]{1,60}$/;

/** Normalizes arbitrary input to a storable muscle key, or null if invalid. */
export function normalizeMuscleKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return MUSCLE_KEY_PATTERN.test(key) ? key : null;
}

/** Whether the key is one this catalogue offers (as opposed to a legacy or imported one). */
export function isKnownMuscleKey(value: string): boolean {
  return (MUSCLE_KEYS as readonly string[]).includes(value);
}
