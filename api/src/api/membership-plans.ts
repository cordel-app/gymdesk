import { Router, Request } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { gymFetchOne, handleDupEntry, insertAndFetch } from '../infra/db-helpers';
import { effectivePrice, LIST_SELECT as MEMBERSHIP_LIST_SELECT, MEMBERS_SELECT as MEMBERSHIP_MEMBERS_SELECT } from './user-memberships';
import { recordStatusChange, sourceForRole } from './billing-events';
import { applyPromotionToMembership } from './membership-promotions';

interface PlanRow {
  id: number;
  gym_id: string;
  name: string;
  description: string | null;
  lifecycle_status: string;
  enrollment_status: string;
  member_limit: '1' | '2' | 'family';
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

interface ChargeBenefitRow {
  id: number;
  gym_id: string;
  membership_plan_id: number;
  gym_charge_id: number;
  gym_charge_code: string;
  gym_charge_name: string;
  gym_charge_availability: string;
  action: string;
  value: string | null;
}

export const membershipPlansRouter = Router();

const VALID_MEMBER_LIMIT = ['1', '2', 'family'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getCallerMembershipId(req: Request): Promise<number | null> {
  const userId = req.auth?.userId;
  if (!userId) return null;
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT id FROM gym_memberships WHERE gym_id = ? AND user_id = ? LIMIT 1',
    [gymId, userId],
  );
  return rows.length > 0 ? rows[0].id : null;
}

async function enrichPlan(plan: PlanRow, gymId: string): Promise<object> {
  const [prices, bpRows, allowances, centers, memberCount, chargeBenefits] = await Promise.all([
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
    db.query<ChargeBenefitRow>(
      `SELECT pcb.*, ct.code AS gym_charge_code, COALESCE(gc.name, ct.name) AS gym_charge_name,
              gc.status AS gym_charge_status
       FROM plan_charge_benefits pcb
       JOIN gym_charges gc ON gc.id = pcb.gym_charge_id
       LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
       WHERE pcb.membership_plan_id = ? AND pcb.gym_id = ?`,
      [plan.id, gymId],
    ).then(r => r.rows),
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
    charge_benefits: chargeBenefits,
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
  const { name, description, lifecycle_status, enrollment_status, member_limit } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (member_limit !== undefined && !VALID_MEMBER_LIMIT.includes(member_limit)) {
    return res.status(400).json({ error: 'member_limit must be one of: 1, 2, family' });
  }
  const callerMemberId = await getCallerMembershipId(req);
  try {
    const row = await insertAndFetch(
      `INSERT INTO membership_plans
       (gym_id, name, description, lifecycle_status, enrollment_status, member_limit, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [gymId, name.trim(), description ?? null,
       lifecycle_status ?? 'draft', enrollment_status ?? 'staff_only', member_limit ?? '1', callerMemberId],
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
  const { name, description, lifecycle_status, enrollment_status, member_limit } = req.body;

  const VALID_LIFECYCLE = ['draft', 'active', 'paused', 'inactive'];
  const VALID_ENROLLMENT = ['public', 'staff_only'];
  if (lifecycle_status && !VALID_LIFECYCLE.includes(lifecycle_status)) {
    return res.status(400).json({ error: 'Invalid lifecycle_status' });
  }
  if (enrollment_status && !VALID_ENROLLMENT.includes(enrollment_status)) {
    return res.status(400).json({ error: 'Invalid enrollment_status' });
  }
  if (['public', 'staff_only'].includes(enrollment_status) && lifecycle_status && lifecycle_status !== 'active') {
    return res.status(400).json({ error: 'enrollment can only be public or staff_only when lifecycle_status is active' });
  }
  if (member_limit !== undefined && !VALID_MEMBER_LIMIT.includes(member_limit)) {
    return res.status(400).json({ error: 'member_limit must be one of: 1, 2, family' });
  }
  // Shrinking the cap must not orphan Members already covered by an active
  // Membership on this plan (#374 — the limit is enforced server-side).
  if (member_limit && member_limit !== 'family') {
    const cap = parseInt(member_limit, 10);
    const { rows: over } = await db.query(
      `SELECT COUNT(*) AS n FROM (
         SELECT umm.user_membership_id
         FROM user_membership_members umm
         JOIN user_memberships um ON um.id = umm.user_membership_id AND um.status = 'active'
         WHERE um.membership_plan_id = ? AND um.gym_id = ?
         GROUP BY umm.user_membership_id
         HAVING COUNT(*) > ?
       ) over_limit`,
      [req.params.id, gymId, cap],
    );
    if (Number(over[0].n) > 0) {
      return res.status(400).json({ error: 'Cannot reduce the member limit below the covered Members of an existing active Membership.' });
    }
  }

  const callerMemberId = await getCallerMembershipId(req);
  try {
    const { rowCount } = await db.query(
      `UPDATE membership_plans SET
        name              = COALESCE(?, name),
        description       = IF(?, ?, description),
        lifecycle_status  = COALESCE(?, lifecycle_status),
        enrollment_status = COALESCE(?, enrollment_status),
        member_limit      = COALESCE(?, member_limit),
        modified_at       = NOW(),
        modified_by       = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        lifecycle_status ?? null,
        enrollment_status ?? null,
        member_limit ?? null,
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
  const { gymId, actorName } = getTenantContext(req);
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
    `UPDATE membership_plans SET deleted_at = NOW(), deleted_by = ?, deleted_by_name = ?, enrollment_status = 'staff_only'
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [callerMemberId, actorName, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Plan not found' });
  recordAudit(req, { action: 'delete', entityType: 'membership_plan', entityId: req.params.id });
  res.status(204).send();
});

// ─── Assign to Member(s) (#376) ────────────────────────────────────────────────
// Instantiates the Plan into a new Membership for one or more existing
// Members, snapshotting the Plan's current charge benefits onto the
// Membership (so later Plan edits never retroactively change it), applying
// any Promotions currently targeting the Plan, and emitting the same
// creation billing event as POST /user-memberships (P1.6 ledger).

membershipPlansRouter.post('/:id/assign', requireRole('admin'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const { member_ids, owner_member_id, starts_at } = req.body;

  const { rows: planRows } = await db.query(
    'SELECT id, member_limit FROM membership_plans WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (planRows.length === 0) return res.status(404).json({ error: 'Plan not found' });
  const plan = planRows[0];

  if (!Array.isArray(member_ids) || member_ids.length === 0) {
    return res.status(400).json({ error: 'member_ids must be a non-empty array' });
  }
  if (!starts_at) return res.status(400).json({ error: 'starts_at is required' });
  const uniqueMemberIds = [...new Set(member_ids.map((id: any) => Number(id)))];
  const ownerId = Number(owner_member_id);
  if (!owner_member_id || !uniqueMemberIds.includes(ownerId)) {
    return res.status(400).json({ error: 'owner_member_id must be one of the selected member_ids' });
  }
  if (plan.member_limit !== 'family' && uniqueMemberIds.length !== parseInt(plan.member_limit, 10)) {
    return res.status(400).json({ error: `This plan requires exactly ${plan.member_limit} member(s).` });
  }

  const placeholders = uniqueMemberIds.map(() => '?').join(',');
  const { rows: memberRows } = await db.query(
    `SELECT id FROM members WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
    [gymId, ...uniqueMemberIds],
  );
  if (memberRows.length !== uniqueMemberIds.length) {
    return res.status(400).json({ error: 'One or more selected members were not found.' });
  }

  const eff = await effectivePrice(Number(req.params.id), gymId, starts_at);
  if (!eff) return res.status(404).json({ error: 'Plan not found' });

  try {
    const insertId: number = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO user_memberships
         (member_id, gym_id, membership_plan_id, base_price, plan_price_id, final_price, starts_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
        [ownerId, gymId, req.params.id, eff.base_price, eff.plan_price_id, eff.price, starts_at],
      );
      await recordStatusChange(tx, {
        gymId, userMembershipId: insertId, memberId: ownerId,
        previousStatus: null, newStatus: 'active',
        source: sourceForRole(role), actorUserId: userId,
      });
      for (const memberId of uniqueMemberIds) {
        await tx.query(
          'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, ?)',
          [gymId, insertId, memberId, memberId === ownerId ? 1 : 0],
        );
      }
      // Snapshot the Plan's current charge benefits onto the Membership (#376 item 6/9).
      const { rows: benefits } = await tx.query(
        "SELECT gym_charge_id, action, value FROM plan_charge_benefits WHERE membership_plan_id = ? AND gym_id = ? AND action <> 'no_benefit'",
        [req.params.id, gymId],
      );
      for (const b of benefits) {
        await tx.query(
          'INSERT INTO user_membership_charge_benefits (gym_id, user_membership_id, gym_charge_id, action, value) VALUES (?, ?, ?, ?, ?)',
          [gymId, insertId, b.gym_charge_id, b.action, b.value],
        );
      }
      return insertId;
    });

    // Auto-apply any Promotion currently targeting this Plan (#376 item 7/8) — best
    // effort per promotion: a non-stackable conflict must not fail the assignment.
    const { rows: promoRows } = await db.query(
      `SELECT p.id FROM promotions p
       JOIN promotion_membership_plans pmp ON pmp.promotion_id = p.id
       WHERE pmp.membership_plan_id = ? AND p.gym_id = ? AND p.lifecycle_status = 'active'
         AND p.starts_at <= UTC_TIMESTAMP() AND p.ends_at >= UTC_TIMESTAMP()`,
      [req.params.id, gymId],
    );
    for (const promo of promoRows) {
      try {
        await applyPromotionToMembership(gymId, userId, sourceForRole(role), insertId, promo.id);
      } catch {
        // Not stackable with one already applied, or otherwise inapplicable — skip it.
      }
    }

    const { rows } = await db.query(`${MEMBERSHIP_LIST_SELECT} WHERE um.id = ?`, [insertId]);
    const { rows: coveredMembers } = await db.query(MEMBERSHIP_MEMBERS_SELECT, [insertId, gymId]);
    recordAudit(req, { action: 'assign_plan', entityType: 'user_membership', entityId: insertId, next: rows[0] });
    res.status(201).json({ ...rows[0], members: coveredMembers });
  } catch (err: any) {
    handleDupEntry(err, res, next, 'One of the selected members already has an active membership.');
  }
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
    const newPlanId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO membership_plans
         (gym_id, name, description, lifecycle_status, enrollment_status, member_limit, created_by)
         VALUES (?, ?, ?, 'draft', 'staff_only', ?, ?)`,
        [gymId, `${orig.name} (Copy)`, orig.description ?? null, orig.member_limit, callerMemberId],
      );

      // Copy billing policy
      const { rows: bp } = await tx.query(
        'SELECT * FROM billing_policies WHERE membership_plan_id = ? AND gym_id = ?',
        [req.params.id, gymId],
      );
      if (bp.length > 0) {
        const b = bp[0];
        await tx.query(
          `INSERT INTO billing_policies
           (gym_id, membership_plan_id, initial_billing_interval, initial_billing_unit,
            recurring_billing_interval, recurring_billing_unit,
            initial_service_interval, initial_service_unit,
            recurring_service_interval, recurring_service_unit, auto_renew)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [gymId, insertId, b.initial_billing_interval, b.initial_billing_unit,
           b.recurring_billing_interval, b.recurring_billing_unit,
           b.initial_service_interval, b.initial_service_unit,
           b.recurring_service_interval, b.recurring_service_unit, b.auto_renew],
        );
      }

      // Copy prices
      const { rows: prices } = await tx.query(
        'SELECT * FROM membership_plan_prices WHERE membership_plan_id = ? AND gym_id = ?',
        [req.params.id, gymId],
      );
      for (const p of prices) {
        await tx.query(
          'INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)',
          [gymId, insertId, p.price, p.valid_from, p.valid_to],
        );
      }

      // Copy allowances
      const { rows: allowances } = await tx.query(
        'SELECT * FROM plan_allowances WHERE membership_plan_id = ? AND gym_id = ?',
        [req.params.id, gymId],
      );
      for (const a of allowances) {
        await tx.query(
          `INSERT INTO plan_allowances
           (gym_id, membership_plan_id, activity_type_id, allowance_type, session_count, recurrence_interval, recurrence_unit)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [gymId, insertId, a.activity_type_id, a.allowance_type, a.session_count, a.recurrence_interval, a.recurrence_unit],
        );
      }

      // Copy centers
      const { rows: centers } = await tx.query(
        'SELECT * FROM membership_plan_centers WHERE membership_plan_id = ? AND gym_id = ?',
        [req.params.id, gymId],
      );
      for (const c of centers) {
        await tx.query(
          'INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)',
          [gymId, insertId, c.center_id],
        );
      }

      // Copy charge benefits
      const { rows: cbs } = await tx.query(
        'SELECT * FROM plan_charge_benefits WHERE membership_plan_id = ? AND gym_id = ?',
        [req.params.id, gymId],
      );
      for (const cb of cbs) {
        await tx.query(
          'INSERT INTO plan_charge_benefits (gym_id, membership_plan_id, gym_charge_id, action, value) VALUES (?, ?, ?, ?, ?)',
          [gymId, insertId, cb.gym_charge_id, cb.action, cb.value],
        );
      }

      return insertId;
    });

    const { rows } = await db.query('SELECT * FROM membership_plans WHERE id = ?', [newPlanId]);
    res.status(201).json(await enrichPlan(rows[0], gymId));
  } catch (err) {
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
    return res.status(400).json({ error: 'Cannot deactivate a plan with active memberships.' });
  }
  const callerMemberId = await getCallerMembershipId(req);
  const { rowCount } = await db.query(
    `UPDATE membership_plans
     SET lifecycle_status = 'inactive', enrollment_status = 'staff_only', modified_at = NOW(), modified_by = ?
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
  if (!['public', 'staff_only'].includes(enrollment_status)) {
    return res.status(400).json({ error: 'enrollment_status must be public or staff_only' });
  }
  const { rows: plan } = await db.query(
    'SELECT lifecycle_status FROM membership_plans WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (plan.length === 0) return res.status(404).json({ error: 'Plan not found' });
  if (['public', 'staff_only'].includes(enrollment_status) && plan[0].lifecycle_status !== 'active') {
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

// ─── Charge Benefits ──────────────────────────────────────────────────────────

membershipPlansRouter.get('/:id/charge-benefits', async (req, res) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { rows } = await db.query<ChargeBenefitRow>(
    `SELECT pcb.*, ct.code AS gym_charge_code, ct.name AS gym_charge_name,
            gc.availability AS gym_charge_availability
     FROM plan_charge_benefits pcb
     JOIN gym_charges gc ON gc.id = pcb.gym_charge_id
     JOIN charge_types ct ON ct.id = gc.charge_type_id
     WHERE pcb.membership_plan_id = ? AND pcb.gym_id = ?`,
    [req.params.id, gymId],
  );
  res.json(rows);
});

const VALID_CB_ACTIONS = ['no_benefit', 'waive', 'percentage_discount', 'fixed_discount'];

membershipPlansRouter.put('/:id/charge-benefits', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'body must be an array' });

  for (const item of items) {
    if (!item.gym_charge_id || !VALID_CB_ACTIONS.includes(item.action)) {
      return res.status(400).json({ error: 'Each item requires gym_charge_id and a valid action' });
    }
    if (['percentage_discount', 'fixed_discount'].includes(item.action) && item.value == null) {
      return res.status(400).json({ error: `action ${item.action} requires a value` });
    }
  }

  if (items.length > 0) {
    const ids = items.map((i: any) => i.gym_charge_id);
    const placeholders = ids.map(() => '?').join(',');
    const { rows: gcRows } = await db.query(
      `SELECT id FROM gym_charges WHERE gym_id = ? AND status = 'active' AND deleted_at IS NULL AND id IN (${placeholders})`,
      [gymId, ...ids],
    );
    if (gcRows.length !== ids.length) {
      return res.status(400).json({ error: 'One or more gym_charge_id values not found or not available in this gym' });
    }
  }

  try {
    await db.query(
      'DELETE FROM plan_charge_benefits WHERE membership_plan_id = ? AND gym_id = ?',
      [req.params.id, gymId],
    );
    for (const item of items) {
      const value = ['no_benefit', 'waive'].includes(item.action) ? null : parseFloat(item.value);
      await db.query(
        'INSERT INTO plan_charge_benefits (gym_id, membership_plan_id, gym_charge_id, action, value) VALUES (?, ?, ?, ?, ?)',
        [gymId, req.params.id, item.gym_charge_id, item.action, value ?? null],
      );
    }
    const { rows } = await db.query<ChargeBenefitRow>(
      `SELECT pcb.*, ct.code AS gym_charge_code, COALESCE(gc.name, ct.name) AS gym_charge_name,
              gc.status AS gym_charge_status
       FROM plan_charge_benefits pcb
       JOIN gym_charges gc ON gc.id = pcb.gym_charge_id
       LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
       WHERE pcb.membership_plan_id = ? AND pcb.gym_id = ?`,
      [req.params.id, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
