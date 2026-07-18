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
  templateId: number | null;
  name: string | null; // required by callers when templateId is null
  description: string | null | undefined; // undefined/null -> inherit template's when cloning
  startDate: string | null; // YYYY-MM-DD; null -> today (also used as the assignment's valid_from)
  validTo: string | null;
};

export type CreateTrainingPlanResult = { planId: number; mtpId: number; planName: string };

export async function createTrainingPlanTx(tx: Tx, args: CreateTrainingPlanArgs): Promise<CreateTrainingPlanResult> {
  const { gymId, memberId, gymMembershipId, templateId, name, description, startDate, validTo } = args;
  let planId: number;
  let planName: string;
  let planDescription: string | null;

  if (templateId) {
    const { rows: tplRows } = await tx.query(
      "SELECT * FROM training_plan_templates WHERE id = ? AND gym_id = ? AND status = 'active'",
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
        (gym_id, member_id, template_id, name, description, status, start_date, assigned_by_membership_id)
       VALUES (?, ?, ?, ?, ?, 'active', COALESCE(?, CURRENT_DATE()), ?)`,
      [gymId, memberId, templateId, planName, planDescription, startDate, gymMembershipId],
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
            (gym_id, workout_id, position, name, description, type, result_type,
             rounds, duration_seconds, work_seconds, rest_seconds, is_optional, notes, modified_by_membership_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [gymId, workoutId, block.position, block.name, block.description, block.type, block.result_type,
           block.rounds, block.duration_seconds, block.work_seconds, block.rest_seconds, block.is_optional, block.notes,
           gymMembershipId],
        );
        const { rows: exRows } = await tx.query(
          'SELECT * FROM workout_template_exercises WHERE workout_template_block_id = ? AND deleted_at IS NULL ORDER BY position ASC',
          [block.id],
        );
        for (const ex of exRows) {
          await tx.query(
            `INSERT INTO workout_exercises
              (gym_id, workout_block_id, exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo, modified_by_membership_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [gymId, blockId, ex.exercise_id, ex.position, ex.min_reps, ex.max_reps, ex.sets, ex.rest_seconds, ex.tempo, gymMembershipId],
          );
        }
      }
    }
  } else {
    planName = (name ?? '').trim();
    planDescription = description ?? null;
    const { insertId: newPlanId } = await tx.query(
      `INSERT INTO training_plans
        (gym_id, member_id, template_id, name, description, status, start_date, assigned_by_membership_id)
       VALUES (?, ?, NULL, ?, ?, 'active', COALESCE(?, CURRENT_DATE()), ?)`,
      [gymId, memberId, planName, planDescription, startDate, gymMembershipId],
    );
    planId = newPlanId;
  }

  const { insertId: mtpId } = await tx.query(
    `INSERT INTO member_training_plans
      (gym_id, member_id, training_plan_id, template_id, name, description, status, valid_from, valid_to, assigned_by_membership_id)
     VALUES (?, ?, ?, ?, ?, ?, 'active', COALESCE(?, CURRENT_DATE()), ?, ?)`,
    [gymId, memberId, planId, templateId ?? null, planName, planDescription, startDate, validTo ?? null, gymMembershipId],
  );

  await tx.query('UPDATE members SET member_training_plan_id = ? WHERE id = ? AND gym_id = ?', [mtpId, memberId, gymId]);

  return { planId, mtpId, planName };
}
