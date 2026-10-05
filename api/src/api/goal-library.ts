import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireFeatureWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  GOAL_LIBRARY_AUDIT_ENTITIES,
  GOAL_LIBRARY_FEATURE_KEYS,
  GOAL_LIBRARY_TABLES,
  GoalLibraryKind,
  buildGoalListWhere,
  isMeasurableGoalKind,
  normalizeGoalName,
} from '../domain/goalLibrary';
// What a goal **target** is lives in one module, shared with the assignment side
// (#1034 §1 — "do not introduce a second, incompatible unit system").
import { normalizeTargetUnit, normalizeTargetValue, targetPairError } from '../domain/goalTarget';
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
  // #1034 §1: only a measurable kind has the pair, and `nutrition_goals` has no
  // such columns — projecting them there would answer ER_BAD_FIELD_ERROR, which
  // the global handler turns into a bare 500 (#966). `isMeasurableGoalKind()` is
  // the one place that decides it, asked here rather than branched on per route.
  const measurable = isMeasurableGoalKind(kind);
  // #1070: writes are gated on this catalogue's own feature key rather than on
  // `NUTRITION` alone, so a feature-level override reaches exactly the catalogue
  // it was declared for. With no override declared the guard answers precisely
  // what `requireModuleWrite('NUTRITION')` did.
  const requireWrite = requireFeatureWrite(GOAL_LIBRARY_FEATURE_KEYS[kind], 'NUTRITION');

  /**
   * The columns every goal-shaped response returns, declared once so this router
   * and the platform one cannot answer with different shapes (#799 §26).
   *
   * `maskPlatformActors`: this router also returns the System rows, which are
   * administered from Cordel — so their actor names are Cordel employees' and are
   * not published to every tenant. A gym's own rows carry theirs.
   */
  const COLUMNS = `g.id, g.gym_id, g.slug, g.name, g.status,${measurable ? ' g.target_value, g.target_unit,' : ''}
    g.created_at, g.modified_at,
    ${itemDetailColumnsSql('g', { maskPlatformActors: true })}`;

  /**
   * `target_value` is a DECIMAL, which mysql2 hands back as a string. Every
   * other number this API reports is a number (CLAUDE.md's rule for
   * `shapeProductBenefitRow()`), so the conversion happens once, here, rather
   * than in whichever page renders it. A non-measurable kind has no such key and
   * the row passes through untouched.
   */
  function shapeGoal<T extends Record<string, unknown>>(row: T) {
    if (!row || !measurable) return row;
    return {
      ...row,
      target_value: row.target_value === null || row.target_value === undefined
        ? null
        : Number(row.target_value),
    };
  }

  async function loadGoal(id: unknown) {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM ${table} g WHERE g.id = ?`, [id]);
    return rows[0] ? shapeGoal(rows[0]) : undefined;
  }

  /**
   * The submitted target pair, or the 400 that describes it. Answered for a
   * measurable kind only: a request that names a target on a Nutrition Goal is
   * ignored rather than refused, exactly as a submitted `slug` is — there is no
   * column for it, and the field is not part of that kind's contract.
   */
  function readTarget(body: any): { value: { value: number | null | undefined; unit: string | null | undefined } } | { error: string } {
    if (!measurable) return { value: { value: undefined, unit: undefined } };
    const value = normalizeTargetValue(body?.target_value);
    if ('error' in value) return { error: value.error };
    const unit = normalizeTargetUnit(body?.target_unit);
    if ('error' in unit) return { error: unit.error };
    return { value: { value: value.value, unit: unit.value } };
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
      res.json({ items: rows.map(shapeGoal), total: countRows[0]?.total ?? 0, limit, offset });
    } catch (err) { next(err); }
  });

  /* ── Create (gym-owned goals only) ──────────────────────────────────────── */

  router.post('/', requireWrite, async (req, res, next) => {
    const { gymId, actorName, isSuperadmin } = getTenantContext(req);
    const name = normalizeGoalName(req.body?.name, { required: true });
    if ('error' in name) return res.status(400).json({ error: name.error });
    const description = normalizeDescription(req.body?.description);
    if ('error' in description) return res.status(400).json({ error: description.error });
    const target = readTarget(req.body);
    if ('error' in target) return res.status(400).json({ error: target.error });
    // On a create an unmentioned field is simply empty, so the cross-field rule
    // is applied to exactly what will be stored.
    const pairError = targetPairError({
      targetValue: target.value.value ?? null,
      targetUnit: target.value.unit ?? null,
    });
    if (pairError) return res.status(400).json({ error: pairError });
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
        `INSERT INTO ${table} (gym_id, name, description,${measurable ? ' target_value, target_unit,' : ''}
           status, created_by_name, created_by_type)
         VALUES (?, ?, ?,${measurable ? ' ?, ?,' : ''} 'active', ?, ?)`,
        [
          gymId, name.value, description.value ?? null,
          ...(measurable ? [target.value.value ?? null, target.value.unit ?? null] : []),
          actor.name, actor.type,
        ],
      );
      const goal = await loadGoal(insertId);
      recordAudit(req, { action: 'create', entityType, entityId: insertId, next: goal });
      res.status(201).json(goal);
    } catch (err) { next(err); }
  });

  /* ── Update (gym-owned goals only — System goals are read-only here) ────── */

  router.put('/:id', requireWrite, async (req, res, next) => {
    const { gymId, actorName, isSuperadmin } = getTenantContext(req);
    const { id } = req.params;
    const name = normalizeGoalName(req.body?.name, { required: false });
    if ('error' in name) return res.status(400).json({ error: name.error });
    const description = normalizeDescription(req.body?.description);
    if ('error' in description) return res.status(400).json({ error: description.error });
    const target = readTarget(req.body);
    if ('error' in target) return res.status(400).json({ error: target.error });
    const actor = actorSnapshot({ name: actorName, isSuperadmin });

    try {
      const { rows: existing } = await db.query(
        `SELECT id, gym_id, name, description, status${measurable ? ', target_value, target_unit' : ''}
         FROM ${table} WHERE id = ?`,
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
      if (measurable) {
        // Checked against the row the write produces, not against the body:
        // clearing `target_value` while a stored `target_unit` stays behind is
        // exactly the case a per-field check misses, and the CHECK beside the
        // table would answer it as a driver error rather than the 400 it is.
        const pairError = targetPairError({
          targetValue: target.value.value === undefined
            ? toNumberOrNull(existing[0].target_value) : target.value.value,
          targetUnit: target.value.unit === undefined
            ? (existing[0].target_unit ?? null) : target.value.unit,
        });
        if (pairError) return res.status(400).json({ error: pairError });
        if (target.value.value !== undefined) { updates.push('target_value = ?'); params.push(target.value.value); }
        if (target.value.unit !== undefined) { updates.push('target_unit = ?'); params.push(target.value.unit); }
      }
      params.push(id);
      await db.query(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = ?`, params);

      const goal = await loadGoal(id);
      recordAudit(req, {
        action: 'update', entityType, entityId: id,
        previous: shapeGoal(existing[0]), next: goal,
      });
      res.json(goal);
    } catch (err) { next(err); }
  });

  /* ── Soft delete (gym-owned goals only) ─────────────────────────────────── */

  router.delete('/:id', requireWrite, async (req, res, next) => {
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

/** A DECIMAL the driver handed back as a string, as the number it is. */
function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
