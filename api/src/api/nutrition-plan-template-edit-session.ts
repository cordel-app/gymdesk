import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  TemplateContent, clearTemplateContentTx, readTemplateContentTx, writeTemplateContentTx,
} from './nutrition-plan-template-copy';

/**
 * #3482 — a Nutrition Plan Template's inline edit session.
 *
 * The content's sub-routes persist each change at once, so Cancel has to put
 * the content back rather than forget a draft. `POST /:id/edit-session` stores
 * the content as it stands (read by the server from its own rows, one checkpoint
 * per template, replaced on re-entry); `POST /:id/edit-session/cancel` rewrites
 * the content from it and drops it; `DELETE /:id/edit-session` (Save) drops it.
 * The template's own fields are not part of it: the edit form buffers them and
 * only Save's `PUT /:id` writes them.
 */
export const nutritionPlanTemplateEditSessionRouter = Router();

const LOCK_TEMPLATE_SQL =
  "SELECT id FROM nutrition_plan_templates WHERE id = ? AND gym_id = ? AND status != 'deleted' FOR UPDATE";

nutritionPlanTemplateEditSessionRouter.post('/:id/edit-session', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const found = await db.transaction(async (tx) => {
      const { rows } = await tx.query(LOCK_TEMPLATE_SQL, [id, ctx.gymId]);
      if (rows.length === 0) return false;
      const content = await readTemplateContentTx(tx, id);
      await tx.query(
        `INSERT INTO nutrition_plan_template_edit_checkpoints (gym_id, nutrition_plan_template_id, content, created_at)
         VALUES (?, ?, CAST(? AS JSON), UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE content = VALUES(content), created_at = UTC_TIMESTAMP()`,
        [ctx.gymId, id, JSON.stringify(content)],
      );
      return true;
    });
    if (!found) return res.status(404).json({ error: 'Nutrition plan template not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

nutritionPlanTemplateEditSessionRouter.post('/:id/edit-session/cancel', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const outcome = await db.transaction(async (tx) => {
      const { rows } = await tx.query(LOCK_TEMPLATE_SQL, [id, ctx.gymId]);
      if (rows.length === 0) return 'not_found' as const;
      const { rows: cps } = await tx.query(
        'SELECT content FROM nutrition_plan_template_edit_checkpoints WHERE nutrition_plan_template_id = ? AND gym_id = ? FOR UPDATE',
        [id, ctx.gymId],
      );
      if (cps.length === 0) return 'no_session' as const;
      const raw = cps[0].content;
      const content: TemplateContent = typeof raw === 'string' ? JSON.parse(raw) : raw;
      await clearTemplateContentTx(tx, id);
      await writeTemplateContentTx(tx, content, id, ctx.gymId);
      await tx.query('DELETE FROM nutrition_plan_template_edit_checkpoints WHERE nutrition_plan_template_id = ? AND gym_id = ?', [id, ctx.gymId]);
      return 'restored' as const;
    });
    if (outcome === 'not_found') return res.status(404).json({ error: 'Nutrition plan template not found' });
    if (outcome === 'no_session') return res.status(409).json({ error: 'No edit session to cancel', code: 'no_edit_session' });
    recordAudit(req, { action: 'discard_edits', entityType: 'nutrition_plan_template', entityId: id });
    res.status(204).end();
  } catch (err) { next(err); }
});

nutritionPlanTemplateEditSessionRouter.delete('/:id/edit-session', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const { rows } = await db.query(
      "SELECT 1 FROM nutrition_plan_templates WHERE id = ? AND gym_id = ? AND status != 'deleted'",
      [id, ctx.gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });
    await db.query(
      'DELETE FROM nutrition_plan_template_edit_checkpoints WHERE nutrition_plan_template_id = ? AND gym_id = ?',
      [id, ctx.gymId],
    );
    res.status(204).end();
  } catch (err) { next(err); }
});
