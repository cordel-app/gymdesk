import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole, requireModuleWrite } from '../infra/tenantContext';
import { parseQuery, z } from '../infra/validate';
import { recordStatusChange, sourceForRole } from './billing-events';
import { recordAudit } from '../infra/audit';
import { handleDupEntry } from '../infra/db-helpers';

const STATUSES = ['active', 'paused', 'cancelled', 'expired'] as const;
type Status = (typeof STATUSES)[number];

// Lifecycle statuses (#410) — the date-aware projection computed in LIST_SELECT below,
// as opposed to STATUSES which is the raw stored `status` column.
const LIFECYCLE_STATUSES = ['pending', 'active', 'paused', 'expired', 'cancelled'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Accepts repeated `lifecycle_status=a&lifecycle_status=b` or a single comma-separated value.
const lifecycleStatusParam = z.preprocess((v) => {
  if (v === undefined) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr.flatMap((s) => String(s).split(',').map((x) => x.trim())).filter(Boolean);
}, z.array(z.enum(LIFECYCLE_STATUSES)).optional());

export const userMembershipsRouter = Router();

// List joined to member + plan for display (rows returned by SELECT * plus display names).
//
// lifecycle_status (#410) is a read-only, date-aware projection of the stored
// `status` column for reporting/display — it never overrides `status` in the
// database or in the business logic elsewhere in this file. A future start
// date reads as 'pending' and a past end date on an otherwise-active row
// reads as 'expired', without requiring a cron job to flip `status` itself.
export const LIST_SELECT = `
  SELECT um.*,
         m.name AS member_name,
         m.email AS member_email,
         p.name AS plan_name,
         p.member_limit AS plan_member_limit,
         CASE
           WHEN um.status IN ('paused', 'cancelled', 'expired') THEN um.status
           WHEN um.starts_at > CURDATE() THEN 'pending'
           WHEN um.ends_at IS NOT NULL AND um.ends_at < CURDATE() THEN 'expired'
           ELSE 'active'
         END AS lifecycle_status
  FROM user_memberships um
  JOIN members m ON m.id = um.member_id
  LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
`;
// Note: um.* already includes next_billing_date and last_billed_at (added in migration 111).

// '1' | '2' -> that many covered Members; 'family' -> unlimited (#374).
function memberLimitCount(limit: string | null | undefined): number {
  if (limit === 'family') return Infinity;
  return parseInt(limit ?? '1', 10);
}

// Filters (#411 — Assigned Plans advanced filtering):
//   - status: raw stored `status` column (unchanged, backward-compatible single value).
//   - lifecycle_status: the computed lifecycle_status column, multi-select (includes 'pending',
//     which has no equivalent in the raw `status` column — hence the separate param).
//   - member_id: unchanged.
//   - start_date/end_date: date-range overlap against starts_at/ends_at.
userMembershipsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const q = parseQuery(req, res, z.object({
    status: z.enum(STATUSES).optional(),
    lifecycle_status: lifecycleStatusParam,
    member_id: z.coerce.number().int().positive().optional(),
    start_date: z.string().regex(DATE_RE, 'start_date must be YYYY-MM-DD').optional(),
    end_date: z.string().regex(DATE_RE, 'end_date must be YYYY-MM-DD').optional(),
  }));
  if (!q) return;

  const params: any[] = [gymId];
  let inner = `${LIST_SELECT} WHERE um.gym_id = ?`;
  if (q.status) { inner += ' AND um.status = ?'; params.push(q.status); }
  if (q.member_id !== undefined) { inner += ' AND um.member_id = ?'; params.push(q.member_id); }
  if (q.start_date) { inner += ' AND (um.ends_at IS NULL OR um.ends_at >= ?)'; params.push(q.start_date); }
  if (q.end_date) { inner += ' AND um.starts_at <= ?'; params.push(q.end_date); }

  // lifecycle_status is a SELECT-list alias (a CASE expression), so it's filtered via an
  // outer query over a derived table rather than reusing it directly in the inner WHERE.
  let sql = `SELECT * FROM (${inner}) ap`;
  if (q.lifecycle_status && q.lifecycle_status.length > 0) {
    sql += ` WHERE ap.lifecycle_status IN (${q.lifecycle_status.map(() => '?').join(',')})`;
    params.push(...q.lifecycle_status);
  }
  sql += ' ORDER BY ap.starts_at DESC';

  const { rows } = await db.query(sql, params);
  res.json(rows);
});

userMembershipsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${LIST_SELECT} WHERE um.id = ? AND um.gym_id = ?`, [req.params.id, gymId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Membership not found' });
  res.json(rows[0]);
});

// Returns the price + plan_price_id that applies to `date` for a plan; falls
// back to the plan's base_price (with plan_price_id NULL) if no window matches.
export async function effectivePrice(planId: number, gymId: string, date: string):
  Promise<{ price: number; plan_price_id: number | null; base_price: number } | null>
{
  const { rows: planRows } = await db.query(
    'SELECT id FROM membership_plans WHERE id = ? AND gym_id = ?',
    [planId, gymId],
  );
  if (planRows.length === 0) return null;

  const { rows: priceRows } = await db.query(
    `SELECT id, price FROM membership_plan_prices
     WHERE membership_plan_id = ? AND gym_id = ?
       AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
     ORDER BY valid_from DESC LIMIT 1`,
    [planId, gymId, date, date],
  );
  // membership_plans.base_price was dropped in migration 058 — membership_plan_prices
  // is the sole source of truth for pricing now. Fall back to 0 when no price window matches.
  const base_price = 0;
  if (priceRows.length > 0) {
    return { price: Number(priceRows[0].price), plan_price_id: priceRows[0].id, base_price };
  }
  return { price: base_price, plan_price_id: null, base_price };
}

userMembershipsRouter.post('/', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { member_id, membership_plan_id, starts_at, ends_at, final_price, discount_reason, discount_expires_at } = req.body;
  if (!member_id || !membership_plan_id || !starts_at) {
    return res.status(400).json({ error: 'member_id, membership_plan_id and starts_at are required' });
  }

  const { rows: memberRows } = await db.query('SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL', [member_id, gymId]);
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  const eff = await effectivePrice(Number(membership_plan_id), gymId, starts_at);
  if (!eff) return res.status(404).json({ error: 'Plan not found' });

  // Snapshot: base_price + plan_price_id reference the price at signup; final_price
  // can be overridden (discount) but requires a reason.
  const finalOverride = final_price != null && final_price !== '';
  const parsedFinal = finalOverride ? parseFloat(final_price) : eff.price;
  if (finalOverride) {
    if (isNaN(parsedFinal) || parsedFinal < 0) return res.status(400).json({ error: 'final_price must be a non-negative number' });
    if (!discount_reason || !String(discount_reason).trim()) {
      return res.status(400).json({ error: 'discount_reason is required when final_price differs from the effective price' });
    }
  }

  try {
    const { userId, role } = getTenantContext(req);
    // Ledger row (P1.6): membership creation is a NULL -> active transition,
    // written in the same transaction as the insert.
    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO user_memberships
         (member_id, gym_id, membership_plan_id, base_price, plan_price_id, final_price,
          discount_reason, discount_expires_at, starts_at, ends_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          member_id, gymId, membership_plan_id,
          eff.base_price, eff.plan_price_id, parsedFinal,
          finalOverride ? String(discount_reason).trim() : null,
          discount_expires_at || null,
          starts_at, ends_at ?? null,
        ],
      );
      await recordStatusChange(tx, {
        gymId, userMembershipId: insertId, memberId: Number(member_id),
        previousStatus: null, newStatus: 'active',
        source: sourceForRole(role), actorUserId: userId,
      });
      // The paying Member is always the Membership's owner and its first covered Member (#374).
      await tx.query(
        'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)',
        [gymId, insertId, member_id],
      );
      return insertId;
    });
    const { rows } = await db.query(`${LIST_SELECT} WHERE um.id = ?`, [insertId]);
    recordAudit(req, { action: 'create', entityType: 'user_membership', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'This member already has an active membership.');
  }
});

// Update lifecycle fields (dates, status, discount). Staff can pause/reactivate;
// only admin can cancel (see DELETE) but staff can flip status through 'active' or 'paused'.
userMembershipsRouter.put('/:id', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { starts_at, ends_at, status, final_price, discount_reason, discount_expires_at } = req.body;
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  // Cancellations go through DELETE; guard here so staff can't cancel by PUT.
  const role = (req as any).tenantCtx?.role;
  if (status === 'cancelled' && role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can cancel a membership' });
  }
  const parsedFinal = final_price != null && final_price !== '' ? parseFloat(final_price) : null;
  if (parsedFinal !== null && (isNaN(parsedFinal) || parsedFinal < 0)) {
    return res.status(400).json({ error: 'final_price must be a non-negative number' });
  }
  try {
    const { userId } = getTenantContext(req);
    // Ledger row (P1.6): status flips emit status_changed in the same
    // transaction as the update. FOR UPDATE pins the previous status.
    const found = await db.transaction(async (tx) => {
      const { rows: current } = await tx.query(
        'SELECT id, member_id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
        [req.params.id, gymId],
      );
      if (current.length === 0) return false;
      await tx.query(
        `UPDATE user_memberships SET
          starts_at            = COALESCE(?, starts_at),
          ends_at              = IF(?, ?, ends_at),
          status               = COALESCE(?, status),
          final_price          = COALESCE(?, final_price),
          discount_reason      = IF(?, ?, discount_reason),
          discount_expires_at  = IF(?, ?, discount_expires_at)
         WHERE id = ? AND gym_id = ?`,
        [
          starts_at ?? null,
          'ends_at' in req.body ? 1 : 0, ends_at ?? null,
          status ?? null,
          parsedFinal,
          'discount_reason' in req.body ? 1 : 0, discount_reason ?? null,
          'discount_expires_at' in req.body ? 1 : 0, discount_expires_at ?? null,
          req.params.id, gymId,
        ],
      );
      if (status && status !== current[0].status) {
        await recordStatusChange(tx, {
          gymId, userMembershipId: current[0].id, memberId: current[0].member_id,
          previousStatus: current[0].status, newStatus: status,
          source: sourceForRole(role), actorUserId: userId,
        });
      }
      return true;
    });
    if (!found) return res.status(404).json({ error: 'Membership not found' });
    const { rows } = await db.query(`${LIST_SELECT} WHERE um.id = ? AND um.gym_id = ?`, [req.params.id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'user_membership', entityId: req.params.id, next: rows[0] });
    res.json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'This member already has an active membership.');
  }
});

// Cancel = admin-only status flip (soft; the row stays for history).
userMembershipsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId, userId, role } = getTenantContext(req);
  // Ledger row (P1.6): cancellation emits status_changed in the same transaction.
  const found = await db.transaction(async (tx) => {
    const { rows: current } = await tx.query(
      "SELECT id, member_id, status FROM user_memberships WHERE id = ? AND gym_id = ? AND status <> 'cancelled' FOR UPDATE",
      [req.params.id, gymId],
    );
    if (current.length === 0) return false;
    await tx.query(
      "UPDATE user_memberships SET status = 'cancelled' WHERE id = ? AND gym_id = ?",
      [req.params.id, gymId],
    );
    await recordStatusChange(tx, {
      gymId, userMembershipId: current[0].id, memberId: current[0].member_id,
      previousStatus: current[0].status, newStatus: 'cancelled',
      source: sourceForRole(role), actorUserId: userId,
    });
    return true;
  });
  if (!found) return res.status(404).json({ error: 'Membership not found or already cancelled' });
  recordAudit(req, { action: 'cancel', entityType: 'user_membership', entityId: req.params.id });
  res.status(204).send();
});

// ─── Covered Members (#374 — multi-member Membership Plans) ───────────────────
// A Membership's covered Members receive the plan's benefits/entitlements
// alongside its owner. The owner (inserted on POST /) can never be removed;
// additional Members are capped by the plan's member_limit ('1' | '2' | 'family').

export const MEMBERS_SELECT = `
  SELECT umm.member_id, umm.is_owner, m.name, m.email
  FROM user_membership_members umm
  JOIN members m ON m.id = umm.member_id
  WHERE umm.user_membership_id = ? AND umm.gym_id = ?
  ORDER BY umm.is_owner DESC, m.name ASC
`;

async function findMembershipWithPlanLimit(id: string | string[], gymId: string) {
  const { rows } = await db.query(
    `SELECT um.id, p.member_limit FROM user_memberships um
     LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
     WHERE um.id = ? AND um.gym_id = ?`,
    [id, gymId],
  );
  return rows[0] ?? null;
}

userMembershipsRouter.get('/:id/members', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const membership = await findMembershipWithPlanLimit(req.params.id, gymId);
  if (!membership) return res.status(404).json({ error: 'Membership not found' });
  const { rows } = await db.query(MEMBERS_SELECT, [req.params.id, gymId]);
  res.json({ member_limit: membership.member_limit ?? '1', members: rows });
});

userMembershipsRouter.post('/:id/members', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { member_id } = req.body;
  if (!member_id) return res.status(400).json({ error: 'member_id is required' });

  const membership = await findMembershipWithPlanLimit(req.params.id, gymId);
  if (!membership) return res.status(404).json({ error: 'Membership not found' });

  const { rows: memberRows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [member_id, gymId],
  );
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  const { rows: countRows } = await db.query(
    'SELECT COUNT(*) AS n FROM user_membership_members WHERE user_membership_id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if (Number(countRows[0].n) >= memberLimitCount(membership.member_limit)) {
    return res.status(400).json({ error: 'This membership has reached its member limit.' });
  }

  try {
    await db.query(
      'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 0)',
      [gymId, req.params.id, member_id],
    );
    const { rows } = await db.query(MEMBERS_SELECT, [req.params.id, gymId]);
    recordAudit(req, { action: 'add_member', entityType: 'user_membership', entityId: req.params.id, next: { member_id } });
    res.status(201).json(rows);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'This Member is already covered by this Membership.');
  }
});

userMembershipsRouter.delete('/:id/members/:memberId', requireModuleWrite('PAYMENTS'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT is_owner FROM user_membership_members WHERE user_membership_id = ? AND member_id = ? AND gym_id = ?',
    [req.params.id, req.params.memberId, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'This Member is not covered by this Membership.' });
  if (rows[0].is_owner) return res.status(400).json({ error: 'Cannot remove the Membership owner.' });
  await db.query(
    'DELETE FROM user_membership_members WHERE user_membership_id = ? AND member_id = ? AND gym_id = ?',
    [req.params.id, req.params.memberId, gymId],
  );
  recordAudit(req, { action: 'remove_member', entityType: 'user_membership', entityId: req.params.id, previous: { member_id: req.params.memberId } });
  res.status(204).send();
});
