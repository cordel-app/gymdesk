import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry } from '../infra/db-helpers';
import { actorSnapshot, clampLimit, clampOffset } from '../domain/nutritionLibrary';
import {
  PERSONAL_GOAL_ASSIGNMENT_STATUSES,
  buildAssignmentListWhere,
  goalAssignmentFieldError,
  normalizeGoalDate,
  normalizeNotes,
  normalizeStatus,
  normalizeTargetUnit,
  normalizeTargetValue,
} from '../domain/personalGoalAssignment';

/**
 * #948 §4 — **Assigned Personal Goals**: the Personal Goals a gym's members
 * actually hold. The catalogue (`/personal-goals`, #947) says which goals exist;
 * this router says who holds which, with the target, the dates, the progress and
 * the notes it was agreed with (migration 212).
 *
 * It is a Personal Goals router and not a Nutrition one (§8): it reads no
 * nutrition plan, no nutrition goal and no library food, and the only catalogue
 * it joins is `personal_goals`. It is mounted behind the NUTRITION module and the
 * `nutrition.personal_goals` feature flag for the reason the catalogue itself is
 * — the two share a navigation group and a permission surface, and nothing else.
 *
 * Three rules are the ticket's rather than this file's:
 *
 * * **The goal must be one this gym can see.** The catalogue is the shared
 *   platform-catalogue shape, so `(gym_id IS NULL OR gym_id = ?)` is the check on
 *   the way in — a System goal is assignable, another gym's is not, and a
 *   soft-deleted one is not (assigning a goal the gym has retired is how a list
 *   comes to show a name nothing in the catalogue offers).
 * * **The assignment is the thing that is edited, never the goal.** `member_id`
 *   and `personal_goal_id` are immutable: changing either would silently turn one
 *   member's record into another's rather than ending one assignment and starting
 *   the next, and both are what the audit rows are keyed by. Re-pointing is
 *   `DELETE` plus `POST`.
 * * **`PUT` is partial.** A field the body does not mention keeps what it is
 *   stored with (`api/src/domain/personalGoalAssignment.ts` decides that), so a
 *   client sending only `{ status }` cannot wipe a target the gym typed.
 */
export const memberPersonalGoalsRouter = Router();

/**
 * The columns every assignment-shaped response returns, declared once so the
 * list, the single read and the three mutations cannot answer with different
 * shapes (#799 §26).
 *
 * The goal's `slug` and `gym_id` travel with its `name` because the admin needs
 * all three: a seeded System goal is shown under its
 * `goal_library.personal_goal_<slug>` locale key with the stored name as the
 * fallback (`goalDisplayName()`), and `goal_gym_id IS NULL` is what the `System`
 * badge reads. Resolving that label server-side is not an option — it is the
 * viewer's language, not the row's.
 */
const COLUMNS = `
  mpg.id, mpg.gym_id, mpg.member_id, mpg.personal_goal_id,
  mpg.target_value, mpg.target_unit, mpg.start_date, mpg.target_date,
  mpg.status, mpg.notes,
  mpg.created_at, mpg.modified_at, mpg.deleted_at,
  mpg.created_by_name, mpg.created_by_type,
  mpg.modified_by_name, mpg.modified_by_type,
  mpg.deleted_by_name, mpg.deleted_by_type,
  m.name AS member_name,
  pg.name AS goal_name, pg.slug AS goal_slug, pg.gym_id AS goal_gym_id,
  pg.status AS goal_status
`;

const FROM = `
  FROM member_personal_goals mpg
  JOIN members m ON m.id = mpg.member_id
  JOIN personal_goals pg ON pg.id = mpg.personal_goal_id
`;

/**
 * `target_value` is a DECIMAL, which mysql2 hands back as a string. Every other
 * number this API reports is a number (CLAUDE.md's rule for
 * `shapeSellableItemBenefitRow()`), so the conversion happens once, here, rather
 * than in whichever page renders it.
 */
function shapeAssignment<T extends { target_value: unknown }>(row: T) {
  return {
    ...row,
    target_value: row.target_value === null || row.target_value === undefined
      ? null
      : Number(row.target_value),
  };
}

async function loadAssignment(id: unknown, gymId: string) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM} WHERE mpg.id = ? AND mpg.gym_id = ?`,
    [id, gymId],
  );
  return rows[0] ? shapeAssignment(rows[0]) : undefined;
}

/* ── Statuses ─────────────────────────────────────────────────────────────────
 * Served from the same constant the write routes validate against, so the
 * admin's status selector cannot offer a value the CHECK would refuse and does
 * not carry a second copy of the set. Registered **before** `/:id`, or Express
 * reads `statuses` as an id. */

memberPersonalGoalsRouter.get('/statuses', (_req, res) => {
  res.json({ statuses: PERSONAL_GOAL_ASSIGNMENT_STATUSES });
});

/* ── List ─────────────────────────────────────────────────────────────────── */

memberPersonalGoalsRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);

  const base = ['mpg.gym_id = ?', 'mpg.deleted_at IS NULL', 'm.deleted_at IS NULL'];
  const baseParams: unknown[] = [gymId];

  const memberId = req.query.member_id;
  if (memberId !== undefined && memberId !== '') {
    const n = Number(memberId);
    if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'member_id must be a member id' });
    base.push('mpg.member_id = ?');
    baseParams.push(n);
  }

  const status = normalizeStatus(req.query.status, { required: false });
  if ('error' in status) return res.status(400).json({ error: status.error });
  if (status.value !== undefined) {
    base.push('mpg.status = ?');
    baseParams.push(status.value);
  }

  const { where, params } = buildAssignmentListWhere(req.query.search, base, baseParams);
  const limit = clampLimit(req.query.limit);
  const offset = clampOffset(req.query.offset);

  try {
    const { rows: countRows } = await db.query<{ total: number }>(
      `SELECT COUNT(*) AS total ${FROM} WHERE ${where}`,
      params,
    );
    // LIMIT/OFFSET must be literals, not `?` parameters: MySQL 8's
    // prepared-statement protocol rejects a parameterised LIMIT
    // (ER_WRONG_ARGUMENTS). Both are already validated integers.
    //
    // Ordered by the member, then by the goal's stored name — a System goal's
    // label is a locale key the admin resolves, so there is no localized column
    // to sort on, exactly as the catalogue's own list reasons.
    const { rows } = await db.query(
      `SELECT ${COLUMNS} ${FROM} WHERE ${where}
       ORDER BY m.name ASC, pg.name ASC, mpg.id ASC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({ items: rows.map(shapeAssignment), total: countRows[0]?.total ?? 0, limit, offset });
  } catch (err) { next(err); }
});

/* ── Single read ──────────────────────────────────────────────────────────── */

memberPersonalGoalsRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const assignment = await loadAssignment(req.params.id, gymId);
    if (!assignment || assignment.deleted_at !== null) {
      return res.status(404).json({ error: 'Assigned personal goal not found' });
    }
    res.json(assignment);
  } catch (err) { next(err); }
});

/* ── Assign ───────────────────────────────────────────────────────────────── */

memberPersonalGoalsRouter.post('/', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId, actorName, isSuperadmin } = getTenantContext(req);

  const memberId = Number(req.body?.member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ error: 'member_id is required' });
  }
  const goalId = Number(req.body?.personal_goal_id);
  if (!Number.isInteger(goalId) || goalId <= 0) {
    return res.status(400).json({ error: 'personal_goal_id is required' });
  }

  const targetValue = normalizeTargetValue(req.body?.target_value);
  if ('error' in targetValue) return res.status(400).json({ error: targetValue.error });
  const targetUnit = normalizeTargetUnit(req.body?.target_unit);
  if ('error' in targetUnit) return res.status(400).json({ error: targetUnit.error });
  const startDate = normalizeGoalDate(req.body?.start_date, 'start_date');
  if ('error' in startDate) return res.status(400).json({ error: startDate.error });
  const targetDate = normalizeGoalDate(req.body?.target_date, 'target_date');
  if ('error' in targetDate) return res.status(400).json({ error: targetDate.error });
  const notes = normalizeNotes(req.body?.notes);
  if ('error' in notes) return res.status(400).json({ error: notes.error });
  const status = normalizeStatus(req.body?.status, { required: false });
  if ('error' in status) return res.status(400).json({ error: status.error });

  // On a create an unmentioned field is simply empty, so the cross-field rules
  // are applied to exactly what will be stored.
  const fieldError = goalAssignmentFieldError({
    targetValue: targetValue.value ?? null,
    targetUnit: targetUnit.value ?? null,
    startDate: startDate.value ?? null,
    targetDate: targetDate.value ?? null,
  });
  if (fieldError) return res.status(400).json({ error: fieldError });

  const actor = actorSnapshot({ name: actorName, isSuperadmin });

  try {
    const { rows: memberRows } = await db.query(
      'SELECT 1 FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [memberId, gymId],
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

    // The catalogue's own gym-facing visibility rule: a System goal (`gym_id IS
    // NULL`) is assignable by every gym, this gym's own goals are assignable, and
    // a retired one is not — assigning a goal the gym has deleted is how a list
    // comes to name something the catalogue no longer offers.
    const { rows: goalRows } = await db.query(
      `SELECT id FROM personal_goals
       WHERE id = ? AND (gym_id IS NULL OR gym_id = ?) AND status != 'deleted'`,
      [goalId, gymId],
    );
    if (goalRows.length === 0) return res.status(404).json({ error: 'Personal goal not found' });

    const { insertId } = await db.query(
      `INSERT INTO member_personal_goals
         (gym_id, member_id, personal_goal_id, target_value, target_unit,
          start_date, target_date, status, notes, created_by_name, created_by_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'in_progress'), ?, ?, ?)`,
      [
        gymId, memberId, goalId,
        targetValue.value ?? null, targetUnit.value ?? null,
        startDate.value ?? null, targetDate.value ?? null,
        status.value ?? null, notes.value ?? null,
        actor.name, actor.type,
      ],
    );

    const assignment = await loadAssignment(insertId, gymId);
    recordAudit(req, { action: 'assign', entityType: 'member_personal_goal', entityId: insertId, next: assignment });
    res.status(201).json(assignment);
  } catch (err) {
    // `mpgoal_live_goal_key` (migration 212) is the one unique index here: one
    // live, in-progress assignment per (member, goal). The 409 and the index say
    // the same thing, so the duplicate is reported rather than surfacing as a 500.
    handleDupEntry(err, res, next, 'This goal is already assigned to this member');
  }
});

/* ── Edit ─────────────────────────────────────────────────────────────────── */

memberPersonalGoalsRouter.put('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId, actorName, isSuperadmin } = getTenantContext(req);
  const { id } = req.params;

  const targetValue = normalizeTargetValue(req.body?.target_value);
  if ('error' in targetValue) return res.status(400).json({ error: targetValue.error });
  const targetUnit = normalizeTargetUnit(req.body?.target_unit);
  if ('error' in targetUnit) return res.status(400).json({ error: targetUnit.error });
  const startDate = normalizeGoalDate(req.body?.start_date, 'start_date');
  if ('error' in startDate) return res.status(400).json({ error: startDate.error });
  const targetDate = normalizeGoalDate(req.body?.target_date, 'target_date');
  if ('error' in targetDate) return res.status(400).json({ error: targetDate.error });
  const notes = normalizeNotes(req.body?.notes);
  if ('error' in notes) return res.status(400).json({ error: notes.error });
  const status = normalizeStatus(req.body?.status, { required: false });
  if ('error' in status) return res.status(400).json({ error: status.error });

  const actor = actorSnapshot({ name: actorName, isSuperadmin });

  try {
    const previous = await loadAssignment(id, gymId);
    if (!previous || previous.deleted_at !== null) {
      return res.status(404).json({ error: 'Assigned personal goal not found' });
    }

    // The cross-field rules are checked against the row the write produces, not
    // against the body: clearing `target_value` while a stored `target_unit`
    // stays behind is exactly the case a per-field check misses.
    const next = {
      targetValue: targetValue.value === undefined ? previous.target_value : targetValue.value,
      targetUnit: targetUnit.value === undefined ? previous.target_unit : targetUnit.value,
      startDate: startDate.value === undefined ? dateOnly(previous.start_date) : startDate.value,
      targetDate: targetDate.value === undefined ? dateOnly(previous.target_date) : targetDate.value,
    };
    const fieldError = goalAssignmentFieldError(next);
    if (fieldError) return res.status(400).json({ error: fieldError });

    // The actor pair moves with every edit, so `modified_by_name` always names
    // whoever `modified_at` refers to (#799 §13).
    const updates = ['modified_at = UTC_TIMESTAMP()', 'modified_by_name = ?', 'modified_by_type = ?'];
    const params: unknown[] = [actor.name, actor.type];
    // `undefined` is "the body did not mention it"; `null` is an explicit clear.
    if (targetValue.value !== undefined) { updates.push('target_value = ?'); params.push(targetValue.value); }
    if (targetUnit.value !== undefined) { updates.push('target_unit = ?'); params.push(targetUnit.value); }
    if (startDate.value !== undefined) { updates.push('start_date = ?'); params.push(startDate.value); }
    if (targetDate.value !== undefined) { updates.push('target_date = ?'); params.push(targetDate.value); }
    if (notes.value !== undefined) { updates.push('notes = ?'); params.push(notes.value); }
    if (status.value !== undefined) { updates.push('status = ?'); params.push(status.value); }
    params.push(id, gymId);

    await db.query(
      `UPDATE member_personal_goals SET ${updates.join(', ')} WHERE id = ? AND gym_id = ?`,
      params,
    );

    const assignment = await loadAssignment(id, gymId);
    recordAudit(req, {
      action: 'update', entityType: 'member_personal_goal', entityId: id,
      previous, next: assignment,
    });
    res.json(assignment);
  } catch (err) {
    // Moving an achieved assignment back to `in_progress` can collide with the
    // one that replaced it, which is the same rule as on create.
    handleDupEntry(err, res, next, 'This goal is already assigned to this member');
  }
});

/* ── Unassign (soft delete) ───────────────────────────────────────────────── */

memberPersonalGoalsRouter.delete('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId, actorName, isSuperadmin } = getTenantContext(req);
  const { id } = req.params;
  const actor = actorSnapshot({ name: actorName, isSuperadmin });

  try {
    const previous = await loadAssignment(id, gymId);
    if (!previous) return res.status(404).json({ error: 'Assigned personal goal not found' });
    if (previous.deleted_at !== null) return res.status(409).json({ error: 'Assigned personal goal is already deleted' });

    // `deleted_at` is the live predicate every query filters on, and the progress
    // `status` is deliberately left where it was: a goal deleted after being
    // achieved still records that it was achieved (migration 212).
    await db.query(
      `UPDATE member_personal_goals
       SET deleted_at = UTC_TIMESTAMP(), deleted_by_name = ?, deleted_by_type = ?,
           modified_at = UTC_TIMESTAMP()
       WHERE id = ? AND gym_id = ?`,
      [actor.name, actor.type, id, gymId],
    );
    recordAudit(req, { action: 'delete', entityType: 'member_personal_goal', entityId: id, previous });
    res.status(204).send();
  } catch (err) { next(err); }
});

/**
 * A DATE column comes back from mysql2 as a `Date` (or already as a string,
 * depending on the driver's `dateStrings`), and the cross-field comparison above
 * is a string one — `YYYY-MM-DD` sorts lexicographically. Normalising here keeps
 * that true whichever the driver hands over.
 */
function dateOnly(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
