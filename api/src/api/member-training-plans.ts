import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { createTrainingPlanTx } from './training-plan-creation';

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
    const result = await db.transaction(async (tx) =>
      createTrainingPlanTx(tx, {
        gymId, memberId, gymMembershipId,
        templateId: template_id ?? null,
        name: name?.trim() || null,
        description,
        startDate: null,
        validTo: valid_to ?? null,
      }),
    );

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
