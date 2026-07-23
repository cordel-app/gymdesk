import { Router, Request } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { gymFetchOne, handleDupEntry, insertAndFetch } from '../infra/db-helpers';

interface PlanRow {
  id: number;
  gym_id: string;
  name: string;
  description: string | null;
  lifecycle_status: string;
  enrollment_status: string;
  created_by: number | null;
  created_by_name?: string | null;
  modified_at: string | null;
  modified_by: number | null;
  modified_by_name?: string | null;
  deleted_at: string | null;
  deleted_by: number | null;
  created_at: string;
}

interface PriceRow {
  id: number;
  membership_plan_id: number;
  gym_id: string;
  price: string;
  valid_from: string;
  valid_to: string | null;
}

interface BillingPolicyRow {
  id: number;
  gym_id: string;
  membership_plan_id: number;
  initial_billing_interval: number | null;
  initial_billing_unit: string | null;
  recurring_billing_interval: number | null;
  recurring_billing_unit: string | null;
  initial_service_interval: number | null;
  initial_service_unit: string | null;
  recurring_service_interval: number | null;
  recurring_service_unit: string | null;
  auto_renew: boolean;
}

export const membershipPlansRouter = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getCallerMembershipId(req: Request): Promise<number | null> {
  const userId = req.auth?.userId;
  if (!userId) return null;
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT id FROM gym_memberships WHERE gym_id = ? AND clerk_user_id = ? LIMIT 1',
    [gymId, userId],
  );
  return rows.length > 0 ? rows[0].id : null;
}

async function enrichPlan(plan: PlanRow, gymId: string): Promise<object> {
  const [prices, bpRows, allowances, centers, memberCount] = await Promise.all([
    db.query<PriceRow>(
      'SELECT * FROM membership_plan_prices WHERE membership_plan_id = ? AND gym_id = ? ORDER BY valid_from ASC',
      [plan.id, gymId],
    ).then(r => r.rows),
    db.query<BillingPolicyRow>(
      'SELECT * FROM billing_policies WHERE membership_plan_id = ? AND gym_id = ?',
      [plan.id, gymId],
    ).then(r => r.rows),
    db.query(
      `SELECT pa.*, at.name AS activity_type_name
       FROM plan_allowances pa
       JOIN activity_types at ON at.id = pa.activity_type_id
       WHERE pa.membership_plan_id = ? AND pa.gym_id = ?`,
      [plan.id, gymId],
    ).then(r => r.rows),
    db.query(
      `SELECT mpc.center_id AS id, c.name
       FROM membership_plan_centers mpc
       JOIN centers c ON c.id = mpc.center_id
       WHERE mpc.membership_plan_id = ? AND mpc.gym_id = ?`,
      [plan.id, gymId],
    ).then(r => r.rows),
    db.query(
      `SELECT COUNT(*) AS n FROM user_memberships
       WHERE membership_plan_id = ? AND gym_id = ? AND status = 'active'`,
      [plan.id, gymId],
    ).then(r => Number(r.rows[0].n)),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const currentPrice = prices.find(p => {
    return p.valid_from <= today && (p.valid_to == null || p.valid_to >= today);
  }) ?? null;

  return {
    ...plan,
    current_price: currentPrice ? currentPrice.price : null,
    price_history: prices,
    billing_policy: bpRows[0] ?? null,
    allowances,
    centers,
    member_count: memberCount,
  };
}

async function planExists(planId: string | string[], gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM membership_plans WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [planId, gymId],
  );
  return rows.length > 0;
}

// ─── Plan CRUD ────────────────────────────────────────────────────────────────

membershipPlansRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.lifecycle_status as string | undefined;
  let sql = `SELECT mp.*,
                    gm_c.name AS created_by_name,
                    gm_m.name AS modified_by_name
             FROM membership_plans mp
             LEFT JOIN gym_memberships gm_c ON gm_c.id = mp.created_by
             LEFT JOIN gym_memberships gm_m ON gm_m.id = mp.modified_by
             WHERE mp.gym_id = ? AND mp.deleted_at IS NULL`;
  const params: (string | number)[] = [gymId];
  if (status) { sql += ' AND mp.lifecycle_status = ?'; params.push(status); }
  sql += ' ORDER BY mp.name ASC';
  const { rows } = await db.query<PlanRow>(sql, params);
  const enriched = await Promise.all(rows.map(p => enrichPlan(p, gymId)));
  res.json(enriched);
});

membershipPlansRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query<PlanRow>(
    `SELECT mp.*,
            gm_c.name AS created_by_name,
            gm_m.name AS modified_by_name
     FROM membership_plans mp
     LEFT JOIN gym_memberships gm_c ON gm_c.id = mp.created_by
     LEFT JOIN gym_memberships gm_m ON gm_m.id = mp.modified_by
     WHERE mp.id = ? AND mp.gym_id = ? AND mp.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Plan not found' });
  res.json(await enrichPlan(rows[0], gymId));
});

membershipPlansRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, lifecycle_status, enrollment_status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const callerMemberId = await getCallerMembershipId(req);
  try {
    const row = await insertAndFetch(
      `INSERT INTO membership_plans
       (gym_id, name, description, lifecycle_status, enrollment_status, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [gymId, name.trim(), description ?? null,
       lifecycle_status ?? 'draft', enrollment_status ?? 'closed', callerMemberId],
      'SELECT * FROM membership_plans WHERE id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'membership_plan', entityId: row.id, next: row });
    res.status(201).json(await enrichPlan(row, gymId));
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A plan with this name already exists.');
  }
});

membershipPlansRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, lifecycle_status, enrollment_status } = req.body;

  const VALID_ENROLLMENT = ['open', 'closed', 'paused'];
  if (enrollment_status && !VALID_ENROLLMENT.includes(enrollment_status)) {
    return res.status(400).json({ error: 'Invalid enrollment_status' });
  }
  if (enrollment_status === 'open' && lifecycle_status && lifecycle_status !== 'active') {
    return res.status(400).json({ error: 'enrollment can only be opened when lifecycle_status is active' });
  }

  const callerMemberId = await getCallerMembershipId(req);
  try {
    const { rowCount } = await db.query(
      `UPDATE membership_plans SET
        name              = COALESCE(?, name),
        description       = IF(?, ?, description),
        lifecycle_status  = COALESCE(?, lifecycle_status),
        enrollment_status = COALESCE(?, enrollment_status),
        modified_at       = NOW(),
        modified_by       = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        lifecycle_status ?? null,
        enrollment_status ?? null,
        callerMemberId,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Plan not found' });
    const { rows } = await db.query('SELECT * FROM membership_plans WHERE id = ?', [req.params.id]);
    recordAudit(req, { action: 'update', entityType: 'membership_plan', entityId: req.params.id, next: rows[0] });
    res.json(await enrichPlan(rows[0], gymId));
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A plan with this name already exists.');
  }
});

membershipPlansRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows: active } = await db.query(
    `SELECT COUNT(*) AS n FROM user_memberships
     WHERE membership_plan_id = ? AND gym_id = ? AND status = 'active'`,
    [req.params.id, gymId],
  );
  if (Number(active[0].n) > 0) {
    return res.status(400).json({ error: 'Cannot delete a plan with active memberships.' });
  }
  const callerMemberId = await getCallerMembershipId(req);
  const { rowCount } = await db.query(
    `UPDATE membership_plans SET deleted_at = NOW(), deleted_by = ?, enrollment_status = 'closed'
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [callerMemberId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Plan not found' });
  recordAudit(req, { action: 'delete', entityType: 'membership_plan', entityId: req.params.id });
  res.status(204).send();
});

// ─── Duplicate ────────────────────────────────────────────────────────────────

membershipPlansRouter.post('/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { rows: origRows } = await db.query(
    'SELECT * FROM membership_plans WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (origRows.length === 0) return res.status(404).json({ error: 'Plan not found' });
  const orig = origRows[0];
  const callerMemberId = await getCallerMembershipId(req);

  try {
    await db.query('START TRANSACTION', []);

    const { insertId: newPlanId } = await db.query(
      `INSERT INTO membership_plans
       (gym_id, name, description, lifecycle_status, enrollment_status, created_by)
       VALUES (?, ?, ?, 'draft', 'closed', ?)`,
      [gymId, `${orig.name} (Copy)`, orig.description ?? null, callerMemberId],
    );

    // Copy billing policy
    const { rows: bp } = await db.query(
      'SELECT * FROM billing_policies WHERE membership_plan_id = ? AND gym_id = ?',
      [req.params.id, gymId],
    );
    if (bp.length > 0) {
      const b = bp[0];
      await db.query(
        `INSERT INTO billing_policies
         (gym_id, membership_plan_id, initial_billing_interval, initial_billing_unit,
          recurring_billing_interval, recurring_billing_unit,
          initial_service_interval, initial_service_unit,
          recurring_service_interval, recurring_service_unit, auto_renew)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, newPlanId, b.initial_billing_interval, b.initial_billing_unit,
         b.recurring_billing_interval, b.recurring_billing_unit,
         b.initial_service_interval, b.initial_service_unit,
         b.recurring_service_interval, b.recurring_service_unit, b.auto_renew],
      );
    }

    // Copy prices
    const { rows: prices } = await db.query(
      'SELECT * FROM membership_plan_prices WHERE membership_plan_id = ? AND gym_id = ?',
      [req.params.id, gymId],
    );
    for (const p of prices) {
      await db.query(
        'INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)',
        [gymId, newPlanId, p.price, p.valid_from, p.valid_to],
      );
    }

    // Copy allowances
    const { rows: allowances } = await db.query(
      'SELECT * FROM plan_allowances WHERE membership_plan_id = ? AND gym_id = ?',
      [req.params.id, gymId],
    );
    for (const a of allowances) {
      await db.query(
        `INSERT INTO plan_allowances
         (gym_id, membership_plan_id, activity_type_id, allowance_type, session_count, recurrence_interval, recurrence_unit)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [gymId, newPlanId, a.activity_type_id, a.allowance_type, a.session_count, a.recurrence_interval, a.recurrence_unit],
      );
    }

    // Copy centers
    const { rows: centers } = await db.query(
      'SELECT * FROM membership_plan_centers WHERE membership_plan_id = ? AND gym_id = ?',
      [req.params.id, gymId],
    );
    for (const c of centers) {
      await db.query(
        'INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)',
        [gymId, newPlanId, c.center_id],
      );
    }

    await db.query('COMMIT', []);

    const { rows } = await db.query('SELECT * FROM membership_plans WHERE id = ?', [newPlanId]);
    res.status(201).json(await enrichPlan(rows[0], gymId));
  } catch (err) {
    await db.query('ROLLBACK', []).catch(() => {});
    next(err);
  }
});

// ─── Archive ──────────────────────────────────────────────────────────────────

membershipPlansRouter.post('/:id/archive', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows: active } = await db.query(
    `SELECT COUNT(*) AS n FROM user_memberships
     WHERE membership_plan_id = ? AND gym_id = ? AND status = 'active'`,
    [req.params.id, gymId],
  );
  if (Number(active[0].n) > 0) {
    return res.status(400).json({ error: 'Cannot archive a plan with active memberships.' });
  }
  const callerMemberId = await getCallerMembershipId(req);
  const { rowCount } = await db.query(
    `UPDATE membership_plans
     SET lifecycle_status = 'archived', enrollment_status = 'closed', modified_at = NOW(), modified_by = ?
     WHERE id = ? AND gym_id = ? AND lifecycle_status = 'active' AND deleted_at IS NULL`,
    [callerMemberId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Plan not found or not active' });
  const { rows } = await db.query('SELECT * FROM membership_plans WHERE id = ?', [req.params.id]);
  res.json(await enrichPlan(rows[0], gymId));
});

// ─── Enrollment toggle ────────────────────────────────────────────────────────

membershipPlansRouter.put('/:id/enrollment', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { enrollment_status } = req.body;
  if (!['open', 'closed', 'paused'].includes(enrollment_status)) {
    return res.status(400).json({ error: 'enrollment_status must be open, closed, or paused' });
  }
  const { rows: plan } = await db.query(
    'SELECT lifecycle_status FROM membership_plans WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (plan.length === 0) return res.status(404).json({ error: 'Plan not found' });
  if (enrollment_status === 'open' && plan[0].lifecycle_status !== 'active') {
    return res.status(400).json({ error: 'Cannot open enrollment on a non-active plan' });
  }
  const callerMemberId = await getCallerMembershipId(req);
  await db.query(
    'UPDATE membership_plans SET enrollment_status = ?, modified_at = NOW(), modified_by = ? WHERE id = ? AND gym_id = ?',
    [enrollment_status, callerMemberId, req.params.id, gymId],
  );
  const { rows } = await db.query('SELECT * FROM membership_plans WHERE id = ?', [req.params.id]);
  res.json(await enrichPlan(rows[0], gymId));
});

// ─── Billing policy ───────────────────────────────────────────────────────────

membershipPlansRouter.get('/:id/billing-policy', async (req, res) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { rows } = await db.query(
    'SELECT * FROM billing_policies WHERE membership_plan_id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  res.json(rows[0] ?? null);
});

membershipPlansRouter.put('/:id/billing-policy', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const {
    initial_billing_interval, initial_billing_unit,
    recurring_billing_interval, recurring_billing_unit,
    initial_service_interval, initial_service_unit,
    recurring_service_interval, recurring_service_unit,
    auto_renew,
  } = req.body;
  try {
    await db.query(
      `INSERT INTO billing_policies
       (gym_id, membership_plan_id, initial_billing_interval, initial_billing_unit,
        recurring_billing_interval, recurring_billing_unit,
        initial_service_interval, initial_service_unit,
        recurring_service_interval, recurring_service_unit, auto_renew)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        initial_billing_interval    = VALUES(initial_billing_interval),
        initial_billing_unit        = VALUES(initial_billing_unit),
        recurring_billing_interval  = VALUES(recurring_billing_interval),
        recurring_billing_unit      = VALUES(recurring_billing_unit),
        initial_service_interval    = VALUES(initial_service_interval),
        initial_service_unit        = VALUES(initial_service_unit),
        recurring_service_interval  = VALUES(recurring_service_interval),
        recurring_service_unit      = VALUES(recurring_service_unit),
        auto_renew                  = VALUES(auto_renew)`,
      [gymId, req.params.id,
       initial_billing_interval, initial_billing_unit,
       recurring_billing_interval, recurring_billing_unit,
       initial_service_interval, initial_service_unit,
       recurring_service_interval, recurring_service_unit,
       auto_renew ?? true],
    );
    const { rows } = await db.query(
      'SELECT * FROM billing_policies WHERE membership_plan_id = ? AND gym_id = ?',
      [req.params.id, gymId],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ─── Allowances ───────────────────────────────────────────────────────────────

membershipPlansRouter.get('/:id/allowances', async (req, res) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { rows } = await db.query(
    `SELECT pa.*, at.name AS activity_type_name
     FROM plan_allowances pa
     JOIN activity_types at ON at.id = pa.activity_type_id
     WHERE pa.membership_plan_id = ? AND pa.gym_id = ?`,
    [req.params.id, gymId],
  );
  res.json(rows);
});

membershipPlansRouter.post('/:id/allowances', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { activity_type_id, allowance_type, session_count, recurrence_interval, recurrence_unit } = req.body;
  if (!activity_type_id || !allowance_type) {
    return res.status(400).json({ error: 'activity_type_id and allowance_type are required' });
  }
  try {
    const { insertId } = await db.query(
      `INSERT INTO plan_allowances
       (gym_id, membership_plan_id, activity_type_id, allowance_type, session_count, recurrence_interval, recurrence_unit)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [gymId, req.params.id, activity_type_id, allowance_type, session_count ?? null, recurrence_interval ?? null, recurrence_unit ?? null],
    );
    const { rows } = await db.query(
      `SELECT pa.*, at.name AS activity_type_name FROM plan_allowances pa
       JOIN activity_types at ON at.id = pa.activity_type_id WHERE pa.id = ?`,
      [insertId],
    );
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'An allowance for this activity type already exists.' });
    next(err);
  }
});

membershipPlansRouter.put('/:id/allowances/:allowanceId', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { allowance_type, session_count, recurrence_interval, recurrence_unit } = req.body;
  try {
    const { rowCount } = await db.query(
      `UPDATE plan_allowances SET
        allowance_type = COALESCE(?, allowance_type),
        session_count = ?,
        recurrence_interval = ?,
        recurrence_unit = ?
       WHERE id = ? AND membership_plan_id = ? AND gym_id = ?`,
      [allowance_type ?? null, session_count ?? null, recurrence_interval ?? null, recurrence_unit ?? null,
       req.params.allowanceId, req.params.id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Allowance not found' });
    const { rows } = await db.query(
      `SELECT pa.*, at.name AS activity_type_name FROM plan_allowances pa
       JOIN activity_types at ON at.id = pa.activity_type_id WHERE pa.id = ?`,
      [req.params.allowanceId],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

membershipPlansRouter.delete('/:id/allowances/:allowanceId', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM plan_allowances WHERE id = ? AND membership_plan_id = ? AND gym_id = ?',
    [req.params.allowanceId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Allowance not found' });
  res.status(204).send();
});

// ─── Centers ──────────────────────────────────────────────────────────────────

membershipPlansRouter.get('/:id/centers', async (req, res) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { rows } = await db.query(
    `SELECT mpc.center_id AS id, c.name
     FROM membership_plan_centers mpc
     JOIN centers c ON c.id = mpc.center_id
     WHERE mpc.membership_plan_id = ? AND mpc.gym_id = ?`,
    [req.params.id, gymId],
  );
  res.json(rows);
});

membershipPlansRouter.put('/:id/centers', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { center_ids } = req.body;
  if (!Array.isArray(center_ids)) return res.status(400).json({ error: 'center_ids must be an array' });
  try {
    await db.query('DELETE FROM membership_plan_centers WHERE membership_plan_id = ? AND gym_id = ?', [req.params.id, gymId]);
    for (const cid of center_ids) {
      await db.query(
        'INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)',
        [gymId, req.params.id, cid],
      );
    }
    const { rows } = await db.query(
      `SELECT mpc.center_id AS id, c.name
       FROM membership_plan_centers mpc
       JOIN centers c ON c.id = mpc.center_id
       WHERE mpc.membership_plan_id = ? AND mpc.gym_id = ?`,
      [req.params.id, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ─── Prices (kept from original) ──────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parsePriceBody(body: Record<string, unknown>): { price: number; from: string; to: string | null } | string {
  const price = body.price as string | number | null | undefined;
  const valid_from = body.valid_from as string | null | undefined;
  const valid_to = body.valid_to as string | null | undefined;
  const parsed = parseFloat(price as string);
  if (price == null || isNaN(parsed) || parsed < 0) return 'price must be a non-negative number';
  if (!valid_from || !DATE_RE.test(valid_from)) return 'valid_from is required (YYYY-MM-DD)';
  const to = valid_to == null || valid_to === '' ? null : valid_to;
  if (to !== null && !DATE_RE.test(to)) return 'valid_to must be a date (YYYY-MM-DD) or empty';
  if (to !== null && to < valid_from) return 'valid_to must be on or after valid_from';
  return { price: parsed, from: valid_from, to };
}

async function overlaps(planId: string | string[], from: string, to: string | null, excludeId?: string | string[]): Promise<boolean> {
  const params: (string | string[])[] = [planId, from];
  let sql = `SELECT 1 FROM membership_plan_prices
             WHERE membership_plan_id = ?
               AND (valid_to IS NULL OR valid_to >= ?)`;
  if (to !== null) { sql += ' AND valid_from <= ?'; params.push(to); }
  if (excludeId) { sql += ' AND id <> ?'; params.push(excludeId); }
  sql += ' LIMIT 1';
  const { rows } = await db.query(sql, params);
  return rows.length > 0;
}

membershipPlansRouter.get('/:id/prices', async (req, res) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { rows } = await db.query(
    'SELECT * FROM membership_plan_prices WHERE membership_plan_id = ? AND gym_id = ? ORDER BY valid_from ASC',
    [req.params.id, gymId],
  );
  res.json(rows);
});

membershipPlansRouter.post('/:id/prices', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const parsed = parsePriceBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  if (await overlaps(req.params.id, parsed.from, parsed.to)) {
    return res.status(400).json({ error: 'This validity window overlaps an existing price for this plan.' });
  }
  try {
    const { insertId } = await db.query(
      'INSERT INTO membership_plan_prices (membership_plan_id, gym_id, price, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, gymId, parsed.price, parsed.from, parsed.to],
    );
    const { rows } = await db.query('SELECT * FROM membership_plan_prices WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

membershipPlansRouter.put('/:id/prices/:priceId', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const parsed = parsePriceBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  if (await overlaps(req.params.id, parsed.from, parsed.to, req.params.priceId)) {
    return res.status(400).json({ error: 'This validity window overlaps an existing price for this plan.' });
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE membership_plan_prices SET price = ?, valid_from = ?, valid_to = ?
       WHERE id = ? AND membership_plan_id = ? AND gym_id = ?`,
      [parsed.price, parsed.from, parsed.to, req.params.priceId, req.params.id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Price not found' });
    const { rows } = await db.query('SELECT * FROM membership_plan_prices WHERE id = ?', [req.params.priceId]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

membershipPlansRouter.delete('/:id/prices/:priceId', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM membership_plan_prices WHERE id = ? AND membership_plan_id = ? AND gym_id = ?',
    [req.params.priceId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Price not found' });
  res.status(204).send();
});
