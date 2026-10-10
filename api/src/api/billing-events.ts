import { Router } from 'express';
import { eventAssignmentSql, eventsOfAssignmentParams, eventsOfAssignmentSql } from '../domain/billingEventOwnership';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite, GymRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { insertAndFetch } from '../infra/db-helpers';
import { activeProductSetIdForMember, productSetIdForAssignment } from './product-set-bridge';

/**
 * P1.6 (#10): append-only billing ledger. GET + POST only — rows are never
 * updated or deleted.
 *
 * #1325 PR 3 (A4): a membership status transition is **not a ledger row any
 * more**. `recordStatusChange()` writes the existing audit log (entity
 * `user_membership`, action `status_change`), so `billing_events` holds
 * financial events only and every one of them belongs to a ProductSet (the
 * one exception being a one-off purchase). The `status_changed` value stays in
 * the CHECK as history; nothing writes it.
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

/**
 * Records a membership status transition in the audit log; call inside the
 * transaction that flips the status, so the two land together. The row is the
 * same shape `recordAudit()` writes (`previous_values` / `new_values` carry the
 * status), keyed to the `user_membership` entity, with the actor the caller
 * knows — a nightly run or a webhook is `actor_user_id NULL`.
 */
export async function recordStatusChange(tx: Tx, c: StatusChange): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs
       (gym_id, actor_user_id, actor_name, action, entity_type, entity_id, entity_name,
        previous_values, new_values, source, ip, user_agent)
     VALUES (?, ?, NULL, 'status_change', 'user_membership', ?, NULL, ?, ?, ?, NULL, NULL)`,
    [
      c.gymId, c.actorUserId, String(c.userMembershipId),
      JSON.stringify({ status: c.previousStatus, member_id: c.memberId }),
      JSON.stringify({ status: c.newStatus, member_id: c.memberId }),
      c.source,
    ],
  );
}

export const billingEventsRouter = Router();

const LIST_SELECT = `
  SELECT be.*,
         ${eventAssignmentSql()} AS user_membership_id,
         m.name AS member_name,
         ct.code AS charge_type_code
  FROM billing_events be
  LEFT JOIN members m ON m.id = be.member_id
  LEFT JOIN charge_types ct ON ct.id = be.charge_type_id
`;

// Module-level read gate (requireModuleAccess('PAYMENTS')) is applied in app.ts.
billingEventsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { member_id, user_membership_id, event_type, from, to } = req.query as Record<string, string | undefined>;

  const where: string[] = ['be.gym_id = ?'];
  const params: any[] = [gymId];
  if (member_id) { where.push('be.member_id = ?'); params.push(member_id); }
  if (user_membership_id) { where.push(eventsOfAssignmentSql()); params.push(...eventsOfAssignmentParams(gymId, Number(user_membership_id))); }
  if (event_type) { where.push('be.event_type = ?'); params.push(event_type); }
  if (from) { const f = String(from); where.push('be.created_at >= ?'); params.push(f.length === 10 ? `${f} 00:00:00` : f); }
  if (to) { const t = String(to); where.push('be.created_at <= ?'); params.push(t.length === 10 ? `${t} 23:59:59` : t); }

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

billingEventsRouter.post('/', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
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
    // #1325 PR 3b: a money row belongs to a ProductSet.
    const setId = user_membership_id
      ? await productSetIdForAssignment(db, gymId, Number(user_membership_id))
      : await activeProductSetIdForMember(db, gymId, Number(memberId));
    if (setId == null) {
      return res.status(400).json({ error: 'This member has no ProductSet to record the event against' });
    }
    const row = await insertAndFetch(
      `INSERT INTO billing_events
       (gym_id, product_set_id, member_id, event_type, charge_type_id, source, actor_user_id, amount, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gymId, setId, memberId, event_type, charge_type_id ?? null,
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

// GET /billing-events/member/:memberId — convenience alias for the member history view.
billingEventsRouter.get('/member/:memberId', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const memberId = parseInt(String(req.params.memberId), 10);
  if (!memberId) return res.status(400).json({ error: 'Invalid memberId' });

  const { rows: memberRows } = await db.query('SELECT id FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId]);
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);

  const { rows: countRows } = await db.query(
    'SELECT COUNT(*) AS total FROM billing_events be WHERE be.gym_id = ? AND be.member_id = ?',
    [gymId, memberId],
  );
  const { rows } = await db.query(
    `${LIST_SELECT} WHERE be.gym_id = ? AND be.member_id = ? ORDER BY be.created_at DESC, be.id DESC LIMIT ${limit} OFFSET ${offset}`,
    [gymId, memberId],
  );
  res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
});

// Append-only: no PUT/DELETE routes, by design (P1.6 #10).
