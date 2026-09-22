import { db } from '../infra/db';
import { BASE_LOCALE, SupportedLocale, TRANSLATABLE_LOCALES, isSupportedLocale } from '../infra/locale';

/**
 * Shared helpers for the Nutrition Library, used by both the platform
 * (Cordel admin, system-owned items) and gym-facing routers (#350).
 *
 * Categories (main dish, side, ...) and nutritional qualities (protein,
 * fat, ...) are both global catalogues (no gym_id) joined to items through
 * an M2M table (#501) — a food classifies into one or more categories,
 * independently of the nutritional qualities it has.
 *
 * Item *names* are translated per locale through `nutrition_library_item_translations`
 * (#643), following that same junction shape. `nutrition_library_items.name`
 * remains the base (English) value and the fallback for any locale with no row,
 * so every read surface resolves a name through `localizedNameExpr`.
 */

/* ── Translated names (#643) ─────────────────────────────────────────────── */

const TRANSLATIONS_TABLE = 'nutrition_library_item_translations';

/**
 * SQL expression resolving an item's name in `locale`, falling back to the base
 * `name` column when that locale has no row.
 *
 * `locale` is interpolated rather than parameterised because the same
 * expression is embedded in ~30 queries that each carry their own positional
 * params — threading one more `?` through every call site is where the bugs
 * would be. It is safe: the value is a {@link SupportedLocale}, which only
 * `infra/locale.ts` mints and only after matching a strict BCP-47 allowlist
 * pattern, so it can never carry a quote. Request input reaches this function
 * solely through `getRequestLocale`, which maps anything unrecognised onto the
 * base locale.
 *
 * @param alias table alias of `nutrition_library_items` in the enclosing query
 */
export function localizedNameSql(alias: string, locale: SupportedLocale): string {
  if (locale === BASE_LOCALE) return `${alias}.name`;
  return `COALESCE((SELECT nlit.name FROM ${TRANSLATIONS_TABLE} nlit
            WHERE nlit.item_id = ${alias}.id AND nlit.locale = '${locale}'), ${alias}.name)`;
}

/** {@link localizedNameSql} with an output alias, for SELECT lists. */
export function localizedNameExpr(alias: string, locale: SupportedLocale, as = 'item_name'): string {
  return `${localizedNameSql(alias, locale)} AS ${as}`;
}

/** Return translations for a set of item IDs as a map: item_id → { locale: name } */
export async function loadTranslationsMap(itemIds: number[]): Promise<Record<number, Record<string, string>>> {
  if (itemIds.length === 0) return {};
  const marks = itemIds.map(() => '?').join(',');
  const { rows } = await db.query<{ item_id: number; locale: string; name: string }>(
    `SELECT item_id, locale, name FROM ${TRANSLATIONS_TABLE}
     WHERE item_id IN (${marks})
     ORDER BY locale`,
    itemIds,
  );
  const map: Record<number, Record<string, string>> = {};
  for (const row of rows) {
    if (!map[row.item_id]) map[row.item_id] = {};
    map[row.item_id][row.locale] = row.name;
  }
  return map;
}

/**
 * Replace all translations for an item inside a transaction, mirroring
 * `replaceCategories`/`replaceQualities`: the payload is the complete set, so a
 * locale the caller omits (or sends blank) loses its row and falls back to the
 * base name.
 */
export async function replaceTranslations(
  itemId: number,
  translations: Record<string, string>,
): Promise<void> {
  // Locale keys are matched case-insensitively (`validateTranslations` accepts
  // `ES` as readily as `es`), so canonicalise them before the lookup below —
  // otherwise a payload that validated fine would save nothing.
  const byLocale = new Map<string, string>();
  for (const [locale, name] of Object.entries(translations ?? {})) {
    byLocale.set(locale.trim().toLowerCase(), typeof name === 'string' ? name.trim() : '');
  }

  const kept = TRANSLATABLE_LOCALES.filter((locale) => byLocale.get(locale));

  await db.transaction(async (conn) => {
    // Clear the locales this payload drops, then upsert the rest: an edit keeps
    // the row's original `created_at` and stamps `modified_at`, which a
    // delete-then-insert would lose.
    if (kept.length === 0) {
      await conn.query(`DELETE FROM ${TRANSLATIONS_TABLE} WHERE item_id = ?`, [itemId]);
    } else {
      const marks = kept.map(() => '?').join(',');
      await conn.query(
        `DELETE FROM ${TRANSLATIONS_TABLE} WHERE item_id = ? AND locale NOT IN (${marks})`,
        [itemId, ...kept],
      );
    }
    for (const locale of kept) {
      await conn.query(
        `INSERT INTO ${TRANSLATIONS_TABLE} (item_id, locale, name) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), modified_at = UTC_TIMESTAMP()`,
        [itemId, locale, byLocale.get(locale)],
      );
    }
  });
}

/**
 * Validate a `translations` payload: an object keyed by supported locale, with
 * string values. The base locale is rejected — it is the item's own `name`
 * column, not a translation — and unknown locales are rejected rather than
 * silently dropped, so a typo'd key doesn't look like it saved.
 */
export function validateTranslations(value: unknown): { error: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'translations must be an object keyed by locale' };
  }
  for (const [locale, name] of Object.entries(value as Record<string, unknown>)) {
    if (!isSupportedLocale(locale)) {
      return { error: `translations contains an unsupported locale: ${locale}` };
    }
    if (locale === BASE_LOCALE) {
      return { error: `translations must not contain the base locale '${BASE_LOCALE}' — use name` };
    }
    if (name !== null && typeof name !== 'string') {
      return { error: `translations.${locale} must be a string` };
    }
    if (typeof name === 'string' && name.trim().length > 255) {
      return { error: `translations.${locale} must be 255 characters or fewer` };
    }
  }
  return null;
}

/** Return categories assigned to a set of item IDs as a map: item_id → [{id, slug}] */
export async function loadCategoriesMap(itemIds: number[]): Promise<Record<number, { id: number; slug: string }[]>> {
  if (itemIds.length === 0) return {};
  const marks = itemIds.map(() => '?').join(',');
  const { rows } = await db.query<{ item_id: number; category_id: number; slug: string }>(
    `SELECT nlic.item_id, nlc.id AS category_id, nlc.slug
     FROM nutrition_library_item_categories nlic
     JOIN nutrition_library_categories nlc ON nlc.id = nlic.category_id
     WHERE nlic.item_id IN (${marks})
     ORDER BY nlc.id`,
    itemIds,
  );
  const map: Record<number, { id: number; slug: string }[]> = {};
  for (const row of rows) {
    if (!map[row.item_id]) map[row.item_id] = [];
    map[row.item_id].push({ id: row.category_id, slug: row.slug });
  }
  return map;
}

/** Replace all category assignments for an item inside a transaction. */
export async function replaceCategories(itemId: number, categoryIds: number[]): Promise<void> {
  await db.transaction(async (conn) => {
    await conn.query('DELETE FROM nutrition_library_item_categories WHERE item_id = ?', [itemId]);
    for (const cid of categoryIds) {
      await conn.query(
        'INSERT INTO nutrition_library_item_categories (item_id, category_id) VALUES (?, ?)',
        [itemId, cid],
      );
    }
  });
}

/**
 * Validate that `ids` is a non-empty array of existing category IDs. A food
 * must always classify into at least one category, unlike nutritional
 * qualities which may be empty.
 */
export async function validateCategoryIds(ids: unknown): Promise<{ error: string } | null> {
  if (!Array.isArray(ids)) return { error: 'category_ids must be an array' };
  if (ids.length === 0) return { error: 'category_ids must contain at least one category' };
  if (ids.some((id) => typeof id !== 'number' || !Number.isInteger(id) || id <= 0)) {
    return { error: 'category_ids must be positive integers' };
  }
  const marks = ids.map(() => '?').join(',');
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM nutrition_library_categories WHERE id IN (${marks})`,
    ids,
  );
  if (rows.length !== new Set(ids).size) return { error: 'One or more category_ids are invalid' };
  return null;
}

/** Return qualities assigned to a set of item IDs as a map: item_id → [{id, slug}] */
export async function loadQualitiesMap(itemIds: number[]): Promise<Record<number, { id: number; slug: string }[]>> {
  if (itemIds.length === 0) return {};
  const marks = itemIds.map(() => '?').join(',');
  const { rows } = await db.query<{ item_id: number; quality_id: number; slug: string }>(
    `SELECT nliq.item_id, nq.id AS quality_id, nq.slug
     FROM nutrition_library_item_qualities nliq
     JOIN nutritional_qualities nq ON nq.id = nliq.quality_id
     WHERE nliq.item_id IN (${marks})
     ORDER BY nq.id`,
    itemIds,
  );
  const map: Record<number, { id: number; slug: string }[]> = {};
  for (const row of rows) {
    if (!map[row.item_id]) map[row.item_id] = [];
    map[row.item_id].push({ id: row.quality_id, slug: row.slug });
  }
  return map;
}

/** Replace all quality assignments for an item inside a transaction. */
export async function replaceQualities(itemId: number, qualityIds: number[]): Promise<void> {
  await db.transaction(async (conn) => {
    await conn.query('DELETE FROM nutrition_library_item_qualities WHERE item_id = ?', [itemId]);
    for (const qid of qualityIds) {
      await conn.query(
        'INSERT INTO nutrition_library_item_qualities (item_id, quality_id) VALUES (?, ?)',
        [itemId, qid],
      );
    }
  });
}

/** Validate that all given quality IDs exist. Returns 400 error message or null. */
export async function validateQualityIds(ids: unknown): Promise<{ error: string } | null> {
  if (!Array.isArray(ids)) return { error: 'quality_ids must be an array' };
  if (ids.some((id) => typeof id !== 'number' || !Number.isInteger(id) || id <= 0)) {
    return { error: 'quality_ids must be positive integers' };
  }
  if (ids.length === 0) return null;
  const marks = ids.map(() => '?').join(',');
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM nutritional_qualities WHERE id IN (${marks})`,
    ids,
  );
  if (rows.length !== ids.length) return { error: 'One or more quality_ids are invalid' };
  return null;
}

/** Normalize a repeatable query param (?x=a&x=b or ?x=a) into a string array. */
export function toQueryArray(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v));
}

export function clampLimit(value: unknown): number {
  const n = parseInt(String(value ?? '50'), 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 200);
}

export function clampOffset(value: unknown): number {
  const n = parseInt(String(value ?? '0'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Build the WHERE clause + params shared by the platform and gym-facing list
 * endpoints: name search, category filter (OR — item must have at least one
 * of the selected categories), quality filter (AND — item must have every
 * selected quality), plus a caller-supplied base predicate (e.g. `gym_id IS NULL`).
 *
 * Search matches the base name *or* the name shown in `locale` (#643), so
 * searching for what is on screen finds it. Untranslated locales match on the
 * base name alone, which is also what they render.
 */
export function buildListWhere(
  req: { query: Record<string, unknown> },
  base: string[],
  baseParams: any[] = [],
  locale: SupportedLocale = BASE_LOCALE,
): { where: string; params: any[] } | { error: string } {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const categoryIds = toQueryArray(req.query.category_id).map((v) => parseInt(v, 10));
  const qualityIds = toQueryArray(req.query.quality_id).map((v) => parseInt(v, 10));

  if (categoryIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    return { error: 'category_id must be a positive integer' };
  }
  if (qualityIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    return { error: 'quality_id must be a positive integer' };
  }

  const where = [...base];
  const params: any[] = [...baseParams];

  if (search) {
    if (locale === BASE_LOCALE) {
      where.push('name LIKE ?');
      params.push(`%${search}%`);
    } else {
      where.push(`(name LIKE ? OR id IN (
        SELECT nlit.item_id FROM ${TRANSLATIONS_TABLE} nlit
        WHERE nlit.locale = '${locale}' AND nlit.name LIKE ?
      ))`);
      params.push(`%${search}%`, `%${search}%`);
    }
  }
  if (categoryIds.length) {
    where.push(`id IN (
      SELECT nlic.item_id FROM nutrition_library_item_categories nlic
      WHERE nlic.category_id IN (${categoryIds.map(() => '?').join(',')})
    )`);
    params.push(...categoryIds);
  }
  if (qualityIds.length) {
    where.push(`id IN (
      SELECT nliq.item_id FROM nutrition_library_item_qualities nliq
      WHERE nliq.quality_id IN (${qualityIds.map(() => '?').join(',')})
      GROUP BY nliq.item_id
      HAVING COUNT(DISTINCT nliq.quality_id) = ?
    )`);
    params.push(...qualityIds, qualityIds.length);
  }

  return { where: where.join(' AND '), params };
}
