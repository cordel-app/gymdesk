import { Tx } from '../infra/db';
import { nextDay, versionedNutritionPlanName } from '../domain/nutritionPlanVersioning';

/**
 * #3474: activating a Draft assigned Nutrition Plan — the one place it happens, for the
 * explicit `⋮ → Activate`, the "Activate" answer to Save on a Draft and #1970's
 * `publish-version` alike. A member holds one active Nutrition Plan (#2572), so the
 * member's current active plan(s) are completed in the same transaction that activates
 * the Draft, ending the day before it starts so the periods never overlap. Nothing is
 * deleted or overwritten: the previous plan keeps its content and history.
 *
 * - A version Draft (#1970, `draft_of_plan_id`) keeps its rules: the plan it was created
 *   from must still be active, is renamed with its date range, and the Draft starts tomorrow.
 * - Any active plan is completed with `end_date` today (never before its own start) and the
 *   Draft starts the day after the latest such end date.
 * - With no active plan the Draft starts on its own start date, or today if that is past.
 */

export type ActivationResult = {
  previousPlans: { id: number; name: string }[];
  startDate: string;
};

const dateOnly = (v: any): string | null =>
  v == null ? null : (typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10));

function httpError(status: number, message: string, code?: string) {
  return Object.assign(new Error(message), { status, body: code ? { error: message, code } : { error: message } });
}

/** The member's current active plan(s) a Draft's activation would complete (the confirmation's subject). */
export async function activePlansReplacedBy(
  exec: { query: Tx['query'] }, gymId: string, draftId: number | string,
): Promise<{ draft: any; current: { id: number; name: string }[] } | null> {
  const { rows } = await exec.query(
    "SELECT id, member_id, name, status, draft_of_plan_id FROM member_nutrition_plans WHERE id = ? AND gym_id = ? AND status != 'deleted'",
    [draftId, gymId],
  );
  if (!rows[0]) return null;
  const { rows: active } = await exec.query(
    "SELECT id, name FROM member_nutrition_plans WHERE gym_id = ? AND member_id = ? AND status = 'active' AND id != ? ORDER BY start_date ASC, id ASC",
    [gymId, rows[0].member_id, draftId],
  );
  return { draft: rows[0], current: active.map((p: any) => ({ id: Number(p.id), name: p.name })) };
}

export async function activateDraftNutritionPlanTx(
  tx: Tx, args: { gymId: string; draftId: number | string; actor: string | null; today: string },
): Promise<ActivationResult> {
  const { gymId, draftId, actor, today } = args;
  const { rows: draftRows } = await tx.query(
    'SELECT id, member_id, name, status, start_date, draft_of_plan_id FROM member_nutrition_plans WHERE id = ? AND gym_id = ? FOR UPDATE',
    [draftId, gymId],
  );
  const draft = draftRows[0];
  if (!draft || draft.status === 'deleted') throw httpError(404, 'Member nutrition plan not found');
  if (draft.status !== 'draft') throw httpError(409, 'Only a draft nutrition plan can be activated', 'not_a_draft');

  // The member row is the lock every one-active-plan writer takes (supersedeActiveNutritionPlans).
  await tx.query('SELECT id FROM members WHERE id = ? AND gym_id = ? FOR UPDATE', [draft.member_id, gymId]);
  const { rows: active } = await tx.query(
    "SELECT id, name, start_date FROM member_nutrition_plans WHERE gym_id = ? AND member_id = ? AND status = 'active' AND id != ? FOR UPDATE",
    [gymId, draft.member_id, draft.id],
  );

  if (draft.draft_of_plan_id && !active.some((p: any) => Number(p.id) === Number(draft.draft_of_plan_id))) {
    throw httpError(409, 'The plan this draft was created from is no longer active', 'source_not_active');
  }

  const previousPlans: { id: number; name: string }[] = [];
  let latestEnd: string | null = null;
  for (const plan of active) {
    const start = dateOnly(plan.start_date);
    const end = start && start > today ? start : today;
    const isSource = Number(plan.id) === Number(draft.draft_of_plan_id);
    const name = isSource ? versionedNutritionPlanName(plan.name, start ?? today, end) : plan.name;
    await tx.query(
      `UPDATE member_nutrition_plans SET status = 'completed', end_date = ?, name = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
       WHERE id = ? AND gym_id = ?`,
      [end, name, actor, plan.id, gymId],
    );
    previousPlans.push({ id: Number(plan.id), name });
    if (latestEnd === null || end > latestEnd) latestEnd = end;
  }

  const ownStart = dateOnly(draft.start_date);
  const startDate = latestEnd !== null ? nextDay(latestEnd) : (ownStart && ownStart > today ? ownStart : today);
  const name = draft.draft_of_plan_id ? versionedNutritionPlanName(draft.name, startDate, null) : draft.name;
  await tx.query(
    `UPDATE member_nutrition_plans SET status = 'active', start_date = ?, end_date = NULL, draft_of_plan_id = NULL, name = ?,
            modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [startDate, name, actor, draft.id, gymId],
  );
  return { previousPlans, startDate };
}
