import { db } from '../infra/db';
import { BASE_LOCALE, SupportedLocale } from '../infra/locale';
import {
  TranslatedNameConfig,
  loadTranslationsMapFor,
  replaceTranslationsFor,
  translatedNameExpr,
  translatedNameSql,
  validateTranslationsPayload,
} from './nameTranslations';

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

/* ── Translated names (#643, shared since #967) ───────────────────────────── */

/**
 * The item-name junction `nutrition_library_item_translations` (migration 166),
 * as `domain/nameTranslations.ts` configures it. #967 needed the same mechanism
 * for exercises, so the rules moved into that module and this is the Nutrition
 * Library's configuration of them — the exported helpers below keep their names
 * and behaviour, which is what keeps the ~30 call sites untouched.
 */
const ITEM_TRANSLATIONS: TranslatedNameConfig = {
  table: 'nutrition_library_item_translations',
  entityColumn: 'item_id',
  subqueryAlias: 'nlit',
  maxNameLength: 255,
};

/**
 * The tables one Foods catalogue is made of (#1849 stage F2): the legacy
 * `nutrition_library_items` family, and the `base_nutrition_library_items` family
 * the platform's System foods are being moved to. Every helper below takes the set
 * as a trailing argument that **defaults to the legacy one**, so the gym-facing
 * callers are untouched; Cordel's router passes `BASE_FOOD_TABLES`.
 */
export interface FoodTables {
  items: string;
  categories: string;
  qualities: string;
  translations: string;
  descriptions: string;
}

export const LEGACY_FOOD_TABLES: FoodTables = {
  items: 'nutrition_library_items',
  categories: 'nutrition_library_item_categories',
  qualities: 'nutrition_library_item_qualities',
  translations: 'nutrition_library_item_translations',
  descriptions: 'nutrition_library_item_description_translations',
};

export const BASE_FOOD_TABLES: FoodTables = {
  items: 'base_nutrition_library_items',
  categories: 'base_nutrition_library_item_categories',
  qualities: 'base_nutrition_library_item_qualities',
  translations: 'base_nutrition_library_item_translations',
  descriptions: 'base_nutrition_library_item_description_translations',
};

function nameConfig(tables: FoodTables): TranslatedNameConfig {
  return tables === LEGACY_FOOD_TABLES ? ITEM_TRANSLATIONS : { ...ITEM_TRANSLATIONS, table: tables.translations };
}

/**
 * SQL expression resolving an item's name in `locale`, falling back to the base
 * `name` column when that locale has no row.
 *
 * @param alias table alias of `nutrition_library_items` in the enclosing query
 */
export function localizedNameSql(alias: string, locale: SupportedLocale, tables: FoodTables = LEGACY_FOOD_TABLES): string {
  return translatedNameSql(nameConfig(tables), alias, locale);
}

/** {@link localizedNameSql} with an output alias, for SELECT lists. */
export function localizedNameExpr(alias: string, locale: SupportedLocale, as = 'item_name'): string {
  return translatedNameExpr(ITEM_TRANSLATIONS, alias, locale, as);
}

/** Return translations for a set of item IDs as a map: item_id → { locale: name } */
export function loadTranslationsMap(itemIds: number[], tables: FoodTables = LEGACY_FOOD_TABLES): Promise<Record<number, Record<string, string>>> {
  return loadTranslationsMapFor(nameConfig(tables), db, itemIds);
}

/**
 * Replace all translations for an item, mirroring
 * `replaceCategories`/`replaceQualities`: the payload is the complete set, so a
 * locale the caller omits (or sends blank) loses its row and falls back to the
 * base name. Opens its own transaction, as its callers expect.
 */
export async function replaceTranslations(
  itemId: number,
  translations: Record<string, string>,
  tables: FoodTables = LEGACY_FOOD_TABLES,
): Promise<void> {
  await db.transaction(async (conn) => {
    await replaceTranslationsFor(nameConfig(tables), conn, itemId, translations);
  });
}

/**
 * Validate a `translations` payload: an object keyed by supported locale, with
 * string values. The base locale is rejected — it is the item's own `name`
 * column, not a translation — and unknown locales are rejected rather than
 * silently dropped, so a typo'd key doesn't look like it saved.
 */
export function validateTranslations(value: unknown): { error: string } | null {
  return validateTranslationsPayload(value, ITEM_TRANSLATIONS.maxNameLength);
}

/** Return categories assigned to a set of item IDs as a map: item_id → [{id, slug}] */
export async function loadCategoriesMap(itemIds: number[], tables: FoodTables = LEGACY_FOOD_TABLES): Promise<Record<number, { id: number; slug: string }[]>> {
  if (itemIds.length === 0) return {};
  const marks = itemIds.map(() => '?').join(',');
  const { rows } = await db.query<{ item_id: number; category_id: number; slug: string }>(
    `SELECT nlic.item_id, nlc.id AS category_id, nlc.slug
     FROM ${tables.categories} nlic
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
export async function replaceCategories(itemId: number, categoryIds: number[], tables: FoodTables = LEGACY_FOOD_TABLES): Promise<void> {
  await db.transaction(async (conn) => {
    await conn.query(`DELETE FROM ${tables.categories} WHERE item_id = ?`, [itemId]);
    for (const cid of categoryIds) {
      await conn.query(
        `INSERT INTO ${tables.categories} (item_id, category_id) VALUES (?, ?)`,
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
export async function loadQualitiesMap(itemIds: number[], tables: FoodTables = LEGACY_FOOD_TABLES): Promise<Record<number, { id: number; slug: string }[]>> {
  if (itemIds.length === 0) return {};
  const marks = itemIds.map(() => '?').join(',');
  const { rows } = await db.query<{ item_id: number; quality_id: number; slug: string }>(
    `SELECT nliq.item_id, nq.id AS quality_id, nq.slug
     FROM ${tables.qualities} nliq
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
export async function replaceQualities(itemId: number, qualityIds: number[], tables: FoodTables = LEGACY_FOOD_TABLES): Promise<void> {
  await db.transaction(async (conn) => {
    await conn.query(`DELETE FROM ${tables.qualities} WHERE item_id = ?`, [itemId]);
    for (const qid of qualityIds) {
      await conn.query(
        `INSERT INTO ${tables.qualities} (item_id, quality_id) VALUES (?, ?)`,
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

/**
 * `?limit=all` asks a food list for its complete applicable dataset (#1302).
 * Returns the SQL paging clause — empty for `all`, otherwise the validated
 * literal `LIMIT n OFFSET m` (never a bound parameter).
 */
export function pagingClause(limitParam: unknown, offsetParam: unknown): { clause: string; limit: number | null; offset: number } {
  const offset = clampOffset(offsetParam);
  if (String(limitParam ?? '').toLowerCase() === 'all') return { clause: '', limit: null, offset: 0 };
  const limit = clampLimit(limitParam);
  return { clause: `LIMIT ${limit} OFFSET ${offset}`, limit, offset };
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
 * Search matches the base name *or* a translation in any locale (#1674); `locale`
 * only affects the displayed name, never what a search finds.
 */
export function buildListWhere(
  req: { query: Record<string, unknown> },
  base: string[],
  baseParams: any[] = [],
  locale: SupportedLocale = BASE_LOCALE,
  tables: FoodTables = LEGACY_FOOD_TABLES,
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
    where.push(`(name LIKE ? OR id IN (
      SELECT nlit.item_id FROM ${nameConfig(tables).table} nlit
      WHERE nlit.name LIKE ?
    ))`);
    params.push(`%${search}%`, `%${search}%`);
  }
  if (categoryIds.length) {
    where.push(`id IN (
      SELECT nlic.item_id FROM ${tables.categories} nlic
      WHERE nlic.category_id IN (${categoryIds.map(() => '?').join(',')})
    )`);
    params.push(...categoryIds);
  }
  if (qualityIds.length) {
    where.push(`id IN (
      SELECT nliq.item_id FROM ${tables.qualities} nliq
      WHERE nliq.quality_id IN (${qualityIds.map(() => '?').join(',')})
      GROUP BY nliq.item_id
      HAVING COUNT(DISTINCT nliq.quality_id) = ?
    )`);
    params.push(...qualityIds, qualityIds.length);
  }

  return { where: where.join(' AND '), params };
}

/* ── Description + actor snapshot (#799) ─────────────────────────────────── */

/** The plain-text actor columns (#1182), in the order responses carry them. */
const ACTOR_COLUMNS = ['created_by', 'modified_by', 'deleted_by'];

/**
 * The columns every item-shaped response carries beyond `id/name/status/
 * image_url/created_at/modified_at`, declared once so the gym and platform
 * routers cannot answer with different shapes (#799 §26). `description`,
 * `deleted_at` and the three actor pairs come from migration 196.
 *
 * `maskPlatformActors` nulls the actor names on the **system** rows
 * (`gym_id IS NULL`) the gym-facing list returns alongside a gym's own. Those
 * rows are administered from Cordel, so their actor is a Cordel employee: the
 * catalogue is deliberately shared, their name is not. The column is still
 * present and still keyed the same way, so the Details modal renders its em dash
 * and needs no rule of its own (`created_at` is not masked — a date names nobody).
 *
 * @param alias table alias of `nutrition_library_items` in the enclosing query
 */
export function itemDetailColumnsSql(
  alias: string,
  { maskPlatformActors = false }: { maskPlatformActors?: boolean } = {},
): string {
  const actors = ACTOR_COLUMNS.map((column) => (
    maskPlatformActors
      ? `CASE WHEN ${alias}.gym_id IS NULL THEN NULL ELSE ${alias}.${column} END AS ${column}`
      : `${alias}.${column}`
  ));
  return [`${alias}.description`, actors[0], actors[1], `${alias}.deleted_at`, actors[2]].join(', ');
}

/** `nutrition_library_items.description` is VARCHAR(1000) (migration 196). */
export const DESCRIPTION_MAX_LENGTH = 1000;

/**
 * The value to store for a submitted `description`, or an error.
 *
 * `undefined` means the request did not mention the field, so the column is left
 * alone — that is what lets `PUT` stay a partial update. An empty or
 * whitespace-only string means "no description" and is stored as NULL rather
 * than `''`, so a read never has to distinguish the two.
 */
export function normalizeDescription(
  input: unknown,
): { value: string | null | undefined } | { error: string } {
  if (input === undefined) return { value: undefined };
  if (input === null) return { value: null };
  if (typeof input !== 'string') return { error: 'description must be a string' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { value: null };
  if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
    return { error: `description must be at most ${DESCRIPTION_MAX_LENGTH} characters` };
  }
  return { value: trimmed };
}

/**
 * @deprecated #1182 stage 2 — the `{name, type}` pair is gone from the stage-2
 * tables; use `resolveRequestActor()` / `resolvePlatformActor()`
 * (`domain/auditActor.ts`). Kept only until the stage-3 tables that still carry
 * a `*_by_type` column (`membership_plans`/`user_memberships` callers) are
 * converted; delete with the last caller.
 */
export type ActorType = 'staff' | 'superadmin';
export interface ActorSnapshot { name: string | null; type: ActorType }
export function actorSnapshot(actor: { name?: string | null; isSuperadmin: boolean }): ActorSnapshot {
  const name = actor.name?.trim();
  return { name: name ? name : null, type: actor.isSuperadmin ? 'superadmin' : 'staff' };
}
