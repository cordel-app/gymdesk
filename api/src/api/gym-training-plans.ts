import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { createTrainingPlanTx } from './training-plan-creation';
import { PLAN_TREE_SELECT } from './training-plans';

/**
 * #67: gym-level Training Plans module — the cross-member listing behind the
 * new sidebar page, plus the creation endpoint used by all three workflows
 * (from template, from scratch, assign-from-template shortcut). Mutations on
 * a plan's contents stay on the member-scoped router (training-plans.ts);
 * every listing row carries member_id so the client can reach those routes.
 *
 * Creation enforces the existing-active-plans rule server-side: if the member
 * already has Active plans and the client didn't say what to do, respond 409
 * so the UI can prompt keep-vs-expire; 'expire' closes those plans
 * (status = expired, end_date = the new plan's start date) and their
 * assignment-history rows in the same transaction that creates the new plan.
 */

export const gymTrainingPlansRouter = Router();

const LIST_STATUSES = ['draft', 'active', 'expired', 'completed'];

const SORT_COLUMNS: Record<string, string> = {
  name: 'tp.name',
  member: 'm.name',
  template: 'tpt.name',
  status: 'tp.status',
  start_date: 'tp.start_date',
  created_by: 'gm.name',
  created_at: 'tp.created_at',
  modified_at: 'tp.modified_at',
};
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

gymTrainingPlansRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  if (status && !LIST_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${LIST_STATUSES.join(', ')}` });
  }
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  const toId = (v: any) => (v == null || v === '' ? null : Number(v));
  const memberId = toId(req.query.member_id);
  if (memberId !== null && !Number.isInteger(memberId)) return res.status(400).json({ error: 'member_id must be a member id' });
  const createdBy = toId(req.query.created_by);
  if (createdBy !== null && !Number.isInteger(createdBy)) return res.status(400).json({ error: 'created_by must be a membership id' });
  // template_id: numeric id, or the literal 'custom' for plans created from scratch
  const templateRaw = req.query.template_id;
  let templateId: number | 'custom' | null = null;
  if (templateRaw != null && templateRaw !== '') {
    if (templateRaw === 'custom') templateId = 'custom';
    else if (Number.isInteger(Number(templateRaw))) templateId = Number(templateRaw);
    else return res.status(400).json({ error: "template_id must be a template id or 'custom'" });
  }
  const dateFilter = (key: string): string | null => {
    const v = req.query[key];
    if (v == null || v === '') return null;
    if (typeof v !== 'string' || !DATE_RE.test(v)) throw Object.assign(new Error(`${key} must be YYYY-MM-DD`), { status: 400 });
    return v;
  };
  const sortKey = typeof req.query.sort === 'string' && req.query.sort in SORT_COLUMNS ? req.query.sort : 'created_at';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  // limit/offset are validated integers — interpolated because mysql2 prepared
  // statements don't accept placeholders in LIMIT reliably.
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
  try {
    const where: string[] = ['tp.gym_id = ?', "tp.status != 'deleted'"];
    const params: any[] = [gymId];
    if (status) { where.push('tp.status = ?'); params.push(status); }
    if (name) { where.push('tp.name LIKE ?'); params.push(`%${name}%`); }
    if (memberId !== null) { where.push('tp.member_id = ?'); params.push(memberId); }
    if (createdBy !== null) { where.push('tp.assigned_by_membership_id = ?'); params.push(createdBy); }
    if (templateId === 'custom') where.push('tp.template_id IS NULL');
    else if (templateId !== null) { where.push('tp.template_id = ?'); params.push(templateId); }
    const createdFrom = dateFilter('created_from');
    const createdTo = dateFilter('created_to');
    const modifiedFrom = dateFilter('modified_from');
    const modifiedTo = dateFilter('modified_to');
    if (createdFrom) { where.push('tp.created_at >= ?'); params.push(createdFrom); }
    if (createdTo) { where.push('tp.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(createdTo); }
    if (modifiedFrom) { where.push('tp.modified_at >= ?'); params.push(modifiedFrom); }
    if (modifiedTo) { where.push('tp.modified_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(modifiedTo); }
    const whereSql = where.join(' AND ');

    const fromSql = `
      FROM training_plans tp
      JOIN members m ON m.id = tp.member_id
      LEFT JOIN training_plan_templates tpt ON tpt.id = tp.template_id
      LEFT JOIN gym_memberships gm ON gm.id = tp.assigned_by_membership_id
      LEFT JOIN gym_memberships gm2 ON gm2.id = tp.modified_by_membership_id`;

    const { rows: countRows } = await db.query(`SELECT COUNT(*) AS total ${fromSql} WHERE ${whereSql}`, params);
    const { rows } = await db.query(
      `SELECT tp.id, tp.name, tp.description, tp.status, tp.start_date, tp.end_date,
              tp.member_id, m.name AS member_name,
              tp.template_id, tpt.name AS template_name,
              tp.assigned_by_membership_id, gm.name AS created_by_name,
              tp.created_at, tp.modified_at, gm2.name AS modified_by_name
       ${fromSql}
       WHERE ${whereSql}
       ORDER BY ${SORT_COLUMNS[sortKey]} ${dir} LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Distinct assigners of this gym's non-deleted plans — populates the Created By filter.
gymTrainingPlansRouter.get('/created-by-options', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT gm.id AS membership_id, gm.name
       FROM training_plans tp
       JOIN gym_memberships gm ON gm.id = tp.assigned_by_membership_id
       WHERE tp.gym_id = ? AND tp.status != 'deleted' AND gm.name IS NOT NULL
       ORDER BY gm.name ASC`,
      [gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Full plan tree plus the display names the editor header needs. Content
// mutations then go through /members/:memberId/training-plans/:planId/…
gymTrainingPlansRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const { rows } = await db.query(
      `${PLAN_TREE_SELECT} WHERE tp.id = ? AND tp.gym_id = ? AND tp.status != 'deleted'`,
      [id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Training plan not found' });
    const plan = rows[0];
    const { rows: nameRows } = await db.query(
      `SELECT m.name AS member_name, tpt.name AS template_name, gm.name AS created_by_name
       FROM training_plans tp
       JOIN members m ON m.id = tp.member_id
       LEFT JOIN training_plan_templates tpt ON tpt.id = tp.template_id
       LEFT JOIN gym_memberships gm ON gm.id = tp.assigned_by_membership_id
       WHERE tp.id = ?`,
      [id],
    );
    res.json({ ...plan, ...nameRows[0] });
  } catch (err) {
    next(err);
  }
});

gymTrainingPlansRouter.post('/', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { member_id, template_id, name, description, start_date, on_existing_active } = req.body;

  const memberId = Number(member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: 'member_id is required' });
  const templateId = template_id == null || template_id === '' ? null : Number(template_id);
  if (templateId !== null && (!Number.isInteger(templateId) || templateId <= 0)) {
    return res.status(400).json({ error: 'template_id must be a template id' });
  }
  if (!templateId && !name?.trim()) {
    return res.status(400).json({ error: 'name is required when creating a plan from scratch (no template_id)' });
  }
  if (!start_date || typeof start_date !== 'string' || !DATE_RE.test(start_date)) {
    return res.status(400).json({ error: 'start_date is required (YYYY-MM-DD)' });
  }
  if (on_existing_active != null && !['keep', 'expire'].includes(on_existing_active)) {
    return res.status(400).json({ error: "on_existing_active must be 'keep' or 'expire'" });
  }

  try {
    const { rows: memberRows } = await db.query(
      'SELECT 1 FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [memberId, gymId],
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

    const result = await db.transaction(async (tx) => {
      // Locked read so a concurrent create for the same member can't slip an
      // Active plan past the keep-vs-expire decision.
      const { rows: activeRows } = await tx.query(
        "SELECT id FROM training_plans WHERE member_id = ? AND gym_id = ? AND status = 'active' FOR UPDATE",
        [memberId, gymId],
      );
      const activeIds = activeRows.map((r: any) => r.id);
      if (activeIds.length > 0 && !on_existing_active) {
        throw Object.assign(
          new Error('Member already has active training plans. Choose whether to keep them active or expire them.'),
          { status: 409, activeCount: activeIds.length },
        );
      }
      if (activeIds.length > 0 && on_existing_active === 'expire') {
        const marks = activeIds.map(() => '?').join(',');
        await tx.query(
          `UPDATE training_plans SET status = 'expired', end_date = ?,
                  modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
           WHERE id IN (${marks}) AND gym_id = ?`,
          [start_date, gymMembershipId, ...activeIds, gymId],
        );
        await tx.query(
          `UPDATE member_training_plans SET status = 'completed', valid_to = ?
           WHERE training_plan_id IN (${marks}) AND gym_id = ? AND status = 'active'`,
          [start_date, ...activeIds, gymId],
        );
      }
      const created = await createTrainingPlanTx(tx, {
        gymId, memberId, gymMembershipId,
        templateId,
        name: name?.trim() || null,
        description,
        startDate: start_date,
        validTo: null,
      });
      return { ...created, expiredIds: on_existing_active === 'expire' ? activeIds : [] };
    });

    for (const expiredId of result.expiredIds) {
      recordAudit(req, {
        action: 'status_change', entityType: 'training_plan', entityId: expiredId,
        previous: { status: 'active' }, next: { status: 'expired', end_date: start_date },
      });
    }
    const { rows } = await db.query(
      `SELECT tp.*, m.name AS member_name, tpt.name AS template_name, gm.name AS created_by_name
       FROM training_plans tp
       JOIN members m ON m.id = tp.member_id
       LEFT JOIN training_plan_templates tpt ON tpt.id = tp.template_id
       LEFT JOIN gym_memberships gm ON gm.id = tp.assigned_by_membership_id
       WHERE tp.id = ?`,
      [result.planId],
    );
    recordAudit(req, {
      action: 'create', entityType: 'training_plan', entityId: result.planId,
      next: { member_id: memberId, template_id: templateId, name: result.planName, start_date },
    });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.status === 409) return res.status(409).json({ error: err.message, active_count: err.activeCount });
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});
