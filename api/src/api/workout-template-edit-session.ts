import { Router, RequestHandler } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite, requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { reviveCheckpointRow } from '../domain/workoutTemplateCheckpoint';

/**
 * #3485 — a Workout Template's inline edit session, on a gym's own templates
 * and on Cordel's Base Workout Templates alike (#3482's device, one entity over).
 *
 * A template's blocks and their exercises are persisted by their own sub-routes
 * the moment staff change them, so Cancel has to put the content back rather
 * than forget a draft. `POST /:id/edit-session` stores every block and exercise
 * row of the template as it stands (soft-deleted ones included, read by the
 * server from its own rows and never sent by the client, one checkpoint per
 * template, replaced on re-entry); `POST /:id/edit-session/cancel` deletes the
 * template's current rows and writes the checkpoint's back under their own ids,
 * in one transaction, then drops it; `DELETE /:id/edit-session` (Save) drops it.
 * The template's own fields are not part of it: the edit form buffers them and
 * only Save's `PUT /:id` writes them.
 */
export interface WorkoutTemplateContent {
  blocks: Record<string, unknown>[];
  exercises: Record<string, unknown>[];
}

type Scope = 'gym' | 'platform';

/** The template must be live and the scope's own: a gym's for a gym, `gym_id IS NULL` for Cordel. */
function lockTemplateSql(scope: Scope): string {
  return scope === 'gym'
    ? 'SELECT id FROM workout_templates WHERE id = ? AND gym_id = ? AND deleted_at IS NULL FOR UPDATE'
    : 'SELECT id FROM workout_templates WHERE id = ? AND gym_id IS NULL AND deleted_at IS NULL FOR UPDATE';
}

export async function readWorkoutTemplateContentTx(tx: Tx, templateId: number | string): Promise<WorkoutTemplateContent> {
  const { rows: blocks } = await tx.query(
    'SELECT * FROM workout_template_blocks WHERE workout_template_id = ? ORDER BY id',
    [templateId],
  );
  const { rows: exercises } = await tx.query(
    `SELECT wte.* FROM workout_template_exercises wte
       JOIN workout_template_blocks b ON b.id = wte.workout_template_block_id
      WHERE b.workout_template_id = ?
      ORDER BY wte.id`,
    [templateId],
  );
  return { blocks, exercises };
}

/**
 * The columns an INSERT may name: stored ones, never a generated column. MySQL 8
 * reports `DEFAULT_GENERATED` for a column with an expression default
 * (`created_at DEFAULT CURRENT_TIMESTAMP`), which is writable and must be
 * restored as stored, so only VIRTUAL / STORED generated columns are excluded.
 */
async function writableColumns(tx: Tx, table: string): Promise<Set<string>> {
  const { rows } = await tx.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND EXTRA NOT LIKE '%VIRTUAL GENERATED%' AND EXTRA NOT LIKE '%STORED GENERATED%'`,
    [table],
  );
  return new Set(rows.map((r: { name: string }) => r.name));
}

async function insertRows(tx: Tx, table: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const allowed = await writableColumns(tx, table);
  for (const raw of rows) {
    const row = reviveCheckpointRow(raw);
    const cols = Object.keys(row).filter((c) => allowed.has(c));
    // Column names come from the table's own information_schema, never from a request.
    await tx.query(
      `INSERT INTO ${table} (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map((c) => row[c] ?? null),
    );
  }
}

/** Puts a template's blocks and exercises back exactly as the checkpoint holds them. */
export async function restoreWorkoutTemplateContentTx(tx: Tx, templateId: number | string, content: WorkoutTemplateContent) {
  // Exercises cascade from their block.
  await tx.query('DELETE FROM workout_template_blocks WHERE workout_template_id = ?', [templateId]);
  await insertRows(tx, 'workout_template_blocks', content.blocks ?? []);
  await insertRows(tx, 'workout_template_exercises', content.exercises ?? []);
}

export function workoutTemplateEditSessionRouter(scope: Scope): Router {
  const router = Router();
  const guard: RequestHandler = scope === 'gym' ? requireModuleWrite('TRAINING') : requireSuperadmin;
  const gymOf = (req: Parameters<RequestHandler>[0]): string | null =>
    scope === 'gym' ? getTenantContext(req).gymId : null;
  const lockParams = (id: string, gymId: string | null) => (scope === 'gym' ? [id, gymId] : [id]);

  router.post('/:id/edit-session', guard, async (req, res, next) => {
    const { id } = req.params as { id: string };
    const gymId = gymOf(req);
    try {
      const found = await db.transaction(async (tx) => {
        const { rows } = await tx.query(lockTemplateSql(scope), lockParams(id, gymId));
        if (rows.length === 0) return false;
        const content = await readWorkoutTemplateContentTx(tx, id);
        await tx.query(
          `INSERT INTO workout_template_edit_checkpoints (gym_id, workout_template_id, content, created_at)
           VALUES (?, ?, CAST(? AS JSON), UTC_TIMESTAMP())
           ON DUPLICATE KEY UPDATE content = VALUES(content), created_at = UTC_TIMESTAMP()`,
          [gymId, id, JSON.stringify(content)],
        );
        return true;
      });
      if (!found) return res.status(404).json({ error: 'Workout template not found' });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  router.post('/:id/edit-session/cancel', guard, async (req, res, next) => {
    const { id } = req.params as { id: string };
    const gymId = gymOf(req);
    try {
      const outcome = await db.transaction(async (tx) => {
        const { rows } = await tx.query(lockTemplateSql(scope), lockParams(id, gymId));
        if (rows.length === 0) return 'not_found' as const;
        const { rows: cps } = await tx.query(
          'SELECT content FROM workout_template_edit_checkpoints WHERE workout_template_id = ? FOR UPDATE',
          [id],
        );
        if (cps.length === 0) return 'no_session' as const;
        const raw = cps[0].content;
        const content: WorkoutTemplateContent = typeof raw === 'string' ? JSON.parse(raw) : raw;
        await restoreWorkoutTemplateContentTx(tx, id, content);
        await tx.query('DELETE FROM workout_template_edit_checkpoints WHERE workout_template_id = ?', [id]);
        return 'restored' as const;
      });
      if (outcome === 'not_found') return res.status(404).json({ error: 'Workout template not found' });
      if (outcome === 'no_session') return res.status(409).json({ error: 'No edit session to cancel', code: 'no_edit_session' });
      recordAudit(req, { action: 'discard_edits', entityType: 'workout_template', entityId: id });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  router.delete('/:id/edit-session', guard, async (req, res, next) => {
    const { id } = req.params as { id: string };
    const gymId = gymOf(req);
    try {
      const { rows } = await db.query(lockTemplateSql(scope).replace(' FOR UPDATE', ''), lockParams(id, gymId));
      if (rows.length === 0) return res.status(404).json({ error: 'Workout template not found' });
      await db.query('DELETE FROM workout_template_edit_checkpoints WHERE workout_template_id = ?', [id]);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  return router;
}
