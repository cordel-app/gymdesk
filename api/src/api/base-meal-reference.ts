import { RequestHandler } from 'express';
import { db, Tx } from '../infra/db';
import { getRequestLocale, SupportedLocale } from '../infra/locale';
import { localizedGoalColumn } from '../domain/nutritionGoalTranslations';

/**
 * #3328 stage 2 — the one place a nutrition plan's meal is tied to its Base Meal.
 *
 * `nutrition_plan_template_meals.base_meal_id` and
 * `member_nutrition_plan_meals.base_meal_id` (migration 479, FK `ON DELETE
 * RESTRICT`) reference `base_meals`, the platform catalogue Cordel administers.
 * The three nutrition-plan routers (gym templates, Base templates, assigned plans)
 * judge a request's meal with {@link resolveBaseMealInput}, read it back with
 * {@link baseMealColumnsSql} + {@link BASE_MEAL_JOIN_SQL}, and serve the picker
 * with {@link listBaseMealsHandler}. `meal_type` stays as a copy of the meal's
 * slug so a reader written before this stage keeps working; the reference is the
 * source of truth.
 */

export type BaseMealInput =
  | { kind: 'absent' }
  | { kind: 'ok'; id: number; slug: string; name: string }
  | { kind: 'error'; message: string };

type Exec = Pick<Tx, 'query'> | typeof db;

/** The plan meal being edited: its stored Base Meal may be resent even once that meal is inactive. */
export interface CurrentMealRef {
  table: 'nutrition_plan_template_meals' | 'member_nutrition_plan_meals';
  mealId: string | number;
}

/**
 * Judges a request body's meal: `base_meal_id` (preferred) or the legacy
 * `meal_type` slug. Only a live (not soft-deleted) Base Meal may be chosen, and
 * since #3328 stage 3 only an `active` one — except the meal an edited row
 * already references (`current`), so an unrelated save of a meal whose Base
 * Meal was deactivated is not refused. An unknown or unavailable id or slug is
 * a 400, never a coercion. Neither field present is `absent`, which a create
 * refuses and an update reads as "keep".
 */
export async function resolveBaseMealInput(
  body: any,
  exec: Exec = db,
  current?: CurrentMealRef,
): Promise<BaseMealInput> {
  const hasId = body && body.base_meal_id !== undefined && body.base_meal_id !== null && body.base_meal_id !== '';
  const hasType = body && body.meal_type !== undefined && body.meal_type !== null && body.meal_type !== '';
  if (!hasId && !hasType) return { kind: 'absent' };
  let currentId: number | null = null;
  if (current) {
    const { rows } = await exec.query<any>(`SELECT base_meal_id FROM ${current.table} WHERE id = ?`, [current.mealId]);
    currentId = rows[0]?.base_meal_id != null ? Number(rows[0].base_meal_id) : null;
  }
  const available = (row: any) => row && (row.status === 'active' || Number(row.id) === currentId);
  if (hasId) {
    const id = Number(body.base_meal_id);
    if (!Number.isInteger(id) || id <= 0) return { kind: 'error', message: 'base_meal_id must be a positive integer' };
    const { rows } = await exec.query<any>(
      'SELECT id, slug, name, status FROM base_meals WHERE id = ? AND deleted_at IS NULL', [id],
    );
    if (!available(rows[0])) return { kind: 'error', message: 'base_meal_id does not name an available meal' };
    return { kind: 'ok', id: Number(rows[0].id), slug: rows[0].slug, name: rows[0].name };
  }
  if (typeof body.meal_type !== 'string') return { kind: 'error', message: 'meal_type must be a meal slug' };
  const { rows } = await exec.query<any>(
    'SELECT id, slug, name, status FROM base_meals WHERE slug = ? AND deleted_at IS NULL', [body.meal_type],
  );
  if (!available(rows[0])) return { kind: 'error', message: 'meal_type does not name an available meal' };
  return { kind: 'ok', id: Number(rows[0].id), slug: rows[0].slug, name: rows[0].name };
}

/** The join a meal read adds after `FROM <meals table> m`. LEFT, so a legacy meal with no reference still reads. */
export const BASE_MEAL_JOIN_SQL = 'LEFT JOIN base_meals bm ON bm.id = m.base_meal_id';

/**
 * The Base Meal fields a meal row reports, resolved for the request locale: the
 * name and description fall back to the base (English) value. A deleted meal a
 * plan still references keeps reading, since the reference is what was agreed.
 */
export function baseMealColumnsSql(locale: SupportedLocale): string {
  return `m.base_meal_id,
         ${localizedGoalColumn('name', 'bm', locale, 'base_meal')} AS meal_name,
         ${localizedGoalColumn('description', 'bm', locale, 'base_meal')} AS meal_description,
         bm.image_url AS meal_image_url,
         bm.image_thumbnail_url AS meal_image_thumbnail_url,
         bm.modified_at AS meal_modified_at`;
}

/** The meals a picker may offer: every live, active Base Meal, in Cordel's order, localized (#3328 stage 3). */
export async function listSelectableBaseMeals(locale: SupportedLocale) {
  const { rows } = await db.query(
    `SELECT bm.id, bm.slug,
            ${localizedGoalColumn('name', 'bm', locale, 'base_meal')} AS display_name,
            ${localizedGoalColumn('description', 'bm', locale, 'base_meal')} AS display_description,
            bm.image_url, bm.image_thumbnail_url, bm.modified_at
       FROM base_meals bm
      WHERE bm.deleted_at IS NULL AND bm.status = 'active'
      ORDER BY bm.position ASC, bm.name ASC, bm.id ASC`,
  );
  return rows;
}

/** `GET <router>/base-meals` — mounted by each nutrition-plan router before its `/:id`. */
export const listBaseMealsHandler: RequestHandler = async (req, res, next) => {
  try {
    res.json(await listSelectableBaseMeals(getRequestLocale(req)));
  } catch (err) { next(err); }
};

/** How many nutrition-plan meals (templates of any gym, Base templates, assigned plans) reference a Base Meal. */
export async function countBaseMealReferences(baseMealId: number | string, exec: Exec = db): Promise<number> {
  const { rows } = await exec.query<any>(
    `SELECT (SELECT COUNT(*) FROM nutrition_plan_template_meals WHERE base_meal_id = ?)
          + (SELECT COUNT(*) FROM member_nutrition_plan_meals WHERE base_meal_id = ?) AS n`,
    [baseMealId, baseMealId],
  );
  return Number(rows[0]?.n ?? 0);
}
