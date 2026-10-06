import { db } from '../infra/db';

/**
 * #932 — the food that illustrates a Nutrition Goal.
 *
 * A goal's `item_name` is a slug from the plan routers' closed vocabulary, not
 * a food, so it carries no picture of its own. Staff may pick a Nutrition
 * Library food to illustrate it (`nutrition_library_item_id`, migration 233),
 * and that food's own `image_url` is what the member sees — the one image
 * source My Nutrition already has. This module is the one place a request's
 * value is judged and the one SQL that reads the pair back, shared by the
 * gym's template router, the member-plan router and Cordel's platform router.
 *
 * Three answers, as every nullable FK here has: absent keeps (on an update),
 * `null`/`''` clears, an id must be a food the caller may use — visible to the
 * gym (a System row or its own) and not soft-deleted; a platform template may
 * only name a System food, because its goals are copied into every gym.
 */

export function parseGoalIllustrationInput(value: unknown): { id: number | null } | { error: string } {
  if (value === null || value === undefined || value === '') return { id: null };
  const id = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return { error: 'nutrition_library_item_id must be a positive integer' };
  }
  return { id };
}

/** `null` when the food may illustrate a goal of this scope; the error otherwise. */
export async function validateGoalIllustration(gymId: string | null, id: number | null): Promise<string | null> {
  if (id === null) return null;
  const { rows } = gymId === null
    ? await db.query<{ id: number }>(
      `SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NULL AND status <> 'deleted'`,
      [id],
    )
    : await db.query<{ id: number }>(
      `SELECT id FROM nutrition_library_items
        WHERE id = ? AND (gym_id IS NULL OR gym_id = ?) AND status <> 'deleted'`,
      [id, gymId],
    );
  return rows.length > 0 ? null : 'Nutrition library item not found, or not available to illustrate a goal';
}

/**
 * The goal rows of a template or a member plan with the illustrating food's
 * name and image beside them (`illustration_name`, `illustration_image_url`),
 * both `null` for a goal that names none. `where` is appended after the
 * table alias `g`.
 */
export function goalRowsSql(table: 'nutrition_plan_template_goals' | 'member_nutrition_plan_goals', where: string): string {
  return `SELECT g.*, nli.name AS illustration_name, nli.image_url AS illustration_image_url
          FROM ${table} g
          LEFT JOIN nutrition_library_items nli ON nli.id = g.nutrition_library_item_id
          WHERE ${where}
          ORDER BY g.position ASC`;
}
