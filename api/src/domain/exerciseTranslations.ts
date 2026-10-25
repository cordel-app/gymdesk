import { Tx } from '../infra/db';
import { SupportedLocale } from '../infra/locale';
import { ExerciseTables, LEGACY_EXERCISE_TABLES } from './exerciseTables';
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
 * `(exercise_id, locale)` in `exercise_translations` (migration 210), with
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
  // `exercises.name` is VARCHAR(200) (migration 023), and migration 210 mirrors
  // it: a translation that would not fit the base column is a 400, not a silent
  // truncation.
  maxNameLength: 200,
};

/** The junction configuration over `tables` (#1849 E2): the legacy table unless told otherwise. */
export function exerciseTranslationsConfig(tables: ExerciseTables = LEGACY_EXERCISE_TABLES): TranslatedNameConfig {
  return tables.translations === EXERCISE_TRANSLATIONS.table ? EXERCISE_TRANSLATIONS : { ...EXERCISE_TRANSLATIONS, table: tables.translations };
}

/**
 * SQL resolving an exercise's name in `locale`, falling back to `name`.
 *
 * @param alias table alias of `exercises` in the enclosing query
 */
export function localizedExerciseNameSql(alias: string, locale: SupportedLocale, tables: ExerciseTables = LEGACY_EXERCISE_TABLES): string {
  return translatedNameSql(exerciseTranslationsConfig(tables), alias, locale);
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
  tables: ExerciseTables = LEGACY_EXERCISE_TABLES,
): string {
  return translatedNameExpr(exerciseTranslationsConfig(tables), alias, locale, as);
}

/**
 * A `?q=` clause matching the base name **or** any stored translation (#967
 * §7): a gym searching `Press de Banca` finds the exercise whose base name is
 * `Bench Press`. Carries two placeholders — bind the same `%pattern%` twice.
 */
export function exerciseNameSearchSql(alias: string, tables: ExerciseTables = LEGACY_EXERCISE_TABLES): string {
  return translatedNameSearchSql(exerciseTranslationsConfig(tables), alias);
}

/**
 * The row's own `translations` map, projected beside `name` and `display_name`.
 *
 * Every exercise read carries it, list reads included: `⋮ → Edit` seeds the form
 * from the row the page already holds (#800), and a form seeded without the
 * translations would submit an empty replace-all set and wipe them.
 */
export function exerciseTranslationsExpr(alias: string, as = 'translations', tables: ExerciseTables = LEGACY_EXERCISE_TABLES): string {
  return translationsAggregateExpr(exerciseTranslationsConfig(tables), alias, as);
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
  tables: ExerciseTables = LEGACY_EXERCISE_TABLES,
): Promise<void> {
  return replaceTranslationsFor(exerciseTranslationsConfig(tables), tx, exerciseId, translations);
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
  source: ExerciseTables = LEGACY_EXERCISE_TABLES,
): Promise<void> {
  // The copy always lands on the gym-owned (legacy) junction; `source` is where the
  // original lives (#1849 E2: a Base exercise's names sit in `base_exercise_translations`).
  if (source.translations === EXERCISE_TRANSLATIONS.table) {
    return copyTranslationsFor(EXERCISE_TRANSLATIONS, tx, sourceId, targetId);
  }
  return tx.query(
    `INSERT INTO ${EXERCISE_TRANSLATIONS.table} (${EXERCISE_TRANSLATIONS.entityColumn}, locale, name)
      SELECT ?, locale, name FROM ${source.translations} WHERE exercise_id = ?
      ON DUPLICATE KEY UPDATE name = VALUES(name), modified_at = UTC_TIMESTAMP()`,
    [targetId, sourceId],
  ).then(() => undefined);
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
