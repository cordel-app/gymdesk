import { db, Tx } from '../infra/db';
import { gymToday } from '../domain/workoutProgress';
import { previousDay, versionedTrainingPlanName } from '../domain/trainingPlanVersioning';
import { supersedeActivePlansTx } from './training-plan-creation';

/**
 * #3477: the one way a Draft Assigned Training Plan becomes Active. Both kinds of Draft go
 * through it:
 *
 * - a **version draft** (`draft_of_plan_id`, #1969): its source must still be active; the
 *   source is completed yesterday and renamed with its date range, the draft starts today
 *   with the `[today - Open End]` suffix (the rule `POST /publish-version` always had);
 * - a **plain draft** (Duplicate, #112): every active plan of the member is completed
 *   through #2573's `supersedeActivePlansTx()` (ends the day before the new start, never
 *   before its own start, history kept) and the draft starts on its own start date, or
 *   on the gym's today when that date has passed.
 *
 * - a **draft of a Completed plan** (#3547, `draft_of_plan_id` naming a `completed` plan):
 *   the Completed plan is history and is never touched; the draft is activated as a plain
 *   draft (it replaces the member's active plan) and loses its `draft_of_plan_id`.
 *
 * Either way it runs under the member-row lock, writes the `member_training_plans` row and
 * re-points `members.member_training_plan_id`, so no two plans are left active.
 */

export type ActivationResult = {
  previousIds: number[];
  previousName: string | null;
  startDate: string;
};

function isoDay(value: string | Date | null | undefined): string | null {
  if (value == null || value === '') return null;
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

export async function gymLocalToday(gymId: string): Promise<string> {
  const { rows } = await db.query('SELECT time_zone FROM gyms WHERE id = ?', [gymId]);
  return gymToday(new Date(), rows[0]?.time_zone ?? 'Europe/Madrid');
}

function fail(status: number, message: string, code?: string): never {
  throw Object.assign(new Error(message), { status, code });
}

export async function activateDraftTrainingPlanTx(
  tx: Tx, args: { gymId: string; memberId: string; planId: string; actor: string | null; today: string; versionOnly?: boolean },
): Promise<ActivationResult> {
  const { gymId, memberId, planId, actor, today } = args;
  await tx.query('SELECT id FROM members WHERE id = ? AND gym_id = ? FOR UPDATE', [memberId, gymId]);
  const { rows: draftRows } = await tx.query(
    `SELECT id, name, description, status, draft_of_plan_id, template_id, start_date, end_date
     FROM training_plans WHERE id = ? AND member_id = ? AND gym_id = ? FOR UPDATE`,
    [planId, memberId, gymId],
  );
  const draft = draftRows[0];
  if (!draft || draft.status === 'deleted') fail(404, 'Training plan not found');
  if (args.versionOnly && (draft.status !== 'draft' || !draft.draft_of_plan_id)) {
    fail(409, 'Only a draft created by editing a plan can be published');
  }
  if (draft.status !== 'draft') fail(409, 'Only a Draft training plan can be activated', 'not_draft');

  let orig: any = null;
  if (draft.draft_of_plan_id) {
    const { rows: origRows } = await tx.query(
      'SELECT id, name, status, start_date FROM training_plans WHERE id = ? AND member_id = ? AND gym_id = ? FOR UPDATE',
      [draft.draft_of_plan_id, memberId, gymId],
    );
    orig = origRows[0];
  }
  if (draft.draft_of_plan_id && orig?.status !== 'completed') {
    const yesterday = previousDay(today);
    if (!orig || orig.status !== 'active') fail(409, 'The plan this draft was created from is no longer active');
    const origStart = isoDay(orig.start_date) as string;
    const previousName = versionedTrainingPlanName(orig.name, origStart, yesterday);
    await tx.query(
      `UPDATE training_plans SET status = 'completed', end_date = ?, name = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
       WHERE id = ? AND gym_id = ?`,
      [yesterday, previousName, actor, orig.id, gymId],
    );
    await tx.query(
      "UPDATE member_training_plans SET status = 'completed', valid_to = ? WHERE training_plan_id = ? AND gym_id = ? AND status = 'active'",
      [yesterday, orig.id, gymId],
    );
    const newName = versionedTrainingPlanName(draft.name, today, null);
    await tx.query(
      `UPDATE training_plans SET status = 'active', start_date = ?, end_date = NULL, draft_of_plan_id = NULL, name = ?,
              modified_at = UTC_TIMESTAMP(), modified_by = ?
       WHERE id = ? AND gym_id = ?`,
      [today, newName, actor, draft.id, gymId],
    );
    await insertAssignmentTx(tx, gymId, memberId, draft.id, draft.template_id, newName, draft.description, today, null, actor);
    return { previousIds: [orig.id], previousName, startDate: today };
  }

  const ownStart = isoDay(draft.start_date);
  const startDate = ownStart && ownStart > today ? ownStart : today;
  const endDate = isoDay(draft.end_date);
  if (endDate && endDate < startDate) fail(400, 'End Date cannot be before the start date the plan is activated on', 'end_before_start');

  const { rows: activeRows } = await tx.query(
    "SELECT id, name FROM training_plans WHERE member_id = ? AND gym_id = ? AND status = 'active' ORDER BY id",
    [memberId, gymId],
  );
  const previousIds = await supersedeActivePlansTx(tx, gymId, memberId, actor, startDate, true);
  await tx.query(
    `UPDATE training_plans SET status = 'active', start_date = ?, draft_of_plan_id = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [startDate, actor, draft.id, gymId],
  );
  await insertAssignmentTx(tx, gymId, memberId, draft.id, draft.template_id, draft.name, draft.description, startDate, endDate, actor);
  return { previousIds, previousName: activeRows[0]?.name ?? null, startDate };
}

async function insertAssignmentTx(
  tx: Tx, gymId: string, memberId: string, planId: number, templateId: number | null, name: string,
  description: string | null, validFrom: string, validTo: string | null, actor: string | null,
): Promise<void> {
  const { insertId: mtpId } = await tx.query(
    `INSERT INTO member_training_plans
      (gym_id, member_id, training_plan_id, template_id, name, description, status, valid_from, valid_to, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [gymId, memberId, planId, templateId ?? null, name, description, validFrom, validTo, actor],
  );
  await tx.query('UPDATE members SET member_training_plan_id = ? WHERE id = ? AND gym_id = ?', [mtpId, memberId, gymId]);
}

/**
 * #3477: what activating a Draft would do, for the confirmation: the plan it completes (a version
 * draft's source, else the member's active plan) and the day it would start. Reads only.
 */
export async function loadActivationPreview(
  gymId: string, memberId: string, planId: string, today: string,
): Promise<{ current_plan: { id: number; name: string } | null; start_date: string; version_draft: boolean } | null> {
  const { rows } = await db.query(
    "SELECT id, status, draft_of_plan_id, start_date FROM training_plans WHERE id = ? AND member_id = ? AND gym_id = ? AND status != 'deleted'",
    [planId, memberId, gymId],
  );
  const plan = rows[0];
  if (!plan) return null;
  if (plan.status !== 'draft') fail(409, 'Only a Draft training plan can be activated', 'not_draft');
  // #3547: a draft of a Completed plan is previewed as a plain draft (it replaces the active plan).
  const { rows: src } = plan.draft_of_plan_id
    ? await db.query('SELECT status FROM training_plans WHERE id = ? AND gym_id = ?', [plan.draft_of_plan_id, gymId])
    : { rows: [] as any[] };
  const versionDraft = !!plan.draft_of_plan_id && src[0]?.status !== 'completed';
  const { rows: current } = versionDraft
    ? await db.query("SELECT id, name FROM training_plans WHERE id = ? AND gym_id = ? AND status = 'active'", [plan.draft_of_plan_id, gymId])
    : await db.query(
      "SELECT id, name FROM training_plans WHERE member_id = ? AND gym_id = ? AND status = 'active' AND id != ? ORDER BY id LIMIT 1",
      [memberId, gymId, planId],
    );
  const ownStart = isoDay(plan.start_date);
  const start = versionDraft ? today : (ownStart && ownStart > today ? ownStart : today);
  return { current_plan: current[0] ? { id: current[0].id, name: current[0].name } : null, start_date: start, version_draft: versionDraft };
}
