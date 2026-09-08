import { Tx } from '../infra/db';

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
  gymMembershipId: number | null;
  templateId: number | null;
  name: string | null; // required by callers when templateId is null
  description?: string | null; // undefined -> inherit template's when cloning
  startDate: string | null;
};

export type CreateNutritionPlanResult = { planId: number; planName: string };

export async function createNutritionPlanTx(tx: Tx, args: CreateNutritionPlanArgs): Promise<CreateNutritionPlanResult> {
  const { gymId, memberId, gymMembershipId, templateId, name, description, startDate } = args;
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
        (gym_id, member_id, template_id, name, description, start_date, status, created_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      [gymId, memberId, templateId, planName, planDescription, startDate, gymMembershipId],
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
            'INSERT INTO member_nutrition_plan_meal_items (gym_id, meal_id, nutrition_library_item_id, component_type, quantity, unit, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [gymId, newMealId, item.nutrition_library_item_id, item.component_type, item.quantity ?? null, item.unit ?? null, item.position],
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
        'INSERT INTO member_nutrition_plan_restrictions (gym_id, member_nutrition_plan_id, nutrition_library_item_id, applies_all_days, position) VALUES (?, ?, ?, ?, ?)',
        [gymId, planId, r.nutrition_library_item_id, r.applies_all_days, r.position],
      );
    }

    const { rows: goals } = await tx.query(
      'SELECT * FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
      [templateId],
    );
    for (const g of goals) {
      await tx.query(
        'INSERT INTO member_nutrition_plan_goals (gym_id, member_nutrition_plan_id, item_name, quantity, unit, frequency, applies_all_days, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [gymId, planId, g.item_name, g.quantity, g.unit, g.frequency, g.applies_all_days, g.position],
      );
    }
  } else {
    planName = (name ?? '').trim();
    planDescription = description ?? null;
    const { insertId: newPlanId } = await tx.query(
      `INSERT INTO member_nutrition_plans
        (gym_id, member_id, template_id, name, description, start_date, status, created_by_membership_id)
       VALUES (?, ?, NULL, ?, ?, ?, 'active', ?)`,
      [gymId, memberId, planName, planDescription, startDate, gymMembershipId],
    );
    planId = newPlanId;
  }

  return { planId, planName };
}
