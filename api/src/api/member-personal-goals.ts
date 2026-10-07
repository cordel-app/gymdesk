import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireFeatureWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry } from '../infra/db-helpers';
import { actorSnapshot, clampLimit, clampOffset } from '../domain/nutritionLibrary';
// The catalogue's own feature key, so this router and `/personal-goals` are
// gated by one declaration (#1070 — a feature-level permission override applies
// to the key, so the two halves of Personal Goals cannot be granted apart).
import { GOAL_LIBRARY_FEATURE_KEYS, gymGoalStatusSql } from '../domain/goalLibrary';
import {
  PERSONAL_GOAL_ASSIGNMENT_STATUSES,
  buildAssignmentListWhere,
  endDateTransition,
  goalAssignmentFieldError,
  isLiveAssignment,
  normalizeGoalDate,
  normalizeNotes,
  normalizeStatus,
  normalizeTargetUnit,
  normalizeTargetValue,
  toDateOnly,
  utcToday,
} from '../domain/personalGoalAssignment';
import {
  initialReadingTimestamp, normalizeReadingValue, normalizeRecordedAt,
} from '../domain/goalReadings';
import {
  insertGoalReading, loadGoalReadings, withReadingSummaries, withReadingSummary,
} from './goal-readings';

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

// #1070: writes are gated on `nutrition.personal_goals` rather than on the
// NUTRITION module alone, so a Personal Trainer's `RW` override reaches the
// goals a member holds and nothing else of Nutrition. With no override declared
// it answers exactly what `requireModuleWrite('NUTRITION')` did.
const requireWrite = requireFeatureWrite(GOAL_LIBRARY_FEATURE_KEYS.personal, 'NUTRITION');

/**
 * The columns every assignment-shaped response returns, declared once so the
 * list, the single read and the three mutations cannot answer with different
 * shapes (#799 §26).
 *
 * `goal_name` is the **snapshot** taken when the assignment was created
 * (`member_personal_goals.goal_name`, migration 218), not the catalogue's current
 * name: #1034 §7/§12 are explicit that renaming a Gym Goal must not change an
 * assignment that already exists, and reading it live is what made it. The live
 * name is its one fallback, for a row assigned before that migration — which has
 * nothing else to read, exactly as an un-snapshotted Promotion application reads
 * the live tables (#635 §16).
 *
 * The goal's `slug` and `gym_id` travel with it because the admin needs
 * all three: a seeded System goal is shown under its
 * `goal_library.personal_goal_<slug>` locale key with the stored name as the
 * fallback (`goalDisplayName()`), and `goal_gym_id IS NULL` is what the `System`
 * badge reads. Resolving that label server-side is not an option — it is the
 * viewer's language, not the row's.
 */
const COLUMNS = `
  mpg.id, mpg.gym_id, mpg.member_id, mpg.personal_goal_id,
  mpg.target_value, mpg.target_unit, mpg.start_date, mpg.target_date,
  mpg.end_date,
  mpg.status, mpg.notes,
  mpg.created_at, mpg.modified_at, mpg.deleted_at,
  mpg.created_by_name, mpg.created_by_type,
  mpg.modified_by_name, mpg.modified_by_type,
  mpg.deleted_by_name, mpg.deleted_by_type,
  m.name AS member_name,
  COALESCE(mpg.goal_name, pg.name) AS goal_name,
  pg.slug AS goal_slug, pg.gym_id AS goal_gym_id,
  pg.status AS goal_status
`;

/**
 * Both joins carry the tenant predicate as well as the key. Nothing in SQL can
 * tie `mpg.gym_id` to `members.gym_id` — `members` has no `(gym_id, id)` unique
 * key for a composite FK to reference, which is true of every domain table here
 * — so `POST /`'s two existence checks are the enforcement point. Repeating the
 * predicate on the way out means a row that somehow named one gym and another
 * gym's member or goal is *hidden* rather than served to the wrong tenant.
 */
const FROM = `
  FROM member_personal_goals mpg
  JOIN members m ON m.id = mpg.member_id AND m.gym_id = mpg.gym_id
  JOIN personal_goals pg ON pg.id = mpg.personal_goal_id
                        AND (pg.gym_id IS NULL OR pg.gym_id = mpg.gym_id)
`;

/**
 * `target_value` is a DECIMAL, which mysql2 hands back as a string. Every other
 * number this API reports is a number (CLAUDE.md's rule for
 * `shapeProductBenefitRow()`), so the conversion happens once, here, rather
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

/**
 * #1037 §5–§11 — every assignment-shaped response carries the reading summary
 * (`initial_reading`, `latest_reading`, `progress_percent`, …), computed from
 * `member_personal_goal_readings` on each read rather than stored beside the
 * target: a card that showed a target with nothing to compare it against is
 * what the ticket is about, and a stored copy would need a writer in every path
 * that records a measurement.
 */
async function loadAssignmentRow(id: unknown, gymId: string) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM} WHERE mpg.id = ? AND mpg.gym_id = ?`,
    [id, gymId],
  );
  return rows[0] ? shapeAssignment(rows[0]) : undefined;
}

async function loadAssignment(id: unknown, gymId: string) {
  const row = await loadAssignmentRow(id, gymId);
  return row ? withReadingSummary(row, gymId) : undefined;
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
    const items = await withReadingSummaries(rows.map(shapeAssignment), gymId);
    res.json({ items, total: countRows[0]?.total ?? 0, limit, offset });
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

memberPersonalGoalsRouter.post('/', requireWrite, async (req, res, next) => {
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

  // #1037 §4 — assigning a goal may establish its **initial reading**, the
  // first row of the reading history and the baseline progress is measured
  // from. Optional, because an assignment made before the member has been
  // measured is a real case: it then reports no readings and `—` for progress
  // until somebody records one.
  const initialReading = req.body?.initial_reading === undefined || req.body?.initial_reading === null || req.body?.initial_reading === ''
    ? undefined
    : normalizeReadingValue(req.body?.initial_reading);
  if (initialReading && 'error' in initialReading) return res.status(400).json({ error: initialReading.error });
  const initialReadingAt = normalizeRecordedAt(req.body?.initial_reading_at);
  if ('error' in initialReadingAt) return res.status(400).json({ error: initialReadingAt.error });

  // The cross-field rules are deliberately **not** checked here: since #1034 an
  // unmentioned target inherits the catalogue's, so the pair that gets stored is
  // only known after the goal has been read — and checking the submitted pair as
  // well would refuse a date order twice and a target pair against the wrong
  // values. The one check sits beside the INSERT, over the effective row.

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
      `SELECT pg.id, pg.name, pg.target_value, pg.target_unit, ${gymGoalStatusSql('pg')} AS gym_status
       FROM personal_goals pg
       WHERE pg.id = ? AND (pg.gym_id IS NULL OR pg.gym_id = ?) AND pg.status != 'deleted'`,
      [gymId, goalId, gymId],
    );
    if (goalRows.length === 0) return res.status(404).json({ error: 'Personal goal not found' });
    // #1181 — a goal this gym has deactivated is still in the catalogue (and
    // every existing assignment of it stands), but it is not offered for a new
    // one; enforced here, not only hidden in the picker.
    if (goalRows[0].gym_status !== 'active') {
      return res.status(409).json({ error: 'This Personal Goal is inactive for this gym', code: 'goal_inactive' });
    }

    // #1034 §7 — **the snapshot is the server's, not the form's.** A field the
    // request does not mention inherits the catalogue's own value, so an
    // assignment created by any client (the modal, a script, a test) carries the
    // Gym Goal as it stood at this moment; an explicit `null` is still a clear,
    // and a submitted value is the per-member override §8 exists for.
    //
    // The unit only inherits while the effective value is non-null: a unit
    // qualifying nothing is what `chk_mpgoal_target_unit` refuses, so inheriting
    // `kg` beside a target the request deliberately cleared would turn a valid
    // write into a 400 nobody asked for.
    const catalogue = goalRows[0];
    const effectiveValue = targetValue.value === undefined
      ? toNumberOrNull(catalogue.target_value)
      : targetValue.value;
    const effectiveUnit = targetUnit.value === undefined
      ? (effectiveValue === null ? null : (catalogue.target_unit ?? null))
      : targetUnit.value;

    const pairError = goalAssignmentFieldError({
      targetValue: effectiveValue,
      targetUnit: effectiveUnit,
      startDate: startDate.value ?? null,
      targetDate: targetDate.value ?? null,
    });
    if (pairError) return res.status(400).json({ error: pairError });

    // The assignment and its initial reading commit together (#1037 §4): an
    // initial reading that landed without its assignment, or an assignment
    // whose baseline was lost, are both states no read could explain.
    const insertId = await db.transaction(async (tx) => {
      const { insertId: assignmentId } = await tx.query(
        `INSERT INTO member_personal_goals
           (gym_id, member_id, personal_goal_id, goal_name, target_value, target_unit,
            start_date, target_date, status, notes, created_by_name, created_by_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'in_progress'), ?, ?, ?)`,
        [
          gymId, memberId, goalId, catalogue.name,
          effectiveValue, effectiveUnit,
          startDate.value ?? null, targetDate.value ?? null,
          status.value ?? null, notes.value ?? null,
          actor.name, actor.type,
        ],
      );
      if (initialReading && 'value' in initialReading) {
        await insertGoalReading(tx, {
          gymId,
          assignmentId,
          value: initialReading.value,
          // §4's "reuse the existing timestamp rather than creating an
          // unnecessary duplicate": the baseline was measured when the goal
          // started, so an explicit `initial_reading_at` wins, then the
          // assignment's own `start_date`, then now.
          recordedAt: initialReadingTimestamp({
            explicit: initialReadingAt.value,
            startDate: startDate.value ?? null,
          }),
          isInitial: true,
          actorName: actor.name,
          actorType: actor.type,
        });
      }
      return assignmentId;
    });

    const stored = await loadAssignmentRow(insertId, gymId);
    recordAudit(req, { action: 'assign', entityType: 'member_personal_goal', entityId: insertId, next: stored });
    res.status(201).json(stored ? await withReadingSummary(stored, gymId) : stored);
  } catch (err) {
    // `mpgoal_live_goal_key` (migration 212) is the one unique index here: one
    // live, in-progress assignment per (member, goal). The 409 and the index say
    // the same thing, so the duplicate is reported rather than surfacing as a 500.
    handleDupEntry(err, res, next, 'This goal is already assigned to this member');
  }
});

/* ── Edit ─────────────────────────────────────────────────────────────────── */

memberPersonalGoalsRouter.put('/:id', requireWrite, async (req, res, next) => {
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
    // The audit pair is the **stored** row, without the computed reading
    // summary (#1037): `progress_percent` is derived on read, so including it
    // would make a reading recorded between two edits read as an edit.
    const previous = await loadAssignmentRow(id, gymId);
    if (!previous || previous.deleted_at !== null) {
      return res.status(404).json({ error: 'Assigned personal goal not found' });
    }

    // The cross-field rules are checked against the row the write produces, not
    // against the body: clearing `target_value` while a stored `target_unit`
    // stays behind is exactly the case a per-field check misses.
    const next = {
      targetValue: targetValue.value === undefined ? previous.target_value : targetValue.value,
      targetUnit: targetUnit.value === undefined ? previous.target_unit : targetUnit.value,
      startDate: startDate.value === undefined ? toDateOnly(previous.start_date) : startDate.value,
      targetDate: targetDate.value === undefined ? toDateOnly(previous.target_date) : targetDate.value,
    };
    const fieldError = goalAssignmentFieldError(next);
    if (fieldError) return res.status(400).json({ error: fieldError });

    // #1036 `Q4` — **when the assignment ended.** A status this write moves out
    // of `in_progress` stamps today; one it moves back clears the stamp. The
    // rule is `endDateTransition()`'s alone, so the staff edit, the staff
    // removal and the member's own two writes cannot date the same transition
    // differently — and an edit that does not touch the status writes nothing.
    const endDate = endDateTransition({
      nextLive: isLiveAssignment({
        deleted_at: null,
        status: status.value === undefined ? previous.status : status.value,
      }),
      storedEndDate: toDateOnly(previous.end_date),
      today: utcToday(),
    });

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
    if (endDate !== undefined) { updates.push('end_date = ?'); params.push(endDate); }
    params.push(id, gymId);

    await db.query(
      `UPDATE member_personal_goals SET ${updates.join(', ')} WHERE id = ? AND gym_id = ?`,
      params,
    );

    const stored = await loadAssignmentRow(id, gymId);
    recordAudit(req, {
      action: 'update', entityType: 'member_personal_goal', entityId: id,
      previous, next: stored,
    });
    res.json(stored ? await withReadingSummary(stored, gymId) : stored);
  } catch (err) {
    // Moving an achieved assignment back to `in_progress` can collide with the
    // one that replaced it, which is the same rule as on create.
    handleDupEntry(err, res, next, 'This goal is already assigned to this member');
  }
});

/* ── Readings ─────────────────────────────────────────────────────────────────
 * #1037 — the measurement history of one assignment. Two writers, deliberately
 * separate: a reading is a measurement, and an **initial** reading is a new
 * baseline every later percentage is computed from (§21/§25). A single route
 * taking an `initial` flag would let a client re-baseline a member's goal by
 * passing a field through, and the audit row could not say which happened.
 *
 * There is no edit and no delete (§34): the history is append-only, and
 * correcting a measurement — which would move a chart point and could orphan an
 * initial-reading period — is its own decision and its own ticket. */

async function requireAssignment(id: unknown, gymId: string, res: any) {
  const assignment = await loadAssignment(id, gymId);
  if (!assignment || assignment.deleted_at !== null) {
    res.status(404).json({ error: 'Assigned personal goal not found' });
    return undefined;
  }
  return assignment;
}

memberPersonalGoalsRouter.get('/:id/readings', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const assignment = await requireAssignment(req.params.id, gymId, res);
    if (!assignment) return;
    res.json(await loadGoalReadings(assignment.id, gymId, assignment.target_value, { includeActor: true }));
  } catch (err) { next(err); }
});

memberPersonalGoalsRouter.post('/:id/readings', requireWrite, async (req, res, next) => {
  const { gymId, actorName, isSuperadmin } = getTenantContext(req);
  const value = normalizeReadingValue(req.body?.value);
  if ('error' in value) return res.status(400).json({ error: value.error });
  const recordedAt = normalizeRecordedAt(req.body?.recorded_at);
  if ('error' in recordedAt) return res.status(400).json({ error: recordedAt.error });
  const actor = actorSnapshot({ name: actorName, isSuperadmin });

  try {
    const assignment = await requireAssignment(req.params.id, gymId, res);
    if (!assignment) return;

    const readingId = await insertGoalReading(db, {
      gymId,
      assignmentId: assignment.id,
      value: value.value,
      recordedAt: recordedAt.value,
      isInitial: false,
      actorName: actor.name,
      actorType: actor.type,
    });

    // Audited against the **assignment**, which is the entity the Audit Log
    // already knows (`AUDIT_ENTITY_REGISTRY`'s `member_personal_goal`): a
    // reading is not an entity a gym administers on its own, and giving it a
    // registry entry of its own would put a measurement in the entity-type
    // filter beside the goals themselves.
    recordAudit(req, {
      action: 'add_reading', entityType: 'member_personal_goal', entityId: assignment.id,
      next: { reading_id: readingId, value: value.value, recorded_at: recordedAt.value ?? null },
    });
    res.status(201).json(await loadGoalReadings(assignment.id, gymId, assignment.target_value, { includeActor: true }));
  } catch (err) { next(err); }
});

/**
 * §21/§22 — changing the initial reading. It **adds** a reading flagged as a
 * new period boundary and changes nothing that is already stored: the
 * superseded initial reading keeps its value and its date, every measurement
 * stays where it is (§28), and the chart gains a period rather than losing one
 * (§23).
 */
memberPersonalGoalsRouter.post('/:id/initial-reading', requireWrite, async (req, res, next) => {
  const { gymId, actorName, isSuperadmin } = getTenantContext(req);
  const value = normalizeReadingValue(req.body?.value);
  if ('error' in value) return res.status(400).json({ error: value.error });
  const recordedAt = normalizeRecordedAt(req.body?.recorded_at);
  if ('error' in recordedAt) return res.status(400).json({ error: recordedAt.error });
  const actor = actorSnapshot({ name: actorName, isSuperadmin });

  try {
    const assignment = await requireAssignment(req.params.id, gymId, res);
    if (!assignment) return;

    const readingId = await insertGoalReading(db, {
      gymId,
      assignmentId: assignment.id,
      value: value.value,
      recordedAt: recordedAt.value,
      isInitial: true,
      actorName: actor.name,
      actorType: actor.type,
    });

    recordAudit(req, {
      action: 'set_initial_reading', entityType: 'member_personal_goal', entityId: assignment.id,
      previous: { initial_reading: assignment.initial_reading },
      next: { reading_id: readingId, value: value.value, recorded_at: recordedAt.value ?? null },
    });
    res.status(201).json(await loadGoalReadings(assignment.id, gymId, assignment.target_value, { includeActor: true }));
  } catch (err) { next(err); }
});

/* ── Unassign (soft delete) ───────────────────────────────────────────────── */

memberPersonalGoalsRouter.delete('/:id', requireWrite, async (req, res, next) => {
  const { gymId, actorName, isSuperadmin } = getTenantContext(req);
  const { id } = req.params;
  const actor = actorSnapshot({ name: actorName, isSuperadmin });

  try {
    const previous = await loadAssignmentRow(id, gymId);
    if (!previous) return res.status(404).json({ error: 'Assigned personal goal not found' });
    if (previous.deleted_at !== null) return res.status(409).json({ error: 'Assigned personal goal is already deleted' });

    // `deleted_at` is the live predicate every query filters on, and the progress
    // `status` is deliberately left where it was: a goal deleted after being
    // achieved still records that it was achieved (migration 212).
    // The same `end_date` rule the edit above applies: a removal ends the
    // assignment, and one that already ended (achieved in March, removed in
    // June) keeps the day it ended — the first end is the real one.
    const endDate = endDateTransition({
      nextLive: false,
      storedEndDate: toDateOnly(previous.end_date),
      today: utcToday(),
    });
    const updates = [
      'deleted_at = UTC_TIMESTAMP()',
      'deleted_by_name = ?', 'deleted_by_type = ?',
      'modified_at = UTC_TIMESTAMP()',
    ];
    const params: unknown[] = [actor.name, actor.type];
    if (endDate !== undefined) { updates.push('end_date = ?'); params.push(endDate); }
    params.push(id, gymId);

    await db.query(
      `UPDATE member_personal_goals SET ${updates.join(', ')} WHERE id = ? AND gym_id = ?`,
      params,
    );
    recordAudit(req, { action: 'delete', entityType: 'member_personal_goal', entityId: id, previous });
    res.status(204).send();
  } catch (err) { next(err); }
});

function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
