import { Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  GOAL_LIBRARY_AUDIT_ENTITIES,
  GOAL_LIBRARY_TABLES,
  GoalLibraryKind,
  buildGoalListWhere,
  normalizeGoalName,
} from '../domain/goalLibrary';
import {
  actorSnapshot, clampLimit, clampOffset, itemDetailColumnsSql, normalizeDescription,
} from '../domain/nutritionLibrary';

/**
 * #947 — Cordel's view of one goal catalogue: the **System** rows (`gym_id IS
 * NULL`) of `personal_goals` / `nutrition_goals`, which this router is the only
 * writer of. A gym's own goal is never visible or writable here, and the
 * gym-facing router answers 403 for a System one — each side answers for its own
 * rows only, the way the two Exercise routers do (#716/#717).
 *
 * Mounted twice in `app.ts`, at `/platform/personal-goals` and
 * `/platform/nutrition-goals`, both behind `requireSuperadmin`.
 */
export function createPlatformGoalLibraryRouter(kind: GoalLibraryKind): Router {
  const router = Router();
  const table = GOAL_LIBRARY_TABLES[kind];
  const entityType = GOAL_LIBRARY_AUDIT_ENTITIES[kind];

  const COLUMNS = `g.id, g.gym_id, g.slug, g.name, g.status, g.created_at, g.modified_at,
    ${itemDetailColumnsSql('g')}`;

  /**
   * Every write here is a superadmin's, by `requireSuperadmin` — so the actor
   * snapshot's type is fixed and only the name comes from the request (#799 §13).
   */
  function platformActor(req: { superadminName?: string | null }) {
    return actorSnapshot({ name: req.superadminName, isSuperadmin: true });
  }

  async function loadGoal(id: unknown) {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM ${table} g WHERE g.id = ?`, [id]);
    return rows[0];
  }

  /* ── List ───────────────────────────────────────────────────────────────── */

  router.get('/', requireSuperadmin, async (req, res, next) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const { where, params } = buildGoalListWhere(
      req.query.search,
      ['g.gym_id IS NULL', status ? 'g.status = ?' : "g.status != 'deleted'"],
      status ? [status] : [],
    );
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);

    try {
      const { rows: countRows } = await db.query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM ${table} g WHERE ${where}`,
        params,
      );
      // Ordered by the stored `name`, not by what the viewer reads: a seeded
      // System row's label is a locale key the admin resolves, so there is no
      // localized column to sort on (which is what the Foods library's
      // `display_name` is). LIMIT/OFFSET are interpolated because MySQL 8
      // rejects a parameterised LIMIT; both are already validated integers.
      const { rows } = await db.query(
        `SELECT ${COLUMNS} FROM ${table} g WHERE ${where} ORDER BY g.name ASC LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      res.json({ items: rows, total: countRows[0]?.total ?? 0, limit, offset });
    } catch (err) { next(err); }
  });

  /* ── Create ─────────────────────────────────────────────────────────────── */

  router.post('/', requireSuperadmin, async (req, res, next) => {
    const name = normalizeGoalName(req.body?.name, { required: true });
    if ('error' in name) return res.status(400).json({ error: name.error });
    const description = normalizeDescription(req.body?.description);
    if ('error' in description) return res.status(400).json({ error: description.error });

    try {
      const { rows: existing } = await db.query(
        `SELECT id FROM ${table} WHERE gym_id IS NULL AND name = ? AND status != 'deleted'`,
        [name.value],
      );
      if (existing.length > 0) return res.status(409).json({ error: 'A goal with this name already exists' });

      // No `slug`: the slugs are migration 206's seeded handles for the locale
      // keys the admin resolves, and a System goal added later carries the single
      // name entered here (shown in every locale), exactly as a gym's own does.
      // Inventing a slug for it would promise a translation key nothing holds.
      const actor = platformActor(req);
      const { insertId } = await db.query(
        `INSERT INTO ${table} (gym_id, name, description, status, created_by_name, created_by_type)
         VALUES (NULL, ?, ?, 'active', ?, ?)`,
        [name.value, description.value ?? null, actor.name, actor.type],
      );
      const goal = await loadGoal(insertId);
      recordAudit(req, { action: 'create', entityType, entityId: insertId, next: goal });
      res.status(201).json(goal);
    } catch (err) { next(err); }
  });

  /* ── Update ─────────────────────────────────────────────────────────────── */

  router.put('/:id', requireSuperadmin, async (req, res, next) => {
    const { id } = req.params;
    const name = normalizeGoalName(req.body?.name, { required: false });
    if ('error' in name) return res.status(400).json({ error: name.error });
    const description = normalizeDescription(req.body?.description);
    if ('error' in description) return res.status(400).json({ error: description.error });

    try {
      const { rows: existing } = await db.query(
        `SELECT id, name, description, status, slug FROM ${table} WHERE id = ? AND gym_id IS NULL`,
        [id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Goal is deleted' });

      if (name.value !== undefined) {
        const { rows: conflict } = await db.query(
          `SELECT id FROM ${table} WHERE gym_id IS NULL AND name = ? AND id != ? AND status != 'deleted'`,
          [name.value, id],
        );
        if (conflict.length > 0) return res.status(409).json({ error: 'A goal with this name already exists' });
      }

      // `slug` is not writable: it is the handle the admin's locale key is built
      // from, so renaming one would silently move a seeded goal's label to the
      // key's verbatim text. The displayed name is `name`, which is editable.
      const updates = ['modified_at = UTC_TIMESTAMP()', 'modified_by_name = ?', 'modified_by_type = ?'];
      const actor = platformActor(req);
      const params: unknown[] = [actor.name, actor.type];
      if (name.value !== undefined) { updates.push('name = ?'); params.push(name.value); }
      if (description.value !== undefined) { updates.push('description = ?'); params.push(description.value); }
      params.push(id);
      await db.query(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = ?`, params);

      const goal = await loadGoal(id);
      recordAudit(req, { action: 'update', entityType, entityId: id, previous: existing[0], next: goal });
      res.json(goal);
    } catch (err) { next(err); }
  });

  /* ── Soft delete ────────────────────────────────────────────────────────── */

  router.delete('/:id', requireSuperadmin, async (req, res, next) => {
    const { id } = req.params;
    try {
      const { rows: existing } = await db.query(
        `SELECT id, status FROM ${table} WHERE id = ? AND gym_id IS NULL`,
        [id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Goal is already deleted' });

      const actor = platformActor(req);
      await db.query(
        `UPDATE ${table}
         SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by_name = ?, deleted_by_type = ?,
             modified_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [actor.name, actor.type, id],
      );
      recordAudit(req, { action: 'delete', entityType, entityId: id, previous: existing[0] });
      res.status(204).send();
    } catch (err) { next(err); }
  });

  return router;
}

export const platformPersonalGoalsRouter = createPlatformGoalLibraryRouter('personal');
export const platformNutritionGoalsRouter = createPlatformGoalLibraryRouter('nutrition');
