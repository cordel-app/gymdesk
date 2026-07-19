import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { resolveCenterId } from '../infra/centerContext';
import { recordAudit } from '../infra/audit';

const STATUSES = ['scheduled', 'cancelled', 'completed'] as const;

/**
 * Effective capacity: COALESCE(cs.max_capacity_override, ct.max_capacity).
 * This is what booking (P2.5) will compare confirmed bookings against.
 */
const SELECT = `
  SELECT cs.*,
         at.name AS class_type_name,
         at.max_capacity AS class_type_capacity,
         at.duration_minutes AS class_type_duration,
         COALESCE(cs.max_capacity_override, at.max_capacity) AS effective_capacity,
         r.name AS room_name
  FROM class_sessions cs
  JOIN activity_types at ON at.id = cs.activity_type_id
  LEFT JOIN rooms r ON r.id = cs.room_id
`;

export const classSessionsRouter = Router();

classSessionsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { from, to, status, center_id } = req.query as Record<string, string | undefined>;
  const where: string[] = ['cs.gym_id = ?', 'cs.deleted_at IS NULL'];
  const params: any[] = [gymId];
  if (from) { where.push('cs.starts_at >= ?'); params.push(from); }
  if (to)   { where.push('cs.starts_at <= ?'); params.push(to); }
  if (status && STATUSES.includes(status as any)) { where.push('cs.status = ?'); params.push(status); }
  if (center_id) { where.push('cs.center_id = ?'); params.push(center_id); }
  const { rows } = await db.query(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY cs.starts_at ASC`,
    params,
  );
  res.json(rows);
});

classSessionsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${SELECT} WHERE cs.id = ? AND cs.gym_id = ? AND cs.deleted_at IS NULL`, [req.params.id, gymId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Session not found' });
  res.json(rows[0]);
});

async function validateRefs(gymId: string, body: any, centerId: number) {
  if (body.activity_type_id) {
    const { rows } = await db.query(
      "SELECT id, status FROM activity_types WHERE id = ? AND gym_id = ?",
      [body.activity_type_id, gymId],
    );
    if (rows.length === 0) return 'Activity type not found';
    if (rows[0].status !== 'active') return 'Activity type is inactive';
  }
  if (body.trainer_membership_id) {
    const { rows } = await db.query(
      "SELECT id FROM gym_memberships WHERE id = ? AND gym_id = ? AND role = 'coach'",
      [body.trainer_membership_id, gymId],
    );
    if (rows.length === 0) return 'Trainer not found';
  }
  if (body.room_id) {
    const { rows } = await db.query(
      "SELECT id, status, center_id FROM rooms WHERE id = ? AND gym_id = ? AND deleted_at IS NULL",
      [body.room_id, gymId],
    );
    if (rows.length === 0) return 'Room not found';
    if (rows[0].status !== 'active') return 'Room is inactive';
    if (rows[0].center_id !== centerId) return 'Room does not belong to this session\'s center';
  }
  return null;
}

classSessionsRouter.post('/', requireRole('admin', 'coach', 'staff'), async (req, res, next) => {
  const { gymId, userId, gymMembershipId } = getTenantContext(req);
  const { activity_type_id, trainer_membership_id, room_id, starts_at, ends_at, max_capacity_override, center_id } = req.body;
  if (!activity_type_id || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'activity_type_id, starts_at and ends_at are required' });
  }
  if (new Date(starts_at) >= new Date(ends_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }

  const cap = max_capacity_override != null && max_capacity_override !== '' ? parseInt(max_capacity_override, 10) : null;
  if (cap !== null && (isNaN(cap) || cap <= 0)) {
    return res.status(400).json({ error: 'max_capacity_override must be a positive integer' });
  }

  try {
    const resolvedCenterId = await resolveCenterId(gymId, req, center_id);
    const err = await validateRefs(gymId, req.body, resolvedCenterId);
    if (err) return res.status(err.includes('inactive') || err.includes('center') ? 400 : 404).json({ error: err });

    const { insertId } = await db.query(
      `INSERT INTO class_sessions
       (gym_id, center_id, activity_type_id, trainer_membership_id, room_id, starts_at, ends_at, max_capacity_override, created_by, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, resolvedCenterId, activity_type_id, trainer_membership_id ?? null, room_id ?? null,
       new Date(starts_at), new Date(ends_at), cap, userId, gymMembershipId],
    );
    const { rows } = await db.query(`${SELECT} WHERE cs.id = ?`, [insertId]);
    recordAudit(req, { action: 'create', entityType: 'class_session', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

classSessionsRouter.put('/:id', requireRole('admin', 'coach', 'staff'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { trainer_membership_id, room_id, starts_at, ends_at, max_capacity_override } = req.body;
  if (starts_at && ends_at && new Date(starts_at) >= new Date(ends_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }

  try {
    const { rows: existingRows } = await db.query(
      'SELECT center_id FROM class_sessions WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [req.params.id, gymId],
    );
    if (existingRows.length === 0) return res.status(404).json({ error: 'Session not found' });

    const err = await validateRefs(gymId, req.body, existingRows[0].center_id);
    if (err) return res.status(err.includes('inactive') || err.includes('center') ? 400 : 404).json({ error: err });

    const { rowCount } = await db.query(
      `UPDATE class_sessions SET
        trainer_membership_id = IF(?, ?, trainer_membership_id),
        room_id               = IF(?, ?, room_id),
        starts_at             = COALESCE(?, starts_at),
        ends_at                = COALESCE(?, ends_at),
        max_capacity_override = IF(?, ?, max_capacity_override),
        modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ?`,
      [
        'trainer_membership_id' in req.body ? 1 : 0, trainer_membership_id ?? null,
        'room_id' in req.body ? 1 : 0, room_id ?? null,
        starts_at ? new Date(starts_at) : null,
        ends_at ? new Date(ends_at) : null,
        'max_capacity_override' in req.body ? 1 : 0,
        max_capacity_override != null && max_capacity_override !== '' ? parseInt(max_capacity_override, 10) : null,
        gymMembershipId,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Session not found' });
    const { rows } = await db.query(`${SELECT} WHERE cs.id = ? AND cs.gym_id = ?`, [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// P2.4: cancel is a status flip with a required reason — never a hard delete,
// so the session stays queryable for history and its bookings can cascade
// cancel (wired in P2.5).
classSessionsRouter.post('/:id/cancel', requireRole('admin', 'coach', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const reason = String(req.body?.cancellation_reason ?? '').trim();
  if (!reason) return res.status(400).json({ error: 'cancellation_reason is required' });
  const { rowCount } = await db.query(
    "UPDATE class_sessions SET status = 'cancelled', cancellation_reason = ? WHERE id = ? AND gym_id = ? AND status <> 'cancelled' AND deleted_at IS NULL",
    [reason, req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Session not found or already cancelled' });
  recordAudit(req, { action: 'cancel', entityType: 'class_session', entityId: req.params.id, next: { cancellation_reason: reason } });
  res.status(204).send();
});
