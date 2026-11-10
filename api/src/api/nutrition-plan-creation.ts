import { Tx } from '../infra/db';
import { DateTime } from 'luxon';

/**
 * #443: the create-personalized-nutrition-plan transaction, extracted from
 * nutrition-plan-templates.ts's /:id/assign so it can be shared with the new
 * gym-level /member-nutrition-plans creation endpoint (mirrors #67's
 * training-plan-creation.ts split). Clones the full template hierarchy
 * (templateId given) or creates an empty plan (templateId null). Runs inside
 * the caller's transaction so callers can compose it.
 */

export type CreateNutritionPlanArgs = {
  gymId: string;
  memberId: number;
  /** #1182: the plain-text actor snapshot (resolveRequestActor), written to created_by. */
  actor: string | null;
  templateId: number | null;
  name: string | null; // required by callers when templateId is null
  description?: string | null; // undefined -> inherit template's when cloning
  startDate: string | null;
  /** #2572: the caller confirmed superseding the member's current active plan. */
  confirmReplace?: boolean;
  /** IANA zone used when startDate is null (the new plan starts today). */
  timeZone?: string;
};

export type CreateNutritionPlanResult = { planId: number; planName: string };

const dateOnly = (v: any): string => (typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10));

/**
 * #2572: a member holds one active assigned Nutrition Plan. Locks the member, and when an
 * active plan exists either refuses with 409 `active_plan_exists` (no confirmation) or completes
 * it, ending it the day before the new plan starts so the periods do not overlap. The one place
 * both Assign and New Nutrition Plan go through.
 */
export async function supersedeActiveNutritionPlans(
  tx: Tx, args: { gymId: string; memberId: number; actor: string | null; startDate: string | null; confirmReplace?: boolean; timeZone?: string },
): Promise<number[]> {
  const { gymId, memberId, actor, startDate, confirmReplace, timeZone } = args;
  await tx.query('SELECT id FROM members WHERE id = ? AND gym_id = ? FOR UPDATE', [memberId, gymId]);
  const { rows: active } = await tx.query(
    "SELECT id, name, start_date FROM member_nutrition_plans WHERE gym_id = ? AND member_id = ? AND status = 'active' FOR UPDATE",
    [gymId, memberId],
  );
  if (active.length === 0) return [];
  if (!confirmReplace) {
    throw Object.assign(new Error('The member already has an active nutrition plan; it will be superseded.'), {
      status: 409,
      body: {
        error: 'The member already has an active nutrition plan; it will be superseded.',
        code: 'active_plan_exists',
        current_plan: { id: active[0].id, name: active[0].name, start_date: active[0].start_date ? dateOnly(active[0].start_date) : null },
      },
    });
  }
  let zone = timeZone;
  if (!startDate && !zone) {
    const { rows: g } = await tx.query('SELECT time_zone FROM gyms WHERE id = ?', [gymId]);
    zone = g[0]?.time_zone ?? 'UTC';
  }
  const newStart = startDate ?? (DateTime.now().setZone(zone ?? 'UTC').toISODate() as string);
  const dayBefore = DateTime.fromISO(newStart, { zone: 'UTC' }).minus({ days: 1 }).toISODate() as string;
  for (const plan of active) {
    const prevStart = plan.start_date ? dateOnly(plan.start_date) : null;
    const end = prevStart && prevStart > dayBefore ? prevStart : dayBefore;
    await tx.query(
      "UPDATE member_nutrition_plans SET status = 'completed', end_date = ?, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ?",
      [end, actor, plan.id, gymId],
    );
  }
  return active.map((p: any) => p.id as number);
}

export async function createNutritionPlanTx(tx: Tx, args: CreateNutritionPlanArgs): Promise<CreateNutritionPlanResult> {
  const { gymId, memberId, actor, templateId, name, description, startDate } = args;
  await supersedeActiveNutritionPlans(tx, { gymId, memberId, actor, startDate, confirmReplace: args.confirmReplace, timeZone: args.timeZone });
  let planId: number;
  let planName: string;
  let planDescription: string | null;

  if (templateId) {
    const { rows: tplRows } = await tx.query(
      "SELECT * FROM nutrition_plan_templates WHERE id = ? AND (gym_id = ? OR gym_id IS NULL) AND status != 'deleted'",
      [templateId, gymId],
    );
    if (tplRows.length === 0) {
      throw Object.assign(new Error('Nutrition plan template not found'), { status: 404 });
    }
    const template = tplRows[0];
    planName = name?.trim() || template.name;
    planDescription = description !== undefined ? description : (template.description ?? null);

    const { insertId: newPlanId } = await tx.query(
      `INSERT INTO member_nutrition_plans
        (gym_id, member_id, template_id, name, description, start_date, status, created_by, modified_at, modified_by)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, UTC_TIMESTAMP(), ?)`,
      [gymId, memberId, templateId, planName, planDescription, startDate, actor, actor],
    );
    planId = newPlanId;

    const { rows: days } = await tx.query(
      'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
      [templateId],
    );
    for (const day of days) {
      const { insertId: newDayId } = await tx.query(
        'INSERT INTO member_nutrition_plan_days (gym_id, member_nutrition_plan_id, weekday, position) VALUES (?, ?, ?, ?)',
        [gymId, planId, day.weekday, day.position],
      );
      const { rows: meals } = await tx.query(
        'SELECT * FROM nutrition_plan_template_meals WHERE nutrition_plan_template_day_id = ? ORDER BY position ASC',
        [day.id],
      );
      for (const meal of meals) {
        const { insertId: newMealId } = await tx.query(
          'INSERT INTO member_nutrition_plan_meals (gym_id, member_nutrition_plan_day_id, meal_type, display_name, notes, position) VALUES (?, ?, ?, ?, ?, ?)',
          [gymId, newDayId, meal.meal_type ?? null, meal.display_name, meal.notes ?? null, meal.position],
        );
        const { rows: items } = await tx.query(
          'SELECT * FROM nutrition_plan_template_meal_items WHERE meal_id = ? ORDER BY position ASC',
          [meal.id],
        );
        for (const item of items) {
          await tx.query(
            'INSERT INTO member_nutrition_plan_meal_items (gym_id, meal_id, nutrition_library_item_id, base_nutrition_library_item_id, component_type, quantity, unit, position) VALUES (?, ?, (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL), (SELECT id FROM base_nutrition_library_items WHERE id = ?), ?, ?, ?, ?)',
            [gymId, newMealId, (item.base_nutrition_library_item_id ?? item.nutrition_library_item_id), (item.base_nutrition_library_item_id ?? item.nutrition_library_item_id), item.component_type, item.quantity ?? null, item.unit ?? null, item.position],
          );
        }
      }
    }

    const { rows: restrictions } = await tx.query(
      'SELECT * FROM nutrition_plan_template_restrictions WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
      [templateId],
    );
    for (const r of restrictions) {
      await tx.query(
        'INSERT INTO member_nutrition_plan_restrictions (gym_id, member_nutrition_plan_id, nutrition_library_item_id, base_nutrition_library_item_id, applies_all_days, position) VALUES (?, ?, (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL), (SELECT id FROM base_nutrition_library_items WHERE id = ?), ?, ?)',
        [gymId, planId, (r.base_nutrition_library_item_id ?? r.nutrition_library_item_id), (r.base_nutrition_library_item_id ?? r.nutrition_library_item_id), r.applies_all_days, r.position],
      );
    }

    const { rows: goals } = await tx.query(
      'SELECT * FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
      [templateId],
    );
    for (const g of goals) {
      await tx.query(
        'INSERT INTO member_nutrition_plan_goals (gym_id, member_nutrition_plan_id, item_name, quantity, unit, frequency, applies_all_days, position, nutrition_library_item_id, base_nutrition_library_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL), (SELECT id FROM base_nutrition_library_items WHERE id = ?))',
        [gymId, planId, g.item_name, g.quantity, g.unit, g.frequency, g.applies_all_days, g.position, (g.base_nutrition_library_item_id ?? g.nutrition_library_item_id ?? null), (g.base_nutrition_library_item_id ?? g.nutrition_library_item_id ?? null)],
      );
    }
  } else {
    planName = (name ?? '').trim();
    planDescription = description ?? null;
    const { insertId: newPlanId } = await tx.query(
      `INSERT INTO member_nutrition_plans
        (gym_id, member_id, template_id, name, description, start_date, status, created_by, modified_at, modified_by)
       VALUES (?, ?, NULL, ?, ?, ?, 'active', ?, UTC_TIMESTAMP(), ?)`,
      [gymId, memberId, planName, planDescription, startDate, actor, actor],
    );
    planId = newPlanId;
  }

  return { planId, planName };
}
