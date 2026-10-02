import { db } from '../infra/db';
import { BASE_LOCALE, SupportedLocale } from '../infra/locale';
import {
  TranslatedNameConfig,
  loadTranslationsMapFor,
  localeLiteral,
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
 * SQL expression resolving an item's name in `locale`, falling back to the base
 * `name` column when that locale has no row.
 *
 * @param alias table alias of `nutrition_library_items` in the enclosing query
 */
export function localizedNameSql(alias: string, locale: SupportedLocale): string {
  return translatedNameSql(ITEM_TRANSLATIONS, alias, locale);
}

/** {@link localizedNameSql} with an output alias, for SELECT lists. */
export function localizedNameExpr(alias: string, locale: SupportedLocale, as = 'item_name'): string {
  return translatedNameExpr(ITEM_TRANSLATIONS, alias, locale, as);
}

/** Return translations for a set of item IDs as a map: item_id → { locale: name } */
export function loadTranslationsMap(itemIds: number[]): Promise<Record<number, Record<string, string>>> {
  return loadTranslationsMapFor(ITEM_TRANSLATIONS, db, itemIds);
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
): Promise<void> {
  await db.transaction(async (conn) => {
    await replaceTranslationsFor(ITEM_TRANSLATIONS, conn, itemId, translations);
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
    const literal = localeLiteral(locale);
    if (!literal) {
      where.push('name LIKE ?');
      params.push(`%${search}%`);
    } else {
      where.push(`(name LIKE ? OR id IN (
        SELECT nlit.item_id FROM ${ITEM_TRANSLATIONS.table} nlit
        WHERE nlit.locale = ${literal} AND nlit.name LIKE ?
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

/* ── Description + actor snapshot (#799) ─────────────────────────────────── */

/** The actor pairs migration 196 added, in the order responses carry them. */
const ACTOR_COLUMNS = [
  'created_by_name', 'created_by_type',
  'modified_by_name', 'modified_by_type',
  'deleted_by_name', 'deleted_by_type',
];

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
  return [`${alias}.description`, ...actors.slice(0, 4), `${alias}.deleted_at`, ...actors.slice(4)].join(', ');
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

/** What `*_by_type` may hold — the CHECKs migration 196 adds. */
export type ActorType = 'staff' | 'superadmin';

export interface ActorSnapshot {
  name: string | null;
  type: ActorType;
}

/**
 * The actor pair to write on a create / update / delete.
 *
 * The name is snapshotted rather than joined because the actor who administers a
 * base food is a superadmin, who has no `gym_memberships` row to point at — the
 * same reason `tax_rates.created_by_name` (migration 126) exists. An empty name
 * is stored as NULL so a read renders the em dash rather than `''`.
 */
export function actorSnapshot(actor: { name?: string | null; isSuperadmin: boolean }): ActorSnapshot {
  const name = actor.name?.trim();
  return { name: name ? name : null, type: actor.isSuperadmin ? 'superadmin' : 'staff' };
}
