import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  GOAL_LIBRARY_AUDIT_ENTITIES,
  GOAL_LIBRARY_TABLES,
  GoalLibraryKind,
  buildGoalListWhere,
  normalizeGoalName,
} from '../domain/goalLibrary';
// The description rules and the actor snapshot are the Foods library's, reused
// rather than restated: a goal row carries the same `description` + three actor
// pairs migration 196 put on `nutrition_library_items`, for the same #799 reasons,
// and `itemDetailColumnsSql` only ever names the alias it is given.
import {
  actorSnapshot, clampLimit, clampOffset, itemDetailColumnsSql, normalizeDescription,
} from '../domain/nutritionLibrary';

/**
 * #947 — a gym's view of one goal catalogue (Personal Goals or Nutrition Goals).
 *
 * One factory serves both kinds because the two tables are identical in shape
 * (`api/src/domain/goalLibrary.ts` is what decides that); the kind decides the
 * table and the audit entity type and nothing else. Mounted twice in `app.ts`, at
 * `/personal-goals` and `/nutrition-goals`.
 *
 * Visibility is the Foods library's, unchanged (§5): the **System** rows
 * (`gym_id IS NULL`) are always listed and are read-only here — they are
 * administered from Cordel — and the gym's own rows are listed, editable and
 * deletable with write access. A gym may not touch a System row through this
 * router, and `/platform/*` is where those are administered.
 */
export function createGoalLibraryRouter(kind: GoalLibraryKind): Router {
  const router = Router();
  const table = GOAL_LIBRARY_TABLES[kind];
  const entityType = GOAL_LIBRARY_AUDIT_ENTITIES[kind];

  /**
   * The columns every goal-shaped response returns, declared once so this router
   * and the platform one cannot answer with different shapes (#799 §26).
   *
   * `maskPlatformActors`: this router also returns the System rows, which are
   * administered from Cordel — so their actor names are Cordel employees' and are
   * not published to every tenant. A gym's own rows carry theirs.
   */
  const COLUMNS = `g.id, g.gym_id, g.slug, g.name, g.status, g.created_at, g.modified_at,
    ${itemDetailColumnsSql('g', { maskPlatformActors: true })}`;

  async function loadGoal(id: unknown) {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM ${table} g WHERE g.id = ?`, [id]);
    return rows[0];
  }

  /* ── List ───────────────────────────────────────────────────────────────── */

  router.get('/', async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    const { where, params } = buildGoalListWhere(
      req.query.search,
      ['(g.gym_id IS NULL OR g.gym_id = ?)', "g.status != 'deleted'"],
      [gymId],
    );
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);

    try {
      const { rows: countRows } = await db.query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM ${table} g WHERE ${where}`,
        params,
      );
      // LIMIT/OFFSET must be literals, not `?` parameters: MySQL 8's
      // prepared-statement protocol rejects a parameterised LIMIT
      // (ER_WRONG_ARGUMENTS). Both are already validated integers.
      //
      // Ordered by the stored `name`, not by what the viewer reads: a seeded
      // System row's label is a locale key the admin resolves, so there is no
      // localized column to sort on (which is what the Foods library's
      // `display_name` is). The base names are the English ones the slugs were
      // seeded with, so the order is stable rather than per-request.
      const { rows } = await db.query(
        `SELECT ${COLUMNS} FROM ${table} g WHERE ${where} ORDER BY g.name ASC LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      res.json({ items: rows, total: countRows[0]?.total ?? 0, limit, offset });
    } catch (err) { next(err); }
  });

  /* ── Create (gym-owned goals only) ──────────────────────────────────────── */

  router.post('/', requireModuleWrite('NUTRITION'), async (req, res, next) => {
    const { gymId, actorName, isSuperadmin } = getTenantContext(req);
    const name = normalizeGoalName(req.body?.name, { required: true });
    if ('error' in name) return res.status(400).json({ error: name.error });
    const description = normalizeDescription(req.body?.description);
    if ('error' in description) return res.status(400).json({ error: description.error });
    const actor = actorSnapshot({ name: actorName, isSuperadmin });

    try {
      // Scoped to this gym's own rows: a System goal called "Water" must not stop
      // a gym from naming one of its own the same way, which is also what the
      // (gym, name) shape of `<prefix>_live_name_key` allows.
      const { rows: existing } = await db.query(
        `SELECT id FROM ${table} WHERE gym_id = ? AND name = ? AND status != 'deleted'`,
        [gymId, name.value],
      );
      if (existing.length > 0) return res.status(409).json({ error: 'A goal with this name already exists' });

      // `slug` is deliberately not written: it is a System row's label handle and
      // `chk_<prefix>_slug_system_only` refuses one on a gym row.
      const { insertId } = await db.query(
        `INSERT INTO ${table} (gym_id, name, description, status, created_by_name, created_by_type)
         VALUES (?, ?, ?, 'active', ?, ?)`,
        [gymId, name.value, description.value ?? null, actor.name, actor.type],
      );
      const goal = await loadGoal(insertId);
      recordAudit(req, { action: 'create', entityType, entityId: insertId, next: goal });
      res.status(201).json(goal);
    } catch (err) { next(err); }
  });

  /* ── Update (gym-owned goals only — System goals are read-only here) ────── */

  router.put('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
    const { gymId, actorName, isSuperadmin } = getTenantContext(req);
    const { id } = req.params;
    const name = normalizeGoalName(req.body?.name, { required: false });
    if ('error' in name) return res.status(400).json({ error: name.error });
    const description = normalizeDescription(req.body?.description);
    if ('error' in description) return res.status(400).json({ error: description.error });
    const actor = actorSnapshot({ name: actorName, isSuperadmin });

    try {
      const { rows: existing } = await db.query(
        `SELECT id, gym_id, name, description, status FROM ${table} WHERE id = ?`,
        [id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].gym_id === null) return res.status(403).json({ error: 'System goals are read-only' });
      if (existing[0].gym_id !== gymId) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Goal is deleted' });

      if (name.value !== undefined) {
        const { rows: conflict } = await db.query(
          `SELECT id FROM ${table} WHERE gym_id = ? AND name = ? AND id != ? AND status != 'deleted'`,
          [gymId, name.value, id],
        );
        if (conflict.length > 0) return res.status(409).json({ error: 'A goal with this name already exists' });
      }

      // The actor pair moves with every edit, so `modified_by_name` always names
      // whoever `modified_at` refers to (#799 §13).
      const updates = ['modified_at = UTC_TIMESTAMP()', 'modified_by_name = ?', 'modified_by_type = ?'];
      const params: unknown[] = [actor.name, actor.type];
      if (name.value !== undefined) { updates.push('name = ?'); params.push(name.value); }
      // Absent from the body means "leave it alone"; an empty string means "clear it".
      if (description.value !== undefined) { updates.push('description = ?'); params.push(description.value); }
      params.push(id);
      await db.query(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = ?`, params);

      const goal = await loadGoal(id);
      recordAudit(req, { action: 'update', entityType, entityId: id, previous: existing[0], next: goal });
      res.json(goal);
    } catch (err) { next(err); }
  });

  /* ── Soft delete (gym-owned goals only) ─────────────────────────────────── */

  router.delete('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
    const { gymId, actorName, isSuperadmin } = getTenantContext(req);
    const { id } = req.params;
    const actor = actorSnapshot({ name: actorName, isSuperadmin });

    try {
      const { rows: existing } = await db.query(
        `SELECT id, gym_id, status FROM ${table} WHERE id = ?`,
        [id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].gym_id === null) return res.status(403).json({ error: 'System goals are read-only' });
      if (existing[0].gym_id !== gymId) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Goal is already deleted' });

      // `status = 'deleted'` stays the flag every query filters on; `deleted_at`
      // and the actor pair record when and by whom (#799 §13). The deletion also
      // releases the name: `<prefix>_live_name_key` is NULL for a deleted row.
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

export const personalGoalsRouter = createGoalLibraryRouter('personal');
export const nutritionGoalsRouter = createGoalLibraryRouter('nutrition');
