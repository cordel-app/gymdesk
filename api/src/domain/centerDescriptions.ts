import { Tx } from '../infra/db';
import { BASE_LOCALE, SupportedLocale, TRANSLATABLE_LOCALES, isSupportedLocale } from '../infra/locale';
import { localeLiteral } from './nameTranslations';

/**
 * A Center's description in every supported language (#3342, migration 486).
 *
 * `centers.description` is the base-locale text and the fallback; every other
 * locale is one row of `center_description_translations`. #967's rules: a locale
 * with no (or a blank) value falls back to the base text, a write that omits
 * `description_translations` leaves the stored rows alone, an explicit `{}`
 * clears them, and a locale given blank loses its row.
 */
export const CENTER_DESCRIPTION_MAX = 2000;

const TABLE = 'center_description_translations';

/** `display_description`, the request locale's text (else the base one). */
export function centerDisplayDescriptionSql(alias: string, locale: SupportedLocale): string {
  const literal = localeLiteral(locale);
  if (!literal) return `${alias}.description AS display_description`;
  return `COALESCE((SELECT NULLIF(cdt.description, '') FROM ${TABLE} cdt
            WHERE cdt.center_id = ${alias}.id AND cdt.locale = ${literal}), ${alias}.description) AS display_description`;
}

/** `{ locale: description }`, `NULL` when there are none (see `withCenterDescriptionTranslations`). */
export function centerDescriptionTranslationsSql(alias: string): string {
  return `(SELECT JSON_OBJECTAGG(cdta.locale, cdta.description)
            FROM ${TABLE} cdta WHERE cdta.center_id = ${alias}.id) AS description_translations`;
}

/** The aggregate's `NULL`-for-none as the `{}` the API reports. */
export function withCenterDescriptionTranslations<T extends { description_translations?: unknown }>(row: T): T {
  if (row === null || row === undefined) return row;
  let value: unknown = row.description_translations;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  const map = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { ...row, description_translations: map };
}

type Parsed<T> = { provided: false } | { provided: true; value: T } | { provided: true; error: string };

/** The base `description`: absent keeps, `null`/blank clears, else a string within the limit. */
export function parseCenterDescription(body: Record<string, unknown>): Parsed<string | null> {
  if (!('description' in body)) return { provided: false };
  const v = body.description;
  if (v === null || v === undefined) return { provided: true, value: null };
  if (typeof v !== 'string') return { provided: true, error: 'description must be a string' };
  const trimmed = v.trim();
  if (trimmed.length > CENTER_DESCRIPTION_MAX) {
    return { provided: true, error: `description must be ${CENTER_DESCRIPTION_MAX} characters or fewer` };
  }
  return { provided: true, value: trimmed || null };
}

/** `description_translations`: an object keyed by a supported, non-base locale whose values are strings. */
export function parseCenterDescriptionTranslations(body: Record<string, unknown>): Parsed<Record<string, string>> {
  if (!('description_translations' in body)) return { provided: false };
  const value = body.description_translations;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { provided: true, error: 'description_translations must be an object keyed by locale' };
  }
  const out = new Map<string, string>();
  for (const [locale, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isSupportedLocale(locale)) {
      return { provided: true, error: `description_translations contains an unsupported locale: ${locale}` };
    }
    if (locale.toLowerCase() === BASE_LOCALE) {
      return { provided: true, error: `description_translations must not contain the base locale '${BASE_LOCALE}' — use description` };
    }
    if (entry !== null && entry !== undefined && typeof entry !== 'string') {
      return { provided: true, error: `description_translations.${locale} must be a string` };
    }
    const text = typeof entry === 'string' ? entry.trim() : '';
    if (text.length > CENTER_DESCRIPTION_MAX) {
      return { provided: true, error: `description_translations.${locale} must be ${CENTER_DESCRIPTION_MAX} characters or fewer` };
    }
    // The key written is the allowlist's own element, never the request's string (data flow, not trust).
    const key = TRANSLATABLE_LOCALES.find((candidate) => candidate === locale.toLowerCase());
    if (text && key) out.set(key, text);
  }
  const result: Record<string, string> = {};
  for (const l of TRANSLATABLE_LOCALES) {
    const text = out.get(l);
    if (text) result[l] = text;
  }
  return { provided: true, value: result };
}

/** Replace every translation of one Center, inside the caller's transaction. */
export async function replaceCenterDescriptionTranslations(
  tx: Tx, centerId: number | string, translations: Record<string, string>,
): Promise<void> {
  await tx.query(`DELETE FROM ${TABLE} WHERE center_id = ?`, [centerId]);
  const kept = TRANSLATABLE_LOCALES.filter((l) => translations[l]);
  if (kept.length === 0) return;
  await tx.query(
    `INSERT INTO ${TABLE} (center_id, locale, description) VALUES ${kept.map(() => '(?, ?, ?)').join(', ')}`,
    kept.flatMap((l) => [centerId, l, translations[l]]),
  );
}
