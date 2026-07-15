import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

/**
 * #55: MemberTrainingPlan — assignment history (never overwritten) + the
 * clone-on-assign transaction. Mounted at /members/:memberId/member-training-plans
 * (mergeParams: true).
 *
 * A trainer either clones a TrainingPlanTemplate fresh for this member
 * (template_id given) or creates a blank ad-hoc TrainingPlan (template_id
 * omitted) to be built out afterward via training-plans.ts. Per ticket
 * clarification a member can have several active plans at once, so there is
 * no conflict/409 handling here on assign. ValidFrom/ValidTo are system-
 * managed on status transitions, never client-supplied.
 */

export const memberTrainingPlansRouter = Router({ mergeParams: true });

const MTP_STATUSES = ['active', 'completed', 'cancelled'];

async function memberExists(memberId: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL', [memberId, gymId]);
  return rows.length > 0;
}

memberTrainingPlansRouter.get('/', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { memberId } = req.params as { memberId: string };
  try {
    const { rows } = await db.query(
      `SELECT mtp.*, tp.name AS training_plan_name, tp.status AS training_plan_status
       FROM member_training_plans mtp JOIN training_plans tp ON tp.id = mtp.training_plan_id
       WHERE mtp.member_id = ? AND mtp.gym_id = ? ORDER BY mtp.created_at DESC`,
      [memberId, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

memberTrainingPlansRouter.post('/', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { memberId } = req.params as { memberId: string };
  const { template_id, name, description, valid_to } = req.body;

  if (!(await memberExists(memberId, gymId))) return res.status(404).json({ error: 'Member not found' });

  if (!template_id && !name?.trim()) {
    return res.status(400).json({ error: 'name is required when creating a plan from scratch (no template_id)' });
  }

  try {
    const result = await db.transaction(async (tx) => {
      let planId: number;
      let planName: string;
      let planDescription: string | null;

      if (template_id) {
        const { rows: tplRows } = await tx.query(
          "SELECT * FROM training_plan_templates WHERE id = ? AND gym_id = ? AND status = 'active'",
          [template_id, gymId],
        );
        if (tplRows.length === 0) {
          throw Object.assign(new Error('Template not found or not active'), { status: 400 });
        }
        const template = tplRows[0];
        planName = name?.trim() || template.name;
        planDescription = description ?? template.description;

        const { insertId: newPlanId } = await tx.query(
          `INSERT INTO training_plans (gym_id, member_id, template_id, name, description, status, assigned_by_membership_id)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`,
          [gymId, memberId, template_id, planName, planDescription, gymMembershipId],
        );
        planId = newPlanId;

        const { rows: junctionRows } = await tx.query(
          `SELECT j.*, wt.name AS workout_template_name, wt.description AS workout_template_description
           FROM training_plan_template_workouts j JOIN workout_templates wt ON wt.id = j.workout_template_id
           WHERE j.training_plan_template_id = ? ORDER BY j.position ASC`,
          [template_id],
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
        planName = name.trim();
        planDescription = description ?? null;
        const { insertId: newPlanId } = await tx.query(
          `INSERT INTO training_plans (gym_id, member_id, template_id, name, description, status, assigned_by_membership_id)
           VALUES (?, ?, NULL, ?, ?, 'active', ?)`,
          [gymId, memberId, planName, planDescription, gymMembershipId],
        );
        planId = newPlanId;
      }

      const { insertId: mtpId } = await tx.query(
        `INSERT INTO member_training_plans
          (gym_id, member_id, training_plan_id, template_id, name, description, status, valid_from, valid_to, assigned_by_membership_id)
         VALUES (?, ?, ?, ?, ?, ?, 'active', CURRENT_DATE(), ?, ?)`,
        [gymId, memberId, planId, template_id ?? null, planName, planDescription, valid_to ?? null, gymMembershipId],
      );

      await tx.query('UPDATE members SET member_training_plan_id = ? WHERE id = ? AND gym_id = ?', [mtpId, memberId, gymId]);

      return { mtpId, planId };
    });

    const { rows } = await db.query(
      `SELECT mtp.*, tp.name AS training_plan_name FROM member_training_plans mtp
       JOIN training_plans tp ON tp.id = mtp.training_plan_id WHERE mtp.id = ?`,
      [result.mtpId],
    );
    recordAudit(req, {
      action: 'assign', entityType: 'member_training_plan', entityId: result.mtpId,
      next: { member_id: memberId, training_plan_id: result.planId, template_id: template_id ?? null },
    });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

memberTrainingPlansRouter.patch('/:id', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { memberId, id } = req.params as { memberId: string; id: string };
  const { status } = req.body;
  if (!status || !MTP_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${MTP_STATUSES.join(', ')}` });
  }
  try {
    const { rows: currentRows } = await db.query(
      'SELECT * FROM member_training_plans WHERE id = ? AND member_id = ? AND gym_id = ?',
      [id, memberId, gymId],
    );
    if (currentRows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    const current = currentRows[0];

    const becomingActive = status === 'active' && current.status !== 'active';
    const leavingActive = status !== 'active' && current.status === 'active';

    await db.query(
      `UPDATE member_training_plans SET
        status = ?,
        valid_from = ${becomingActive ? 'CURRENT_DATE()' : 'valid_from'},
        valid_to = ${leavingActive ? 'CURRENT_DATE()' : 'valid_to'}
       WHERE id = ? AND member_id = ? AND gym_id = ?`,
      [status, id, memberId, gymId],
    );
    const { rows } = await db.query('SELECT * FROM member_training_plans WHERE id = ?', [id]);
    recordAudit(req, { action: 'status_change', entityType: 'member_training_plan', entityId: id, previous: { status: current.status }, next: { status } });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
