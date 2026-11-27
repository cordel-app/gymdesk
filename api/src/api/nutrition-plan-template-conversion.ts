import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolveRequestActor } from '../domain/auditActor';
import { TemplateContent, clearTemplateContentTx, foodId, writeTemplateContentTx } from './nutrition-plan-template-copy';

/**
 * #3484 — Convert to Template on an Assigned Nutrition Plan.
 *
 * The template editor persists each change of the content through its own
 * sub-routes, so the conversion writes a **working copy**: a gym template marked
 * `conversion_pending_at`, holding the plan's content mapped to the template
 * structure. It is not a created template until Save clears the mark
 * (`POST /nutrition-plan-templates/:id/conversion/complete`); Cancel hard-deletes
 * it (`DELETE /nutrition-plan-templates/:id/conversion`), which only ever
 * touches a row still carrying the mark. The assigned plan is only read: no
 * route here writes a `member_nutrition_plans` row or its content.
 */

/** An assigned plan's content in the template shape (same rows, plan tables). */
export async function readPlanContentAsTemplateTx(tx: Tx, planId: number | string): Promise<TemplateContent> {
  const { rows: days } = await tx.query(
    'SELECT * FROM member_nutrition_plan_days WHERE member_nutrition_plan_id = ? ORDER BY position ASC, id ASC',
    [planId],
  );
  const content: TemplateContent = { days: [], restrictions: [], goals: [] };
  for (const day of days) {
    const { rows: meals } = await tx.query(
      'SELECT * FROM member_nutrition_plan_meals WHERE member_nutrition_plan_day_id = ? ORDER BY position ASC, id ASC',
      [day.id],
    );
    const outMeals: TemplateContent['days'][number]['meals'] = [];
    for (const meal of meals) {
      const { rows: items } = await tx.query(
        'SELECT * FROM member_nutrition_plan_meal_items WHERE meal_id = ? ORDER BY position ASC, id ASC',
        [meal.id],
      );
      outMeals.push({
        meal_type: meal.meal_type ?? null,
        base_meal_id: meal.base_meal_id ?? null,
        display_name: meal.display_name ?? null,
        notes: meal.notes ?? null,
        position: meal.position,
        items: items.map((item: any) => ({
          food_id: foodId(item),
          component_type: item.component_type,
          quantity: item.quantity ?? null,
          unit: item.unit ?? null,
          position: item.position,
        })),
      });
    }
    content.days.push({ weekday: day.weekday, position: day.position, meals: outMeals });
  }
  const { rows: restrictions } = await tx.query(
    'SELECT * FROM member_nutrition_plan_restrictions WHERE member_nutrition_plan_id = ? ORDER BY position ASC, id ASC',
    [planId],
  );
  content.restrictions = restrictions.map((r: any) => ({
    food_id: foodId(r), applies_all_days: r.applies_all_days, position: r.position,
  }));
  const { rows: goals } = await tx.query(
    'SELECT * FROM member_nutrition_plan_goals WHERE member_nutrition_plan_id = ? ORDER BY position ASC, id ASC',
    [planId],
  );
  content.goals = goals.map((g: any) => ({
    item_name: g.item_name,
    quantity: g.quantity ?? null,
    unit: g.unit ?? null,
    frequency: g.frequency ?? null,
    applies_all_days: g.applies_all_days,
    position: g.position,
    food_id: foodId(g),
  }));
  return content;
}

/** The plan's name, or `<name> (Copy)`, `(Copy 2)`… while a live template of the gym holds it. */
async function availableTemplateName(tx: Tx, gymId: string, name: string): Promise<string> {
  const { rows } = await tx.query(
    "SELECT name FROM nutrition_plan_templates WHERE gym_id = ? AND status != 'deleted' AND (name = ? OR name LIKE ?)",
    [gymId, name, `${name} (Copy%`],
  );
  const taken = new Set(rows.map((r: any) => r.name));
  if (!taken.has(name)) return name;
  if (!taken.has(`${name} (Copy)`)) return `${name} (Copy)`;
  for (let n = 2; ; n++) if (!taken.has(`${name} (Copy ${n})`)) return `${name} (Copy ${n})`;
}

/** Mounted on `/member-nutrition-plans`. */
export const memberNutritionPlanConversionRouter = Router();

memberNutritionPlanConversionRouter.post('/:id/convert-to-template', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { id } = req.params as { id: string };
  try {
    const templateId = await db.transaction(async (tx) => {
      // Any status but deleted (#3484 §1); read with a shared lock so the copy is one state of the plan.
      const { rows } = await tx.query(
        "SELECT * FROM member_nutrition_plans WHERE id = ? AND gym_id = ? AND status != 'deleted' FOR SHARE",
        [id, gymId],
      );
      if (rows.length === 0) return null;
      const plan = rows[0];
      const name = await availableTemplateName(tx, gymId, plan.name);
      const content = await readPlanContentAsTemplateTx(tx, id);
      // The days the copy covers (0..7); the "All Days" row (weekday 7) is not a day of its own.
      const numDays = new Set(content.days.map((d) => d.weekday).filter((w) => w >= 0 && w <= 6)).size;
      const { insertId } = await tx.query(
        `INSERT INTO nutrition_plan_templates
           (gym_id, name, description, member_notes, num_days, status, created_by, modified_at, modified_by, conversion_pending_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, UTC_TIMESTAMP(), ?, UTC_TIMESTAMP())`,
        [gymId, name, plan.description ?? null, plan.member_notes ?? null, numDays, actor, actor],
      );
      await writeTemplateContentTx(tx, content, insertId, gymId);
      return insertId as number;
    });
    if (templateId === null) return res.status(404).json({ error: 'Member nutrition plan not found' });
    const { rows } = await db.query('SELECT * FROM nutrition_plan_templates WHERE id = ?', [templateId]);
    recordAudit(req, { action: 'convert_to_template', entityType: 'member_nutrition_plan', entityId: id, next: { nutrition_plan_template_id: templateId } });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

/** Mounted on `/nutrition-plan-templates`. */
export const nutritionPlanTemplateConversionRouter = Router();

const LOCK_PENDING_SQL =
  "SELECT * FROM nutrition_plan_templates WHERE id = ? AND gym_id = ? AND status != 'deleted' FOR UPDATE";

/** Save: the working copy becomes a created template. */
nutritionPlanTemplateConversionRouter.post('/:id/conversion/complete', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { id } = req.params as { id: string };
  try {
    const outcome = await db.transaction(async (tx) => {
      const { rows } = await tx.query(LOCK_PENDING_SQL, [id, gymId]);
      if (rows.length === 0) return 'not_found' as const;
      if (rows[0].conversion_pending_at === null) return 'not_pending' as const;
      await tx.query(
        'UPDATE nutrition_plan_templates SET conversion_pending_at = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ?',
        [actor, id],
      );
      return 'completed' as const;
    });
    if (outcome === 'not_found') return res.status(404).json({ error: 'Nutrition plan template not found' });
    if (outcome === 'not_pending') return res.status(409).json({ error: 'This template is not a pending conversion', code: 'not_a_conversion' });
    const { rows } = await db.query('SELECT * FROM nutrition_plan_templates WHERE id = ?', [id]);
    recordAudit(req, { action: 'create', entityType: 'nutrition_plan_template', entityId: id, next: rows[0] });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/** Cancel: the working copy is hard-deleted, content and edit checkpoint with it. */
nutritionPlanTemplateConversionRouter.delete('/:id/conversion', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const outcome = await db.transaction(async (tx) => {
      const { rows } = await tx.query(LOCK_PENDING_SQL, [id, gymId]);
      if (rows.length === 0) return 'not_found' as const;
      if (rows[0].conversion_pending_at === null) return 'not_pending' as const;
      await clearTemplateContentTx(tx, id);
      await tx.query('DELETE FROM nutrition_plan_templates WHERE id = ? AND gym_id = ?', [id, gymId]);
      return 'deleted' as const;
    });
    if (outcome === 'not_found') return res.status(404).json({ error: 'Nutrition plan template not found' });
    if (outcome === 'not_pending') return res.status(409).json({ error: 'This template is not a pending conversion', code: 'not_a_conversion' });
    res.status(204).end();
  } catch (err) { next(err); }
});
