import { Tx } from '../infra/db';

/**
 * #67: the create-personalized-plan transaction, extracted from
 * member-training-plans.ts so the gym-level /training-plans endpoint and the
 * member-scoped assignment endpoint share one implementation. Clones the full
 * template hierarchy (template_id given) or creates an empty plan (template_id
 * null), writes the member_training_plans history row, and repoints
 * members.member_training_plan_id at the newest assignment. Runs inside the
 * caller's transaction so callers can compose it (e.g. expire-existing-plans
 * first, then create).
 */

export type CreateTrainingPlanArgs = {
  gymId: string;
  memberId: string | number;
  gymMembershipId: number | null;
  /** #1182: the plain-text actor snapshot written to `created_by` (`resolveRequestActor()`). */
  actor: string | null;
  templateId: number | null;
  name: string | null; // required by callers when templateId is null
  description: string | null | undefined; // undefined/null -> inherit template's when cloning
  startDate: string | null; // YYYY-MM-DD; null -> today (also used as the assignment's valid_from)
  validTo: string | null;
  /** #2573: true once staff confirmed that an existing active plan is superseded. */
  confirmReplace?: boolean;
};

export type CreateTrainingPlanResult = { planId: number; mtpId: number; planName: string };

/**
 * #2573: a Member holds at most one active Assigned Training Plan. Locks the member row (so two
 * concurrent assignments serialise), then either refuses with `409 active_plan_exists`
 * (no confirmation) or completes the active plan(s): `end_date` = the day before the new start
 * (never before the plan's own start), history kept. Runs in the caller's transaction.
 */
export async function supersedeActivePlansTx(
  tx: Tx, gymId: string, memberId: string | number, actor: string | null, startDate: string | null, confirm: boolean,
): Promise<number[]> {
  await tx.query('SELECT id FROM members WHERE id = ? AND gym_id = ? FOR UPDATE', [memberId, gymId]);
  const { rows } = await tx.query(
    "SELECT id, name FROM training_plans WHERE member_id = ? AND gym_id = ? AND status = 'active' ORDER BY id FOR UPDATE",
    [memberId, gymId],
  );
  if (rows.length === 0) return [];
  if (!confirm) {
    throw Object.assign(new Error('Member already has an active training plan'), {
      status: 409, code: 'active_plan_exists', current_plan: { id: rows[0].id, name: rows[0].name },
    });
  }
  const ids = rows.map((r: any) => r.id);
  const marks = ids.map(() => '?').join(',');
  await tx.query(
    `UPDATE training_plans SET status = 'completed',
            end_date = GREATEST(start_date, DATE_SUB(COALESCE(?, CURRENT_DATE()), INTERVAL 1 DAY)),
            modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id IN (${marks}) AND gym_id = ?`,
    [startDate, actor, ...ids, gymId],
  );
  await tx.query(
    `UPDATE member_training_plans SET status = 'completed',
            valid_to = DATE_SUB(COALESCE(?, CURRENT_DATE()), INTERVAL 1 DAY),
            modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE training_plan_id IN (${marks}) AND gym_id = ? AND status = 'active'`,
    [startDate, actor, ...ids, gymId],
  );
  return ids;
}

export async function createTrainingPlanTx(tx: Tx, args: CreateTrainingPlanArgs): Promise<CreateTrainingPlanResult & { supersededIds: number[] }> {
  const { gymId, memberId, gymMembershipId, actor, templateId, name, description, startDate, validTo } = args;
  const supersededIds = await supersedeActivePlansTx(tx, gymId, memberId, actor, startDate, args.confirmReplace === true);
  let planId: number;
  let planName: string;
  let planDescription: string | null;

  if (templateId) {
    const { rows: tplRows } = await tx.query(
      "SELECT * FROM training_plan_templates WHERE id = ? AND (gym_id IS NULL OR gym_id = ?) AND status = 'active'",
      [templateId, gymId],
    );
    if (tplRows.length === 0) {
      throw Object.assign(new Error('Template not found or not active'), { status: 400 });
    }
    const template = tplRows[0];
    planName = name?.trim() || template.name;
    planDescription = description ?? template.description;

    const { insertId: newPlanId } = await tx.query(
      `INSERT INTO training_plans
        (gym_id, member_id, template_id, name, description, status, start_date, created_by)
       VALUES (?, ?, ?, ?, ?, 'active', COALESCE(?, CURRENT_DATE()), ?)`,
      [gymId, memberId, templateId, planName, planDescription, startDate, actor],
    );
    planId = newPlanId;

    const { rows: junctionRows } = await tx.query(
      `SELECT j.*, wt.name AS workout_template_name, wt.description AS workout_template_description
       FROM training_plan_template_workouts j JOIN workout_templates wt ON wt.id = j.workout_template_id
       WHERE j.training_plan_template_id = ? ORDER BY j.position ASC`,
      [templateId],
    );
    for (const junction of junctionRows) {
      const { insertId: workoutId } = await tx.query(
        'INSERT INTO workouts (gym_id, training_plan_id, name, description, position, scheduled_weekday) VALUES (?, ?, ?, ?, ?, ?)',
        [gymId, planId, junction.workout_template_name, junction.workout_template_description, junction.position, junction.scheduled_weekday],
      );
      const { rows: blockRows } = await tx.query(
        'SELECT * FROM workout_template_blocks WHERE workout_template_id = ? AND deleted_at IS NULL ORDER BY position ASC',
        [junction.workout_template_id],
      );
      for (const block of blockRows) {
        const { insertId: blockId } = await tx.query(
          `INSERT INTO workout_blocks
            (gym_id, workout_id, position, name, description, type,
             rounds, duration_seconds, work_seconds, rest_seconds, is_optional, notes, result_unit, modified_by_membership_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [gymId, workoutId, block.position, block.name, block.description, block.type,
           block.rounds, block.duration_seconds, block.work_seconds, block.rest_seconds, block.is_optional, block.notes, block.result_unit ?? null,
           gymMembershipId],
        );
        const { rows: exRows } = await tx.query(
          'SELECT * FROM workout_template_exercises WHERE workout_template_block_id = ? AND deleted_at IS NULL ORDER BY position ASC',
          [block.id],
        );
        for (const ex of exRows) {
          await tx.query(
            `INSERT INTO workout_exercises
              (gym_id, workout_block_id, exercise_id, base_exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo,
               result_type_id, target_value, min_value, max_value, unit, modified_by_membership_id)
             VALUES (?, ?, (SELECT id FROM exercises WHERE id = ? AND gym_id IS NOT NULL), (SELECT id FROM base_exercises WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [gymId, blockId, ex.exercise_id ?? null, ex.base_exercise_id ?? null, ex.position, ex.min_reps, ex.max_reps, ex.sets, ex.rest_seconds, ex.tempo,
             ex.result_type_id ?? null, ex.target_value ?? null, ex.min_value ?? null, ex.max_value ?? null, ex.unit ?? null,
             gymMembershipId],
          );
        }
      }
    }
  } else {
    planName = (name ?? '').trim();
    planDescription = description ?? null;
    const { insertId: newPlanId } = await tx.query(
      `INSERT INTO training_plans
        (gym_id, member_id, template_id, name, description, status, start_date, created_by)
       VALUES (?, ?, NULL, ?, ?, 'active', COALESCE(?, CURRENT_DATE()), ?)`,
      [gymId, memberId, planName, planDescription, startDate, actor],
    );
    planId = newPlanId;
  }

  const { insertId: mtpId } = await tx.query(
    `INSERT INTO member_training_plans
      (gym_id, member_id, training_plan_id, template_id, name, description, status, valid_from, valid_to, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'active', COALESCE(?, CURRENT_DATE()), ?, ?)`,
    [gymId, memberId, planId, templateId ?? null, planName, planDescription, startDate, validTo ?? null, actor],
  );

  await tx.query('UPDATE members SET member_training_plan_id = ? WHERE id = ? AND gym_id = ?', [mtpId, memberId, gymId]);

  return { planId, mtpId, planName, supersededIds };
}
