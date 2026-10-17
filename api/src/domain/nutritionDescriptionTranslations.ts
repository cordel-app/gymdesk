import { db, Tx } from '../infra/db';
import { SupportedLocale, TRANSLATABLE_LOCALES, isSupportedLocale, BASE_LOCALE } from '../infra/locale';
import { localeLiteral } from './nameTranslations';
import { DESCRIPTION_MAX_LENGTH } from './nutritionLibrary';

/**
 * Nutrition Library item descriptions in every supported language (#1720).
 *
 * `nutrition_library_items.description` is the base-locale value and the
 * fallback; every other locale is one row of
 * `nutrition_library_item_description_translations` (migration 291). Rules are
 * #967's: a locale with no (or a blank) value falls back to the base one, a
 * write that omits `description_translations` leaves the stored rows alone and
 * an explicit `{}` clears them.
 */
const TABLE = 'nutrition_library_item_description_translations';

/** The description resolved for `locale`, falling back to the base column. */
export function localizedDescriptionSql(alias: string, locale: SupportedLocale): string {
  const literal = localeLiteral(locale);
  if (!literal) return `${alias}.description`;
  return `COALESCE((SELECT NULLIF(nlidt.description, '') FROM ${TABLE} nlidt
            WHERE nlidt.item_id = ${alias}.id AND nlidt.locale = ${literal}), ${alias}.description)`;
}

/** item_id → { locale: description } */
export async function loadDescriptionTranslationsMap(
  itemIds: number[],
): Promise<Record<number, Record<string, string>>> {
  if (itemIds.length === 0) return {};
  const { rows } = await db.query<{ item_id: number; locale: string; description: string }>(
    `SELECT item_id, locale, description FROM ${TABLE} WHERE item_id IN (${itemIds.map(() => '?').join(',')})`,
    itemIds,
  );
  const map: Record<number, Record<string, string>> = {};
  for (const r of rows) (map[r.item_id] ??= {})[r.locale] = r.description;
  return map;
}

/**
 * Validate a `description_translations` payload: an object keyed by a supported,
 * non-base locale with string values.
 */
export function validateDescriptionTranslations(value: unknown): { error: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'description_translations must be an object keyed by locale' };
  }
  for (const [locale, text] of Object.entries(value as Record<string, unknown>)) {
    if (!isSupportedLocale(locale)) {
      return { error: `description_translations contains an unsupported locale: ${locale}` };
    }
    if (locale === BASE_LOCALE) {
      return { error: `description_translations must not contain the base locale '${BASE_LOCALE}' — use description` };
    }
    if (typeof text !== 'string') return { error: `description_translations.${locale} must be a string` };
    if (text.trim().length > DESCRIPTION_MAX_LENGTH) {
      return { error: `description_translations.${locale} must be at most ${DESCRIPTION_MAX_LENGTH} characters` };
    }
  }
  return null;
}

/** The accepted map, `undefined` when the request does not mention the field. */
export function parseDescriptionTranslations(
  body: Record<string, unknown>,
): { value?: Record<string, string>; error?: string } {
  if (!('description_translations' in body)) return {};
  const invalid = validateDescriptionTranslations(body.description_translations);
  if (invalid) return { error: invalid.error };
  return { value: body.description_translations as Record<string, string> };
}

/** Replace the whole set for one item inside the caller's transaction; blank locales lose their row. */
export async function replaceDescriptionTranslations(
  tx: Tx,
  itemId: number | string,
  translations: Record<string, string>,
): Promise<void> {
  const kept = TRANSLATABLE_LOCALES.filter((l) => (translations?.[l] ?? '').trim() !== '');
  if (kept.length === 0) {
    await tx.query(`DELETE FROM ${TABLE} WHERE item_id = ?`, [itemId]);
    return;
  }
  await tx.query(
    `DELETE FROM ${TABLE} WHERE item_id = ? AND locale NOT IN (${kept.map(() => '?').join(',')})`,
    [itemId, ...kept],
  );
  for (const locale of kept) {
    await tx.query(
      `INSERT INTO ${TABLE} (item_id, locale, description) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE description = VALUES(description), modified_at = UTC_TIMESTAMP()`,
      [itemId, locale, translations[locale].trim()],
    );
  }
}
