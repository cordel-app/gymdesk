import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { requireFeatureEnabled } from '../infra/featureFlags';
import { handleDupEntry } from '../infra/db-helpers';
import { GOAL_LIBRARY_FEATURE_KEYS } from '../domain/goalLibrary';
import { resolveMemberId } from './me';
import {
  endDateTransition,
  goalAssignmentFieldError,
  memberActorSnapshot,
  normalizeGoalDate,
  normalizeNotes,
  normalizeTargetUnit,
  normalizeTargetValue,
  toDateOnly,
  utcToday,
} from '../domain/personalGoalAssignment';

/**
 * #1036 — **My Goals**: the Personal Goals a member manages for themselves.
 *
 * The model is not this ticket's: `member_personal_goals` (migration 212, #948
 * §4) is the one assignment table, and every rule about what a valid target,
 * date or note is comes from `api/src/domain/personalGoalAssignment.ts`, which
 * the staff router reads too — the two surfaces cannot disagree about what the
 * member is allowed to type, because neither restates it.
 *
 * Four properties are the ticket's rather than this file's:
 *
 * * **The member is never named by the request** (§15, §18). Every route
 *   resolves the caller through `resolveMemberId()` and constrains the row on
 *   `(gym_id, member_id)`, so another member's assignment is a 404 whatever the
 *   URL or the payload says. There is no `member_id` field on any body here.
 * * **A member cannot create a Goal definition** (§4, §6, §16). Nothing in this
 *   router writes `personal_goals`; the selector is a read of the catalogue
 *   under its own gym-facing predicate, and an id outside it is a 404.
 * * **The snapshot is the server's** (§8, #1034 §7). `POST` reads the catalogue
 *   row it has already validated and writes its `name` — and, for a field the
 *   request did not mention, its target — onto the assignment, so a later
 *   rename or re-targeting of the Gym Goal moves nothing the member already
 *   holds. It is the same inheritance `POST /member-personal-goals` applies,
 *   for the same reason.
 * * **Progress is not the member's to set** (§14). `status` is a staff field
 *   (`in_progress` · `achieved` · `abandoned`) and no route here accepts it:
 *   a member ends a goal by removing it, which is what §11 asks for, and
 *   inventing a member-facing progress vocabulary is what §14 rules out.
 *
 * Mounted behind **both** feature flags — `member_web.my_goals` for the section
 * and the catalogue's own `nutrition.personal_goals` — because a gym that hid
 * Personal Goals did not mean "and let members assign them anyway".
 */
export const mePersonalGoalsRouter = Router();

mePersonalGoalsRouter.use(
  requireRole('member'),
  requireFeatureEnabled(GOAL_LIBRARY_FEATURE_KEYS.personal),
  requireFeatureEnabled('member_web.my_goals'),
);

/**
 * What the member is shown for one assignment.
 *
 * `goal_name` is the **snapshot** taken when it was created (migration 218),
 * with the catalogue's current name as the one fallback for a row assigned
 * before that column existed — the staff router's own `COALESCE`, word for
 * word, so the two screens cannot name the same assignment differently.
 *
 * `goal_slug` travels with it because a seeded System goal is shown under its
 * `goals.goal_<slug>` locale key with the stored name as the fallback: the
 * label is the viewer's language, not the row's, so it cannot be resolved here.
 *
 * The actor pair is deliberately **not** projected: who recorded a goal is an
 * administrative fact, and the member's own screen shows the goal.
 */
const COLUMNS = `
  mpg.id, mpg.personal_goal_id,
  mpg.target_value, mpg.target_unit,
  mpg.start_date, mpg.target_date, mpg.end_date,
  mpg.status, mpg.notes, mpg.created_at, mpg.deleted_at,
  COALESCE(mpg.goal_name, pg.name) AS goal_name,
  pg.slug AS goal_slug
`;

const FROM = `
  FROM member_personal_goals mpg
  JOIN personal_goals pg ON pg.id = mpg.personal_goal_id
                        AND (pg.gym_id IS NULL OR pg.gym_id = mpg.gym_id)
`;

/** mysql2 hands a DECIMAL back as a string; every number this API reports is a number. */
function shape(row: any) {
  return {
    ...row,
    target_value: row.target_value === null || row.target_value === undefined ? null : Number(row.target_value),
    start_date: toDateOnly(row.start_date),
    target_date: toDateOnly(row.target_date),
    end_date: toDateOnly(row.end_date),
  };
}

async function loadOwn(id: unknown, gymId: string, memberId: number) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM} WHERE mpg.id = ? AND mpg.gym_id = ? AND mpg.member_id = ?`,
    [id, gymId, memberId],
  );
  return rows[0] ? shape(rows[0]) : undefined;
}

/* ── The member's goals ───────────────────────────────────────────────────── */

/**
 * §3 and `Q4`'s Past Goals in one read, because they are one list split on one
 * predicate — a second endpoint would be a second place deciding which goals
 * are still being pursued.
 *
 * **Live** is `deleted_at IS NULL AND status = 'in_progress'`, the predicate
 * migration 212's unique key is generated from, so what the page lists as
 * current is exactly what the database refuses a second copy of. Everything
 * else the member has ever held — removed, achieved or abandoned — is a Past
 * Goal, newest first.
 */
mePersonalGoalsRouter.get('/', async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    let memberId: number;
    try { memberId = await resolveMemberId(gymId, ctx); } catch { return res.json({ goals: [], past_goals: [] }); }

    const { rows } = await db.query(
      `SELECT ${COLUMNS} ${FROM}
       WHERE mpg.gym_id = ? AND mpg.member_id = ?
       ORDER BY mpg.created_at DESC, mpg.id DESC`,
      [gymId, memberId],
    );
    const all = rows.map(shape);
    res.json({
      goals: all.filter((r: any) => r.deleted_at === null && r.status === 'in_progress'),
      past_goals: all.filter((r: any) => !(r.deleted_at === null && r.status === 'in_progress')),
    });
  } catch (err) { next(err); }
});

/**
 * §5–§7 — the goals the member may still add.
 *
 * The exclusions are the thread's `Q3` answer, "inactive ones and also Q3
 * live": a goal the catalogue has retired (`status = 'deleted'`) and a goal the
 * member already holds live are both left out, and nothing else is. A goal they
 * removed or finished is offered again (§12), which is what makes the selector
 * agree with the server by construction rather than by being stricter than it.
 *
 * Registered **before** `/:id`, or Express reads `available` as an id.
 */
mePersonalGoalsRouter.get('/available', async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    let memberId: number;
    try { memberId = await resolveMemberId(gymId, ctx); } catch { return res.json({ goals: [] }); }

    // The catalogue's own gym-facing rule: a System row (`gym_id IS NULL`) is
    // assignable by every gym, this gym's own are, another gym's are invisible.
    const { rows } = await db.query(
      `SELECT pg.id, pg.slug, pg.name, pg.description, pg.target_value, pg.target_unit
       FROM personal_goals pg
       WHERE (pg.gym_id IS NULL OR pg.gym_id = ?)
         AND pg.status != 'deleted'
         AND NOT EXISTS (
           SELECT 1 FROM member_personal_goals mpg
           WHERE mpg.personal_goal_id = pg.id AND mpg.member_id = ? AND mpg.gym_id = ?
             AND mpg.deleted_at IS NULL AND mpg.status = 'in_progress'
         )
       ORDER BY pg.name ASC, pg.id ASC`,
      [gymId, memberId, gymId],
    );
    res.json({
      goals: rows.map((row: any) => ({
        ...row,
        target_value: row.target_value === null || row.target_value === undefined ? null : Number(row.target_value),
      })),
    });
  } catch (err) { next(err); }
});

/* ── Assign one to myself ─────────────────────────────────────────────────── */

mePersonalGoalsRouter.post('/', async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId, actorName, isSuperadmin } = ctx;

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

  const actor = memberActorSnapshot({ name: actorName, isSuperadmin });

  try {
    const memberId = await resolveMemberId(gymId, ctx);

    const { rows: goalRows } = await db.query(
      `SELECT id, name, target_value, target_unit FROM personal_goals
       WHERE id = ? AND (gym_id IS NULL OR gym_id = ?) AND status != 'deleted'`,
      [goalId, gymId],
    );
    if (goalRows.length === 0) return res.status(404).json({ error: 'Personal goal not found' });

    // #1034 §7 — the snapshot is the server's: a field the request does not
    // mention inherits the Gym Goal as it stands now, an explicit `null` is
    // still a clear, and a submitted value is the per-member override §9 is
    // about. The unit only inherits while the effective value is non-null,
    // because `chk_mpgoal_target_unit` refuses a unit qualifying nothing.
    const catalogue: any = goalRows[0];
    const effectiveValue = targetValue.value === undefined
      ? (catalogue.target_value === null || catalogue.target_value === undefined ? null : Number(catalogue.target_value))
      : targetValue.value;
    const effectiveUnit = targetUnit.value === undefined
      ? (effectiveValue === null ? null : (catalogue.target_unit ?? null))
      : targetUnit.value;

    const fieldError = goalAssignmentFieldError({
      targetValue: effectiveValue,
      targetUnit: effectiveUnit,
      startDate: startDate.value ?? null,
      targetDate: targetDate.value ?? null,
    });
    if (fieldError) return res.status(400).json({ error: fieldError });

    // `status` takes the column's own default (`in_progress`) and is not
    // accepted from the member (§14), and `end_date` stays NULL because the
    // assignment is live the moment it is created.
    const { insertId } = await db.query(
      `INSERT INTO member_personal_goals
         (gym_id, member_id, personal_goal_id, goal_name, target_value, target_unit,
          start_date, target_date, notes, created_by_name, created_by_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gymId, memberId, goalId, catalogue.name,
        effectiveValue, effectiveUnit,
        startDate.value ?? null, targetDate.value ?? null,
        notes.value ?? null, actor.name, actor.type,
      ],
    );

    res.status(201).json(await loadOwn(insertId, gymId, memberId));
  } catch (err) {
    // `mpgoal_live_goal_key` is the §7 rule in the database: one live,
    // in-progress assignment per (member, goal). The selector already hides it,
    // so this is the backend half §7 asks for rather than a duplicate of it.
    handleDupEntry(err, res, next, 'This goal is already in your goals');
  }
});

/* ── Edit my own ──────────────────────────────────────────────────────────── */

/**
 * §9 — the member edits **their** target, never the Gym Goal: this route writes
 * `member_personal_goals` and nothing else, so the catalogue row the assignment
 * was taken from is untouched whatever is submitted.
 *
 * Partial, like the staff `PUT`: a field the body does not mention keeps what
 * it is stored with, and an explicit `null` clears it. `personal_goal_id` is
 * immutable here as it is there — re-pointing an assignment is a remove plus an
 * add, which is also §12's own answer.
 */
mePersonalGoalsRouter.put('/:id', async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId, actorName, isSuperadmin } = ctx;
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

  const actor = memberActorSnapshot({ name: actorName, isSuperadmin });

  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const previous = await loadOwn(id, gymId, memberId);
    if (!previous || previous.deleted_at !== null) {
      return res.status(404).json({ error: 'Goal not found' });
    }

    // Checked against the row the write produces, not against the body:
    // clearing `target_value` while a stored `target_unit` stays behind is the
    // case a per-field check misses, and the CHECK would answer it as a driver
    // error the global handler turns into a bare 500 (#966).
    const fieldError = goalAssignmentFieldError({
      targetValue: targetValue.value === undefined ? previous.target_value : targetValue.value,
      targetUnit: targetUnit.value === undefined ? previous.target_unit : targetUnit.value,
      startDate: startDate.value === undefined ? previous.start_date : startDate.value,
      targetDate: targetDate.value === undefined ? previous.target_date : targetDate.value,
    });
    if (fieldError) return res.status(400).json({ error: fieldError });

    const updates = ['modified_at = UTC_TIMESTAMP()', 'modified_by_name = ?', 'modified_by_type = ?'];
    const params: unknown[] = [actor.name, actor.type];
    if (targetValue.value !== undefined) { updates.push('target_value = ?'); params.push(targetValue.value); }
    if (targetUnit.value !== undefined) { updates.push('target_unit = ?'); params.push(targetUnit.value); }
    if (startDate.value !== undefined) { updates.push('start_date = ?'); params.push(startDate.value); }
    if (targetDate.value !== undefined) { updates.push('target_date = ?'); params.push(targetDate.value); }
    if (notes.value !== undefined) { updates.push('notes = ?'); params.push(notes.value); }
    params.push(id, gymId, memberId);

    await db.query(
      `UPDATE member_personal_goals SET ${updates.join(', ')}
       WHERE id = ? AND gym_id = ? AND member_id = ?`,
      params,
    );

    res.json(await loadOwn(id, gymId, memberId));
  } catch (err) { next(err); }
});

/* ── Remove my own ────────────────────────────────────────────────────────── */

/**
 * §11/§12 — removing an assignment, which is a soft delete and nothing else:
 * the Gym Goal it names is never touched, so it stays in the catalogue and
 * comes back in the selector, and assigning it again creates a **new** row with
 * its own snapshot rather than resurrecting this one (the thread's `Q4`: "a
 * brand new one will be created").
 *
 * The progress `status` is deliberately left where it was (migration 212): a
 * goal removed after being achieved still records that it was achieved. What
 * the removal adds is `end_date`, through the one helper that decides it.
 */
mePersonalGoalsRouter.delete('/:id', async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId, actorName, isSuperadmin } = ctx;
  const { id } = req.params;
  const actor = memberActorSnapshot({ name: actorName, isSuperadmin });

  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const previous = await loadOwn(id, gymId, memberId);
    if (!previous) return res.status(404).json({ error: 'Goal not found' });
    if (previous.deleted_at !== null) return res.status(409).json({ error: 'Goal is already removed' });

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
    params.push(id, gymId, memberId);

    await db.query(
      `UPDATE member_personal_goals SET ${updates.join(', ')}
       WHERE id = ? AND gym_id = ? AND member_id = ?`,
      params,
    );
    res.status(204).send();
  } catch (err) { next(err); }
});
