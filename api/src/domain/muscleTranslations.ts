import {
  TranslatedNameConfig,
  normalizeTranslationsField,
  replaceTranslationsFor,
  translationsAggregateExpr,
  validateTranslationsPayload,
} from './nameTranslations';

/**
 * A muscle's name in every supported language (#2402): the shared
 * `nameTranslations` mechanism configured for `muscle_translations`
 * (migration 371). `muscles.name` stays the base value and the fallback.
 */
export const MUSCLE_TRANSLATIONS: TranslatedNameConfig = {
  table: 'muscle_translations',
  entityColumn: 'muscle_id',
  subqueryAlias: 'mt',
  maxNameLength: 120,
};

export const muscleTranslationsExpr = (alias: string) => translationsAggregateExpr(MUSCLE_TRANSLATIONS, alias);
export const withMuscleTranslations = normalizeTranslationsField;
export const replaceMuscleTranslations = (
  tx: { query: (sql: string, params?: any[]) => Promise<any> },
  id: number | string,
  translations: Record<string, string>,
) => replaceTranslationsFor(MUSCLE_TRANSLATIONS, tx, id, translations);

/** Absent field keeps the stored rows; `{}` clears them. */
export function parseMuscleTranslations(
  body: Record<string, unknown>,
): { translations?: Record<string, string>; error?: string } {
  if (!body || !('translations' in body)) return {};
  const invalid = validateTranslationsPayload(body.translations, MUSCLE_TRANSLATIONS.maxNameLength);
  if (invalid) return { error: invalid.error };
  return { translations: (body.translations ?? {}) as Record<string, string> };
}
