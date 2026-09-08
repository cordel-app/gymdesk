import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { createNutritionPlanTx } from './nutrition-plan-creation';

export const memberNutritionPlansRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ── Create (from scratch or from a template) ────────────────────────────────
 * #443: the "+ New Nutrition Plan" flow's backend — mirrors gym-training-plans.ts's
 * POST /training-plans. Plain creation is used for the "from scratch" choice;
 * template_id set clones the template hierarchy via createNutritionPlanTx,
 * the same helper /nutrition-plan-templates/:id/assign now shares. */

memberNutritionPlansRouter.post('/', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { member_id, template_id, name, description, start_date } = req.body;

  const memberId = Number(member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: 'member_id is required' });
  const templateId = template_id == null || template_id === '' ? null : Number(template_id);
  if (templateId !== null && (!Number.isInteger(templateId) || templateId <= 0)) {
    return res.status(400).json({ error: 'template_id must be a template id' });
  }
  if (!templateId && !name?.trim()) {
    return res.status(400).json({ error: 'name is required when creating a plan from scratch (no template_id)' });
  }
  if (!start_date || typeof start_date !== 'string' || !DATE_RE.test(start_date)) {
    return res.status(400).json({ error: 'start_date is required (YYYY-MM-DD)' });
  }

  try {
    const { rows: memberRows } = await db.query(
      'SELECT 1 FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [memberId, gymId],
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

    const created = await db.transaction((tx) => createNutritionPlanTx(tx, {
      gymId, memberId, gymMembershipId,
      templateId,
      name: name?.trim() || null,
      description,
      startDate: start_date,
    }));

    const { rows } = await db.query(
      `SELECT mnp.*, m.name AS member_name
       FROM member_nutrition_plans mnp
       JOIN members m ON m.id = mnp.member_id
       WHERE mnp.id = ?`,
      [created.planId],
    );
    recordAudit(req, {
      action: 'create', entityType: 'member_nutrition_plan', entityId: created.planId,
      next: { member_id: memberId, template_id: templateId, name: created.planName, start_date },
    });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/* ── List ─────────────────────────────────────────────────────────────────── */

memberNutritionPlansRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = req.query.member_id ? Number(req.query.member_id) : null;
  if (memberId !== null && !Number.isInteger(memberId)) {
    return res.status(400).json({ error: 'member_id must be an integer' });
  }
  try {
    const where: string[] = ["mnp.gym_id = ?", "mnp.status != 'deleted'"];
    const params: any[] = [gymId];
    if (memberId !== null) { where.push('mnp.member_id = ?'); params.push(memberId); }

    const { rows } = await db.query(
      `SELECT mnp.*, m.name AS member_name,
              (SELECT COUNT(*) FROM member_nutrition_plan_days WHERE member_nutrition_plan_id = mnp.id) AS day_count
       FROM member_nutrition_plans mnp
       JOIN members m ON m.id = mnp.member_id
       WHERE ${where.join(' AND ')}
       ORDER BY mnp.created_at DESC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/* ── Get single ───────────────────────────────────────────────────────────── */

memberNutritionPlansRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT mnp.*, m.name AS member_name
       FROM member_nutrition_plans mnp
       JOIN members m ON m.id = mnp.member_id
       WHERE mnp.id = ? AND mnp.gym_id = ? AND mnp.status != 'deleted'`,
      [req.params.id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Member nutrition plan not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ── Full hierarchy ───────────────────────────────────────────────────────── */

memberNutritionPlansRouter.get('/:id/hierarchy', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params;
  try {
    const { rows: planRows } = await db.query(
      "SELECT id, name, status FROM member_nutrition_plans WHERE id = ? AND gym_id = ? AND status != 'deleted'",
      [id, gymId],
    );
    if (planRows.length === 0) return res.status(404).json({ error: 'Member nutrition plan not found' });

    const { rows: dayRows } = await db.query(
      'SELECT * FROM member_nutrition_plan_days WHERE member_nutrition_plan_id = ? AND gym_id = ? ORDER BY position ASC',
      [id, gymId],
    );
    const days = await Promise.all(dayRows.map(async (day: any) => {
      const { rows: mealRows } = await db.query(
        'SELECT id, meal_type, display_name, notes, position FROM member_nutrition_plan_meals WHERE member_nutrition_plan_day_id = ? AND gym_id = ? ORDER BY position ASC',
        [day.id, gymId],
      );
      const meals = await Promise.all(mealRows.map(async (meal: any) => {
        const { rows: items } = await db.query(
          `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
                  i.component_type, i.quantity, i.unit, i.position
           FROM member_nutrition_plan_meal_items i
           JOIN nutrition_library_items nli ON nli.id = i.nutrition_library_item_id
           WHERE i.meal_id = ?
           ORDER BY i.position ASC`,
          [meal.id],
        );
        return { ...meal, items };
      }));
      return { ...day, meals };
    }));

    const { rows: restrictionRows } = await db.query(
      `SELECT r.*, nli.name AS item_name, nli.category AS item_category
       FROM member_nutrition_plan_restrictions r
       JOIN nutrition_library_items nli ON nli.id = r.nutrition_library_item_id
       WHERE r.member_nutrition_plan_id = ? AND r.gym_id = ?
       ORDER BY r.position ASC`,
      [id, gymId],
    );
    const { rows: goalRows } = await db.query(
      'SELECT * FROM member_nutrition_plan_goals WHERE member_nutrition_plan_id = ? AND gym_id = ? ORDER BY position ASC',
      [id, gymId],
    );

    res.json({ ...planRows[0], days, restrictions: restrictionRows, goals: goalRows });
  } catch (err) { next(err); }
});

/* ── Soft delete ──────────────────────────────────────────────────────────── */

memberNutritionPlansRouter.delete('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId, gymMembershipId, actorName } = getTenantContext(req);
  try {
    const { rowCount } = await db.query(
      "UPDATE member_nutrition_plans SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ? WHERE id = ? AND gym_id = ? AND status != 'deleted'",
      [gymMembershipId, req.params.id, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Member nutrition plan not found' });
    recordAudit(req, { action: 'delete', entityType: 'member_nutrition_plan', entityId: req.params.id });
    res.status(204).send();
  } catch (err) { next(err); }
});
