import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireRole, GymRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { insertAndFetch } from '../infra/db-helpers';

/**
 * P1.6 (#10): append-only billing ledger. GET + POST only — rows are never
 * updated or deleted. status_changed rows are system-emitted (see
 * recordStatusChange, called from the user-memberships router inside the
 * same transaction as the status flip) and cannot be posted manually.
 */

const POSTABLE_EVENT_TYPES = ['charge_created', 'payment_recorded', 'adjustment'] as const;
const SOURCES = ['admin', 'system', 'employee', 'customer', 'provider'] as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Ledger source implied by the acting staff role. */
export function sourceForRole(role: GymRole): string {
  return role === 'admin' ? 'admin' : 'employee';
}

export interface StatusChange {
  gymId: string;
  userMembershipId: number;
  memberId: number;
  previousStatus: string | null;
  newStatus: string;
  source: string;
  actorUserId: string | null;
}

/** Inserts a status_changed ledger row; call inside the transaction that flips the status. */
export async function recordStatusChange(tx: Tx, c: StatusChange): Promise<void> {
  await tx.query(
    `INSERT INTO billing_events
     (gym_id, user_membership_id, member_id, event_type, previous_status, new_status, source, actor_user_id)
     VALUES (?, ?, ?, 'status_changed', ?, ?, ?, ?)`,
    [c.gymId, c.userMembershipId, c.memberId, c.previousStatus, c.newStatus, c.source, c.actorUserId],
  );
}

export const billingEventsRouter = Router();

const LIST_SELECT = `
  SELECT be.*,
         m.name AS member_name,
         ct.code AS charge_type_code
  FROM billing_events be
  LEFT JOIN members m ON m.id = be.member_id
  LEFT JOIN charge_types ct ON ct.id = be.charge_type_id
`;

// Financial data — staff-level read, no coach/member access.
billingEventsRouter.get('/', requireRole('admin', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { member_id, user_membership_id, event_type, from, to } = req.query as Record<string, string | undefined>;

  const where: string[] = ['be.gym_id = ?'];
  const params: any[] = [gymId];
  if (member_id) { where.push('be.member_id = ?'); params.push(member_id); }
  if (user_membership_id) { where.push('be.user_membership_id = ?'); params.push(user_membership_id); }
  if (event_type) { where.push('be.event_type = ?'); params.push(event_type); }
  if (from) { where.push('be.created_at >= ?'); params.push(from.length === 10 ? `${from} 00:00:00` : from); }
  if (to) { where.push('be.created_at <= ?'); params.push(to.length === 10 ? `${to} 23:59:59` : to); }

  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);

  const whereSql = where.join(' AND ');
  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) AS total FROM billing_events be WHERE ${whereSql}`, params,
  );
  // limit/offset are validated integers — interpolated because mysql2
  // prepared statements don't accept placeholders in LIMIT reliably.
  const { rows } = await db.query(
    `${LIST_SELECT} WHERE ${whereSql} ORDER BY be.created_at DESC, be.id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
});

billingEventsRouter.post('/', requireRole('admin', 'staff'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const { event_type, member_id, user_membership_id, charge_type_id, amount, notes, source } = req.body;

  if (!POSTABLE_EVENT_TYPES.includes(event_type)) {
    return res.status(400).json({ error: `event_type must be one of: ${POSTABLE_EVENT_TYPES.join(', ')} (status_changed events are system-generated)` });
  }
  if (source && !SOURCES.includes(source)) {
    return res.status(400).json({ error: `source must be one of: ${SOURCES.join(', ')}` });
  }
  if (!member_id && !user_membership_id) {
    return res.status(400).json({ error: 'member_id or user_membership_id is required' });
  }

  const parsedAmount = amount != null && amount !== '' ? parseFloat(amount) : null;
  if (parsedAmount !== null && isNaN(parsedAmount)) {
    return res.status(400).json({ error: 'amount must be a number' });
  }
  if (event_type === 'payment_recorded' || event_type === 'charge_created') {
    if (parsedAmount === null || parsedAmount <= 0) {
      return res.status(400).json({ error: 'amount must be greater than 0' });
    }
    if (!charge_type_id) {
      return res.status(400).json({ error: 'charge_type_id is required' });
    }
  }
  if (event_type === 'adjustment' && (parsedAmount === null || parsedAmount === 0)) {
    return res.status(400).json({ error: 'amount is required and must be non-zero for adjustments' });
  }

  if (charge_type_id) {
    const { rows } = await db.query('SELECT id FROM charge_types WHERE id = ? AND active = TRUE', [charge_type_id]);
    if (rows.length === 0) return res.status(400).json({ error: 'Unknown or inactive charge type' });
  }

  // Resolve + gym-check the member/membership pair; derive member_id from the
  // membership when only the membership is given.
  let memberId: number | null = member_id ?? null;
  if (user_membership_id) {
    const { rows } = await db.query(
      'SELECT id, member_id FROM user_memberships WHERE id = ? AND gym_id = ?',
      [user_membership_id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Membership not found' });
    if (memberId && Number(memberId) !== rows[0].member_id) {
      return res.status(400).json({ error: 'member_id does not match the membership' });
    }
    memberId = rows[0].member_id;
  } else {
    const { rows } = await db.query('SELECT id FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Member not found' });
  }

  try {
    const row = await insertAndFetch(
      `INSERT INTO billing_events
       (gym_id, user_membership_id, member_id, event_type, charge_type_id, source, actor_user_id, amount, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gymId, user_membership_id ?? null, memberId, event_type, charge_type_id ?? null,
        source ?? sourceForRole(role), userId, parsedAmount,
        notes && String(notes).trim() ? String(notes).trim() : null,
      ],
      `${LIST_SELECT} WHERE be.id = ?`,
      (id) => [id],
    );
    recordAudit(req, { action: 'append', entityType: 'billing_event', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err: any) {
    next(err);
  }
});

// Append-only: no PUT/DELETE routes, by design (P1.6 #10).
