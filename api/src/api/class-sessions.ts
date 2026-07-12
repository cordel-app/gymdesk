import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

const STATUSES = ['scheduled', 'cancelled', 'completed'] as const;

/**
 * Effective capacity: COALESCE(cs.max_capacity_override, ct.max_capacity).
 * This is what booking (P2.5) will compare confirmed bookings against.
 */
const SELECT = `
  SELECT cs.*,
         ct.name AS class_type_name,
         ct.max_capacity AS class_type_capacity,
         ct.duration_minutes AS class_type_duration,
         COALESCE(cs.max_capacity_override, ct.max_capacity) AS effective_capacity,
         r.name AS room_name
  FROM class_sessions cs
  JOIN class_types ct ON ct.id = cs.class_type_id
  LEFT JOIN rooms r ON r.id = cs.room_id
`;

export const classSessionsRouter = Router();

classSessionsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { from, to, status } = req.query as Record<string, string | undefined>;
  const where: string[] = ['cs.gym_id = ?'];
  const params: any[] = [gymId];
  if (from) { where.push('cs.starts_at >= ?'); params.push(from); }
  if (to)   { where.push('cs.starts_at <= ?'); params.push(to); }
  if (status && STATUSES.includes(status as any)) { where.push('cs.status = ?'); params.push(status); }
  const { rows } = await db.query(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY cs.starts_at ASC`,
    params,
  );
  res.json(rows);
});

classSessionsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${SELECT} WHERE cs.id = ? AND cs.gym_id = ?`, [req.params.id, gymId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Session not found' });
  res.json(rows[0]);
});

async function validateRefs(gymId: string, body: any) {
  if (body.class_type_id) {
    const { rows } = await db.query(
      "SELECT id, status FROM class_types WHERE id = ? AND gym_id = ?",
      [body.class_type_id, gymId],
    );
    if (rows.length === 0) return 'Class type not found';
    if (rows[0].status !== 'active') return 'Class type is inactive';
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
      "SELECT id, status FROM rooms WHERE id = ? AND gym_id = ?",
      [body.room_id, gymId],
    );
    if (rows.length === 0) return 'Room not found';
    if (rows[0].status !== 'active') return 'Room is inactive';
  }
  return null;
}

classSessionsRouter.post('/', requireRole('admin', 'coach', 'staff'), async (req, res, next) => {
  const { gymId, userId } = getTenantContext(req);
  const { class_type_id, trainer_membership_id, room_id, starts_at, ends_at, max_capacity_override } = req.body;
  if (!class_type_id || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'class_type_id, starts_at and ends_at are required' });
  }
  if (new Date(starts_at) >= new Date(ends_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }
  const err = await validateRefs(gymId, req.body);
  if (err) return res.status(err.includes('inactive') ? 400 : 404).json({ error: err });

  const cap = max_capacity_override != null && max_capacity_override !== '' ? parseInt(max_capacity_override, 10) : null;
  if (cap !== null && (isNaN(cap) || cap <= 0)) {
    return res.status(400).json({ error: 'max_capacity_override must be a positive integer' });
  }

  try {
    const { insertId } = await db.query(
      `INSERT INTO class_sessions
       (gym_id, class_type_id, trainer_membership_id, room_id, starts_at, ends_at, max_capacity_override, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, class_type_id, trainer_membership_id ?? null, room_id ?? null,
       new Date(starts_at), new Date(ends_at), cap, userId],
    );
    const { rows } = await db.query(`${SELECT} WHERE cs.id = ?`, [insertId]);
    recordAudit(req, { action: 'create', entityType: 'class_session', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

classSessionsRouter.put('/:id', requireRole('admin', 'coach', 'staff'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { trainer_membership_id, room_id, starts_at, ends_at, max_capacity_override } = req.body;
  if (starts_at && ends_at && new Date(starts_at) >= new Date(ends_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }
  const err = await validateRefs(gymId, req.body);
  if (err) return res.status(err.includes('inactive') ? 400 : 404).json({ error: err });

  try {
    const { rowCount } = await db.query(
      `UPDATE class_sessions SET
        trainer_membership_id = IF(?, ?, trainer_membership_id),
        room_id               = IF(?, ?, room_id),
        starts_at             = COALESCE(?, starts_at),
        ends_at               = COALESCE(?, ends_at),
        max_capacity_override = IF(?, ?, max_capacity_override)
       WHERE id = ? AND gym_id = ?`,
      [
        'trainer_membership_id' in req.body ? 1 : 0, trainer_membership_id ?? null,
        'room_id' in req.body ? 1 : 0, room_id ?? null,
        starts_at ? new Date(starts_at) : null,
        ends_at ? new Date(ends_at) : null,
        'max_capacity_override' in req.body ? 1 : 0,
        max_capacity_override != null && max_capacity_override !== '' ? parseInt(max_capacity_override, 10) : null,
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
    "UPDATE class_sessions SET status = 'cancelled', cancellation_reason = ? WHERE id = ? AND gym_id = ? AND status <> 'cancelled'",
    [reason, req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Session not found or already cancelled' });
  recordAudit(req, { action: 'cancel', entityType: 'class_session', entityId: req.params.id, next: { cancellation_reason: reason } });
  res.status(204).send();
});
