import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { insertAndFetch } from '../infra/db-helpers';
import { computePromotionTimeline, validatePayBeforehandMonths } from '../domain/promotionTimeline';
import { PromotionBenefitAction } from '../domain/promotionBenefits';

const MEMBERSHIP_FEE_ACTIONS: PromotionBenefitAction[] = ['no_benefit', 'waive', 'percentage_discount', 'fixed_discount', 'fixed_price'];

const LIFECYCLE_STATUSES = ['active', 'inactive'] as const;

const SORT_COLUMNS: Record<string, string> = {
  name: 'p.name',
  created_at: 'p.created_at',
  starts_at: 'p.starts_at',
  ends_at: 'p.ends_at',
  lifecycle_status: 'p.lifecycle_status',
};

export const promotionsRouter = Router();

promotionsRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { active_on } = req.query as Record<string, string | undefined>;
  const lifecycleStatus = typeof req.query.lifecycle_status === 'string' ? req.query.lifecycle_status : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const createdBy = req.query.created_by == null || req.query.created_by === ''
    ? null : Number(req.query.created_by);
  if (createdBy !== null && !Number.isInteger(createdBy)) {
    return res.status(400).json({ error: 'created_by must be a membership id' });
  }
  // #628: narrows the list to the Promotions targeting one Membership Plan, so
  // the inline Assign-Plan editor can offer exactly the Promotions the apply
  // path (`promotion_membership_plans` check in membership-promotions.ts) will
  // accept for the plan being assigned, instead of listing every active promo
  // and surfacing the mismatch as a 400 after the fact.
  const membershipPlanId = req.query.membership_plan_id == null || req.query.membership_plan_id === ''
    ? null : Number(req.query.membership_plan_id);
  if (membershipPlanId !== null && (!Number.isInteger(membershipPlanId) || membershipPlanId <= 0)) {
    return res.status(400).json({ error: 'membership_plan_id must be a membership plan id' });
  }
  const sortKey = typeof req.query.sort === 'string' && req.query.sort in SORT_COLUMNS
    ? req.query.sort : 'starts_at';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

  const where: string[] = ['p.gym_id = ?', "p.lifecycle_status != 'deleted'"];
  const params: any[] = [gymId];

  if (lifecycleStatus) {
    if (!LIFECYCLE_STATUSES.includes(lifecycleStatus as any)) {
      return res.status(400).json({ error: `lifecycle_status must be one of: ${LIFECYCLE_STATUSES.join(', ')}` });
    }
    where.push('p.lifecycle_status = ?'); params.push(lifecycleStatus);
  }
  if (active_on) {
    where.push('p.starts_at <= ? AND p.ends_at >= ?');
    params.push(active_on, active_on);
  }
  if (q) {
    where.push('(p.name LIKE ? OR p.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (createdBy !== null) {
    where.push('p.created_by_membership_id = ?'); params.push(createdBy);
  }
  if (membershipPlanId !== null) {
    where.push(`EXISTS (
      SELECT 1 FROM promotion_membership_plans pmp
      WHERE pmp.promotion_id = p.id AND pmp.membership_plan_id = ? AND pmp.gym_id = ?
    )`);
    params.push(membershipPlanId, gymId);
  }

  try {
    const { rows } = await db.query(
      `SELECT p.id, p.gym_id, p.name, p.description, p.starts_at, p.ends_at,
              p.stackable, p.lifecycle_status, p.created_at, p.deleted_at,
              p.free_months, p.paid_months, p.bonus_months, p.pay_beforehand_months,
              p.created_by_membership_id,
              gm.name AS created_by_name
       FROM promotions p
       LEFT JOIN gym_memberships gm ON gm.id = p.created_by_membership_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${SORT_COLUMNS[sortKey]} ${dir}`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

promotionsRouter.get('/created-by-options', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT gm.id AS membership_id, gm.name
       FROM promotions p
       JOIN gym_memberships gm ON gm.id = p.created_by_membership_id
       WHERE p.gym_id = ? AND gm.name IS NOT NULL AND p.lifecycle_status != 'deleted'
       ORDER BY gm.name ASC`,
      [gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

function parseNonNegativeInt(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

// Non-persisted forecast preview — computed from whatever config values are
// passed in, so the frontend can preview unsaved edits without duplicating
// the Free/Pay/Prepaid/Bonus/Regular classification logic itself.
promotionsRouter.get('/timeline', async (req, res) => {
  const free = parseNonNegativeInt(req.query.free_months);
  const paid = parseNonNegativeInt(req.query.paid_months);
  const payBeforehand = parseNonNegativeInt(req.query.pay_beforehand_months);
  const bonus = parseNonNegativeInt(req.query.bonus_months);
  if (free === null || paid === null || payBeforehand === null || bonus === null) {
    return res.status(400).json({
      error: 'free_months, paid_months, pay_beforehand_months and bonus_months must be non-negative integers',
    });
  }
  const err = validatePayBeforehandMonths(paid, payBeforehand);
  if (err) return res.status(400).json({ error: err });

  const mfAction = typeof req.query.membership_fee_action === 'string' ? req.query.membership_fee_action : 'no_benefit';
  if (!MEMBERSHIP_FEE_ACTIONS.includes(mfAction as PromotionBenefitAction)) {
    return res.status(400).json({ error: `membership_fee_action must be one of: ${MEMBERSHIP_FEE_ACTIONS.join(', ')}` });
  }
  const mfEnabled = req.query.membership_fee_enabled === '1' || req.query.membership_fee_enabled === 'true';

  let mfValue: number | null = null;
  if (typeof req.query.membership_fee_value === 'string' && req.query.membership_fee_value !== '') {
    mfValue = Number(req.query.membership_fee_value);
    if (!Number.isFinite(mfValue)) return res.status(400).json({ error: 'membership_fee_value must be a number' });
  }

  let mfDurationMonths: number | null = null;
  if (typeof req.query.membership_fee_duration_months === 'string' && req.query.membership_fee_duration_months !== '') {
    const n = Number(req.query.membership_fee_duration_months);
    if (!Number.isInteger(n) || n < 1) {
      return res.status(400).json({ error: 'membership_fee_duration_months must be a positive integer' });
    }
    mfDurationMonths = n;
  }

  const anchorDate = typeof req.query.anchor_date === 'string' ? req.query.anchor_date : undefined;
  const result = computePromotionTimeline(
    {
      freeMonths: free, paidMonths: paid, payBeforehandMonths: payBeforehand, bonusMonths: bonus,
      membershipFeeAction: mfAction as PromotionBenefitAction,
      membershipFeeValue: mfValue,
      membershipFeeEnabled: mfEnabled,
      membershipFeeDurationMonths: mfDurationMonths,
    },
    anchorDate,
  );
  res.json(result);
});

promotionsRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT p.*,
              gm_c.name AS created_by_name,
              gm_d.name AS deleted_by_name
       FROM promotions p
       LEFT JOIN gym_memberships gm_c ON gm_c.id = p.created_by_membership_id
       LEFT JOIN gym_memberships gm_d ON gm_d.id = p.deleted_by_membership_id
       WHERE p.id = ? AND p.gym_id = ?`,
      [req.params.id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Promotion not found' });

    const { rows: auditRows } = await db.query(
      `SELECT actor_name, created_at AS modified_at
       FROM audit_logs
       WHERE gym_id = ? AND entity_type = 'promotion' AND entity_id = ? AND action = 'update'
       ORDER BY created_at DESC LIMIT 1`,
      [gymId, req.params.id],
    );
    const promo = {
      ...rows[0],
      modified_at: auditRows[0]?.modified_at ?? null,
      modified_by_name: auditRows[0]?.actor_name ?? null,
    };
    res.json(promo);
  } catch (err) { next(err); }
});

function validateBody(body: any) {
  if (body.starts_at && body.ends_at && new Date(body.starts_at) > new Date(body.ends_at)) {
    return 'ends_at must be on or after starts_at';
  }
  if (body.lifecycle_status && !LIFECYCLE_STATUSES.includes(body.lifecycle_status)) {
    return `lifecycle_status must be one of: ${LIFECYCLE_STATUSES.join(', ')}`;
  }
  return null;
}

promotionsRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, starts_at, ends_at, stackable, lifecycle_status,
          free_months, paid_months, bonus_months, pay_beforehand_months } = req.body;
  if (!name?.trim() || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'name, starts_at and ends_at are required' });
  }
  const err = validateBody(req.body); if (err) return res.status(400).json({ error: err });
  const pbErr = validatePayBeforehandMonths(paid_months ?? 0, pay_beforehand_months ?? 0);
  if (pbErr) return res.status(400).json({ error: pbErr });
  try {
    const row = await insertAndFetch(
      `INSERT INTO promotions
         (gym_id, name, description, starts_at, ends_at, stackable, lifecycle_status,
          created_by_membership_id, free_months, paid_months, bonus_months, pay_beforehand_months)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gymId, name.trim(), description ?? null,
        new Date(starts_at), new Date(ends_at),
        stackable ? 1 : 0,
        lifecycle_status ?? 'active',
        gymMembershipId ?? null,
        free_months ?? null,
        paid_months ?? null,
        bonus_months ?? null,
        pay_beforehand_months ?? 0,
      ],
      'SELECT * FROM promotions WHERE id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'promotion', entityId: row.id, entityName: row.name, next: row });
    res.status(201).json(row);
  } catch (e) { next(e); }
});

promotionsRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const err = validateBody(req.body); if (err) return res.status(400).json({ error: err });
  const { name, description, starts_at, ends_at, stackable, lifecycle_status,
          free_months, paid_months, bonus_months, pay_beforehand_months } = req.body;
  try {
    const { rows: existingRows } = await db.query(
      "SELECT paid_months, pay_beforehand_months FROM promotions WHERE id = ? AND gym_id = ? AND lifecycle_status != 'deleted'",
      [req.params.id, gymId],
    );
    if (existingRows.length === 0) return res.status(404).json({ error: 'Promotion not found' });
    const effectivePaidMonths = 'paid_months' in req.body ? (paid_months ?? 0) : (existingRows[0].paid_months ?? 0);
    const effectivePayBeforehandMonths = 'pay_beforehand_months' in req.body
      ? (pay_beforehand_months ?? 0) : (existingRows[0].pay_beforehand_months ?? 0);
    const pbErr = validatePayBeforehandMonths(effectivePaidMonths, effectivePayBeforehandMonths);
    if (pbErr) return res.status(400).json({ error: pbErr });

    const { rowCount } = await db.query(
      `UPDATE promotions SET
        name                  = COALESCE(?, name),
        description           = IF(?, ?, description),
        starts_at             = COALESCE(?, starts_at),
        ends_at               = COALESCE(?, ends_at),
        stackable             = IF(?, ?, stackable),
        lifecycle_status      = COALESCE(?, lifecycle_status),
        free_months           = IF(?, ?, free_months),
        paid_months           = IF(?, ?, paid_months),
        bonus_months          = IF(?, ?, bonus_months),
        pay_beforehand_months = IF(?, ?, pay_beforehand_months)
       WHERE id = ? AND gym_id = ? AND lifecycle_status != 'deleted'`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        starts_at ? new Date(starts_at) : null,
        ends_at ? new Date(ends_at) : null,
        'stackable' in req.body ? 1 : 0, stackable ? 1 : 0,
        lifecycle_status ?? null,
        'free_months' in req.body ? 1 : 0, free_months ?? null,
        'paid_months' in req.body ? 1 : 0, paid_months ?? null,
        'bonus_months' in req.body ? 1 : 0, bonus_months ?? null,
        'pay_beforehand_months' in req.body ? 1 : 0, pay_beforehand_months ?? 0,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Promotion not found' });
    const { rows } = await db.query('SELECT * FROM promotions WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'promotion', entityId: req.params.id, entityName: rows[0].name, next: rows[0] });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

promotionsRouter.delete('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId, actorName } = getTenantContext(req);
  try {
    const { rows: existing } = await db.query(
      "SELECT name FROM promotions WHERE id = ? AND gym_id = ? AND lifecycle_status != 'deleted'",
      [req.params.id, gymId],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Promotion not found' });
    await db.query(
      `UPDATE promotions
         SET lifecycle_status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ?, deleted_by_name = ?
       WHERE id = ? AND gym_id = ?`,
      [gymMembershipId ?? null, actorName, req.params.id, gymId],
    );
    recordAudit(req, { action: 'delete', entityType: 'promotion', entityId: req.params.id, entityName: existing[0].name });
    res.status(204).send();
  } catch (e) { next(e); }
});

promotionsRouter.post('/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows: srcRows } = await db.query(
    "SELECT * FROM promotions WHERE id = ? AND gym_id = ? AND lifecycle_status != 'deleted'",
    [req.params.id, gymId],
  );
  if (srcRows.length === 0) return res.status(404).json({ error: 'Promotion not found' });
  const src = srcRows[0];

  let copyName = `${src.name} (Copy)`;
  const { rows: existing } = await db.query(
    'SELECT name FROM promotions WHERE gym_id = ? AND name LIKE ?',
    [gymId, `${src.name} (Copy%`],
  );
  if (existing.length > 0) copyName = `${src.name} (Copy ${existing.length + 1})`;

  try {
    let newId: number;
    await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO promotions
           (gym_id, name, description, starts_at, ends_at, stackable, lifecycle_status,
            created_by_membership_id, free_months, paid_months, bonus_months, pay_beforehand_months)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          gymId, copyName, src.description, src.starts_at, src.ends_at,
          src.stackable, src.lifecycle_status, gymMembershipId ?? null,
          src.free_months, src.paid_months, src.bonus_months, src.pay_beforehand_months,
        ],
      );
      newId = insertId;

      const { rows: cbs } = await tx.query(
        'SELECT * FROM promotion_charge_benefits WHERE promotion_id = ? AND gym_id = ?',
        [src.id, gymId],
      );
      for (const cb of cbs) {
        await tx.query(
          'INSERT INTO promotion_charge_benefits (gym_id, promotion_id, gym_charge_id, action, value) VALUES (?, ?, ?, ?, ?)',
          [gymId, newId, cb.gym_charge_id, cb.action, cb.value],
        );
      }

      const { rows: pbs } = await tx.query(
        'SELECT * FROM promotion_period_benefits WHERE promotion_id = ? AND gym_id = ?',
        [src.id, gymId],
      );
      for (const pb of pbs) {
        await tx.query(
          `INSERT INTO promotion_period_benefits
             (gym_id, promotion_id, charge_type_id, quantity, frequency_interval, frequency_unit, duration_months, enabled, action, value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [gymId, newId, pb.charge_type_id, pb.quantity, pb.frequency_interval, pb.frequency_unit, pb.duration_months, pb.enabled, pb.action, pb.value],
        );
      }

      const { rows: plans } = await tx.query(
        'SELECT * FROM promotion_membership_plans WHERE promotion_id = ? AND gym_id = ?',
        [src.id, gymId],
      );
      for (const plan of plans) {
        await tx.query(
          'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
          [gymId, newId, plan.membership_plan_id],
        );
      }

      const { rows: ibs } = await tx.query(
        'SELECT * FROM promotion_included_benefits WHERE promotion_id = ? AND gym_id = ?',
        [src.id, gymId],
      );
      for (const ib of ibs) {
        await tx.query(
          'INSERT INTO promotion_included_benefits (gym_id, promotion_id, charge_type_id, quantity) VALUES (?, ?, ?, ?)',
          [gymId, newId, ib.charge_type_id, ib.quantity],
        );
      }

      // #550 stage 2: the three Sellable-Item-keyed tables (migration 155)
      // that replace the "quantity granted" half of Period/Included Benefits
      // above — copied the same way so duplicating a promotion never drops
      // benefits configured through the new session/one-off/periodical
      // endpoints.
      for (const table of ['promotion_session', 'promotion_oneoff', 'promotion_periodical']) {
        const { rows: sibs } = await tx.query(
          `SELECT gym_charge_id, quantity FROM ${table} WHERE promotion_id = ? AND gym_id = ?`,
          [src.id, gymId],
        );
        for (const sib of sibs) {
          await tx.query(
            `INSERT INTO ${table} (gym_id, promotion_id, gym_charge_id, quantity, created_by_membership_id) VALUES (?, ?, ?, ?, ?)`,
            [gymId, newId, sib.gym_charge_id, sib.quantity, gymMembershipId ?? null],
          );
        }
      }
    });

    const { rows } = await db.query('SELECT * FROM promotions WHERE id = ?', [newId!]);
    recordAudit(req, { action: 'create', entityType: 'promotion', entityId: newId!, entityName: copyName, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});
