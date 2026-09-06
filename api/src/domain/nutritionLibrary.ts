import { db } from '../infra/db';

/**
 * Shared helpers for the Nutrition Library, used by both the platform
 * (Cordel admin, system-owned items) and gym-facing routers (#350).
 */

export const CATEGORIES = ['main_dish', 'side', 'sauce', 'drink', 'dessert', 'other'] as const;
export type Category = typeof CATEGORIES[number];

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
 * endpoints: name search, category filter (OR), quality filter (AND —
 * item must have every selected quality), plus a caller-supplied base
 * predicate (e.g. `gym_id IS NULL`).
 */
export function buildListWhere(
  req: { query: Record<string, unknown> },
  base: string[],
  baseParams: any[] = [],
): { where: string; params: any[] } | { error: string } {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const categories = toQueryArray(req.query.category);
  const qualityIds = toQueryArray(req.query.quality_id).map((v) => parseInt(v, 10));

  for (const c of categories) {
    if (!CATEGORIES.includes(c as Category)) {
      return { error: `category must be one of: ${CATEGORIES.join(', ')}` };
    }
  }
  if (qualityIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    return { error: 'quality_id must be a positive integer' };
  }

  const where = [...base];
  const params: any[] = [...baseParams];

  if (search) { where.push('name LIKE ?'); params.push(`%${search}%`); }
  if (categories.length) {
    where.push(`category IN (${categories.map(() => '?').join(',')})`);
    params.push(...categories);
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
