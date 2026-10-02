import { Tx } from '../infra/db';
import { SupportedLocale } from '../infra/locale';
import {
  TranslatedNameConfig,
  copyTranslationsFor,
  normalizeTranslationsField,
  replaceTranslationsFor,
  translatedNameExpr,
  translatedNameSearchSql,
  translatedNameSql,
  translationsAggregateExpr,
  validateTranslationsPayload,
} from './nameTranslations';

/**
 * Exercise names in every supported language (#967).
 *
 * An exercise's name is the only field a member ever reads in a workout, and it
 * existed in one language. The shape is the one `CLAUDE.md` pins for translated
 * *data* and #643 built for the Nutrition Library: one row per
 * `(exercise_id, locale)` in `exercise_translations` (migration 208), with
 * `exercises.name` staying the base (English) value, the fallback for a locale
 * with no row, and the value an edit form submits back.
 *
 * Both kinds of exercise use it — a **Base Exercise** (`gym_id IS NULL`) and a
 * **Custom Gym Exercise** — because they are one table and one contract (#967
 * §8): nothing downstream branches on where the exercise came from, and the
 * copy a gym imports carries the platform's translations with it.
 *
 * The rules themselves are `domain/nameTranslations.ts`; this module is only
 * the exercise's configuration of them, so no query has to know the junction
 * table's name or its FK column.
 */
export const EXERCISE_TRANSLATIONS: TranslatedNameConfig = {
  table: 'exercise_translations',
  entityColumn: 'exercise_id',
  subqueryAlias: 'ext',
  // `exercises.name` is VARCHAR(200) (migration 023), and migration 208 mirrors
  // it: a translation that would not fit the base column is a 400, not a silent
  // truncation.
  maxNameLength: 200,
};

/**
 * SQL resolving an exercise's name in `locale`, falling back to `name`.
 *
 * @param alias table alias of `exercises` in the enclosing query
 */
export function localizedExerciseNameSql(alias: string, locale: SupportedLocale): string {
  return translatedNameSql(EXERCISE_TRANSLATIONS, alias, locale);
}

/**
 * {@link localizedExerciseNameSql} with an output alias. The default is
 * `exercise_name`, which is what every consumer surface (workout templates,
 * training plans, exercise logs, the member app) already reads — those are
 * read-only, so the localized value takes the field's place there. The
 * exercises routers themselves pass `display_name` instead and leave `name` as
 * the base value, because their rows back an edit form (#643: prefill a form
 * from a translation and saving in Spanish overwrites the English original).
 */
export function localizedExerciseNameExpr(
  alias: string,
  locale: SupportedLocale,
  as = 'exercise_name',
): string {
  return translatedNameExpr(EXERCISE_TRANSLATIONS, alias, locale, as);
}

/**
 * A `?q=` clause matching the base name **or** any stored translation (#967
 * §7): a gym searching `Press de Banca` finds the exercise whose base name is
 * `Bench Press`. Carries two placeholders — bind the same `%pattern%` twice.
 */
export function exerciseNameSearchSql(alias: string): string {
  return translatedNameSearchSql(EXERCISE_TRANSLATIONS, alias);
}

/**
 * The row's own `translations` map, projected beside `name` and `display_name`.
 *
 * Every exercise read carries it, list reads included: `⋮ → Edit` seeds the form
 * from the row the page already holds (#800), and a form seeded without the
 * translations would submit an empty replace-all set and wipe them.
 */
export function exerciseTranslationsExpr(alias: string, as = 'translations'): string {
  return translationsAggregateExpr(EXERCISE_TRANSLATIONS, alias, as);
}

/** `{}` rather than `NULL` for an exercise with no translations. */
export function withExerciseTranslations<T extends { translations?: unknown }>(row: T): T {
  return normalizeTranslationsField(row);
}

/**
 * Replace an exercise's translations, inside the caller's transaction so the
 * names and the row they belong to commit together.
 */
export function replaceExerciseTranslations(
  tx: Tx,
  exerciseId: number | string,
  translations: Record<string, string>,
): Promise<void> {
  return replaceTranslationsFor(EXERCISE_TRANSLATIONS, tx, exerciseId, translations);
}

/**
 * Copy the translations of one exercise onto another — Duplicate, Clone, and
 * the Base Exercise **import**, which is what makes #967 §4 true: the gym's own
 * copy keeps the three names the platform catalogue supplied rather than
 * reading in English for its Spanish and Catalan members.
 */
export function copyExerciseTranslations(
  tx: Tx,
  sourceId: number | string,
  targetId: number | string,
): Promise<void> {
  return copyTranslationsFor(EXERCISE_TRANSLATIONS, tx, sourceId, targetId);
}

/** Validate a `translations` payload for an exercise. */
export function validateExerciseTranslations(value: unknown): { error: string } | null {
  return validateTranslationsPayload(value, EXERCISE_TRANSLATIONS.maxNameLength);
}

/**
 * The `translations` object a write accepted, or `undefined` when the request
 * did not mention the field at all — which leaves the stored rows alone, the
 * same distinction every replace-all section `PUT` in the codebase draws. An
 * explicit `{}` clears them.
 */
export function parseExerciseTranslations(
  body: Record<string, unknown>,
): { translations?: Record<string, string>; error?: string } {
  if (!('translations' in body)) return {};
  const value = body.translations;
  const invalid = validateExerciseTranslations(value);
  if (invalid) return { error: invalid.error };
  return { translations: (value ?? {}) as Record<string, string> };
}
