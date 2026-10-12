import { Tx } from '../infra/db';
import { SupportedLocale, TRANSLATABLE_LOCALES, isSupportedLocale, BASE_LOCALE } from '../infra/locale';
import { localeLiteral } from './nameTranslations';

/**
 * Exercise descriptions in every supported language (#1419).
 *
 * `exercises.short_description` / `exercises.description` are the base-locale
 * values and the fallback; every other locale is one row of
 * `exercise_description_translations` (migration 275). It follows #967's rules —
 * a locale with no (or a blank) value falls back to the base one, a write that
 * omits the field leaves the stored rows alone and an explicit `{}` clears them
 * — but it is a sibling of `exercise_translations` rather than an extension of
 * it, because that table's `name` is NOT NULL and its replace-all write deletes
 * any locale whose name is blank.
 */
export const SHORT_DESCRIPTION_MAX = 300;
export const DESCRIPTION_MAX = 5000;

export interface DescriptionTranslation {
  short_description: string;
  description: string;
}

const TABLE = 'exercise_description_translations';

function expr(column: 'short_description' | 'description', alias: string, locale: SupportedLocale): string {
  const literal = localeLiteral(locale);
  if (!literal) return `${alias}.${column}`;
  return `COALESCE((SELECT NULLIF(edt.${column}, '') FROM ${TABLE} edt
            WHERE edt.exercise_id = ${alias}.id AND edt.locale = ${literal}), ${alias}.${column})`;
}

/** `display_short_description` and `display_description`, resolved for `locale`. */
export function localizedDescriptionExprs(alias: string, locale: SupportedLocale): string {
  return `${expr('short_description', alias, locale)} AS display_short_description,
    ${expr('description', alias, locale)} AS display_description`;
}

/** `{ locale: { short_description, description } }`, `NULL` when there are none. */
export function descriptionTranslationsExpr(alias: string, as = 'description_translations'): string {
  return `(SELECT JSON_OBJECTAGG(edta.locale, JSON_OBJECT('short_description', edta.short_description, 'description', edta.description))
            FROM ${TABLE} edta WHERE edta.exercise_id = ${alias}.id) AS ${as}`;
}

/** The aggregate's `NULL`-for-none as the `{}` the API contract promises. */
export function withDescriptionTranslations<T extends { description_translations?: unknown }>(row: T): T {
  if (row === null || row === undefined) return row;
  let value: unknown = row.description_translations;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...row, description_translations: value };
  }
  return { ...row, description_translations: {} };
}

/**
 * Validate a `description_translations` payload: an object keyed by a supported,
 * non-base locale whose values are `{ short_description?, description? }`.
 */
export function validateDescriptionTranslations(value: unknown): { error: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'description_translations must be an object keyed by locale' };
  }
  for (const [locale, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isSupportedLocale(locale)) {
      return { error: `description_translations contains an unsupported locale: ${locale}` };
    }
    if (locale === BASE_LOCALE) {
      return { error: `description_translations must not contain the base locale '${BASE_LOCALE}' — use short_description and description` };
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: `description_translations.${locale} must be an object` };
    }
    const { short_description, description } = entry as Record<string, unknown>;
    for (const [field, max, v] of [
      ['short_description', SHORT_DESCRIPTION_MAX, short_description],
      ['description', DESCRIPTION_MAX, description],
    ] as const) {
      if (v !== undefined && v !== null && typeof v !== 'string') {
        return { error: `description_translations.${locale}.${field} must be a string` };
      }
      if (typeof v === 'string' && v.trim().length > max) {
        return { error: `description_translations.${locale}.${field} must be ${max} characters or fewer` };
      }
    }
  }
  return null;
}

/** The accepted map, or `undefined` when the request does not mention the field (rows left alone). */
export function parseDescriptionTranslations(
  body: Record<string, unknown>,
): { descriptionTranslations?: Record<string, Partial<DescriptionTranslation>>; error?: string } {
  if (!('description_translations' in body)) return {};
  const value = body.description_translations;
  const invalid = validateDescriptionTranslations(value);
  if (invalid) return { error: invalid.error };
  return { descriptionTranslations: (value ?? {}) as Record<string, Partial<DescriptionTranslation>> };
}

/** Validates the base `short_description`; `undefined` value = not mentioned. */
export function parseShortDescription(
  body: Record<string, unknown>,
): { provided: boolean; value: string | null; error?: string } {
  if (!('short_description' in body)) return { provided: false, value: null };
  const v = body.short_description;
  if (v === null || v === '') return { provided: true, value: null };
  if (typeof v !== 'string') return { provided: true, value: null, error: 'short_description must be a string' };
  if (v.trim().length > SHORT_DESCRIPTION_MAX) {
    return { provided: true, value: null, error: `short_description must be ${SHORT_DESCRIPTION_MAX} characters or fewer` };
  }
  return { provided: true, value: v.trim() };
}

/**
 * Replace all description translations of one exercise, inside the caller's
 * transaction. A locale whose two values are both blank loses its row.
 */
export async function replaceExerciseDescriptionTranslations(
  tx: Tx,
  exerciseId: number | string,
  translations: Record<string, Partial<DescriptionTranslation>>,
): Promise<void> {
  const byLocale = new Map<string, DescriptionTranslation>();
  for (const [locale, entry] of Object.entries(translations ?? {})) {
    const short = typeof entry?.short_description === 'string' ? entry.short_description.trim() : '';
    const full = typeof entry?.description === 'string' ? entry.description.trim() : '';
    if (short || full) byLocale.set(locale.trim().toLowerCase(), { short_description: short, description: full });
  }
  const kept = TRANSLATABLE_LOCALES.filter((l) => byLocale.has(l));
  if (kept.length === 0) {
    await tx.query(`DELETE FROM ${TABLE} WHERE exercise_id = ?`, [exerciseId]);
    return;
  }
  await tx.query(
    `DELETE FROM ${TABLE} WHERE exercise_id = ? AND locale NOT IN (${kept.map(() => '?').join(',')})`,
    [exerciseId, ...kept],
  );
  for (const locale of kept) {
    const v = byLocale.get(locale)!;
    await tx.query(
      `INSERT INTO ${TABLE} (exercise_id, locale, short_description, description) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE short_description = VALUES(short_description),
         description = VALUES(description), modified_at = UTC_TIMESTAMP()`,
      [exerciseId, locale, v.short_description || null, v.description || null],
    );
  }
}

/** Duplicate / Clone / Base Exercise import: the descriptions travel with the copy. */
export async function copyExerciseDescriptionTranslations(
  tx: Tx,
  sourceId: number | string,
  targetId: number | string,
): Promise<void> {
  // The base short description is a column of `exercises`, so it travels here
  // too: the INSERTs of the three copy paths predate it.
  await tx.query(
    'UPDATE exercises t JOIN exercises s ON s.id = ? SET t.short_description = s.short_description WHERE t.id = ?',
    [sourceId, targetId],
  );
  await tx.query(
    `INSERT INTO ${TABLE} (exercise_id, locale, short_description, description)
      SELECT ?, locale, short_description, description FROM ${TABLE} WHERE exercise_id = ?
      ON DUPLICATE KEY UPDATE short_description = VALUES(short_description),
        description = VALUES(description), modified_at = UTC_TIMESTAMP()`,
    [targetId, sourceId],
  );
}
