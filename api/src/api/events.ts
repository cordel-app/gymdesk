import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { resolveCenterId } from '../infra/centerContext';
import { recordAudit } from '../infra/audit';
import { gymFetchOne, insertAndFetch } from '../infra/db-helpers';

const STATUSES = ['scheduled', 'cancelled', 'completed'] as const;

export const eventsRouter = Router();

eventsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { from, to, status, center_id } = req.query as Record<string, string | undefined>;
  const where: string[] = ['gym_id = ?', 'deleted_at IS NULL'];
  const params: any[] = [gymId];
  if (from) { where.push('starts_at >= ?'); params.push(from); }
  if (to)   { where.push('starts_at <= ?'); params.push(to); }
  if (status && STATUSES.includes(status as any)) { where.push('status = ?'); params.push(status); }
  if (center_id) { where.push('center_id = ?'); params.push(center_id); }
  const { rows } = await db.query(
    `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY starts_at ASC`,
    params,
  );
  res.json(rows);
});

eventsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const row = await gymFetchOne('events', req.params.id, gymId, { softDelete: true });
  if (!row) return res.status(404).json({ error: 'Event not found' });
  res.json(row);
});

eventsRouter.post('/', requireModuleWrite('ORGANIZATION'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, room_id, starts_at, ends_at, capacity, center_id } = req.body;
  if (!name || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'name, starts_at and ends_at are required' });
  }
  if (new Date(starts_at) >= new Date(ends_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }
  const cap = capacity != null && capacity !== '' ? parseInt(capacity, 10) : null;
  if (cap !== null && (isNaN(cap) || cap <= 0)) return res.status(400).json({ error: 'capacity must be a positive integer' });

  try {
    const resolvedCenterId = await resolveCenterId(gymId, req, center_id);
    if (room_id) {
      const { rows: roomRows } = await db.query(
        'SELECT id FROM rooms WHERE id = ? AND gym_id = ? AND center_id = ? AND deleted_at IS NULL',
        [room_id, gymId, resolvedCenterId],
      );
      if (roomRows.length === 0) return res.status(400).json({ error: 'Room does not belong to this center' });
    }
    const row = await insertAndFetch(
      `INSERT INTO events (name, description, room_id, starts_at, ends_at, capacity, gym_id, center_id, created_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name.trim(), description ?? null, room_id ?? null, new Date(starts_at), new Date(ends_at), cap, gymId, resolvedCenterId, gymMembershipId],
      'SELECT * FROM events WHERE id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'event', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

eventsRouter.put('/:id', requireModuleWrite('ORGANIZATION'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, room_id, starts_at, ends_at, capacity, status } = req.body;
  if (starts_at && ends_at && new Date(starts_at) >= new Date(ends_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  const cap = capacity != null && capacity !== '' ? parseInt(capacity, 10) : null;
  if (cap !== null && (isNaN(cap) || cap <= 0)) return res.status(400).json({ error: 'capacity must be a positive integer' });

  try {
    const { rowCount } = await db.query(
      `UPDATE events SET
        name        = COALESCE(?, name),
        description = IF(?, ?, description),
        room_id     = IF(?, ?, room_id),
        starts_at   = COALESCE(?, starts_at),
        ends_at     = COALESCE(?, ends_at),
        capacity    = IF(?, ?, capacity),
        status      = COALESCE(?, status),
        modified_at = UTC_TIMESTAMP(),
        modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        'room_id' in req.body ? 1 : 0, room_id ?? null,
        starts_at ? new Date(starts_at) : null,
        ends_at ? new Date(ends_at) : null,
        'capacity' in req.body ? 1 : 0, cap,
        status ?? null,
        gymMembershipId,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Event not found' });
    const { rows } = await db.query('SELECT * FROM events WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

eventsRouter.delete('/:id', requireModuleWrite('ORGANIZATION'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rowCount } = await db.query(
    `UPDATE events SET deleted_at = UTC_TIMESTAMP(), modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [gymMembershipId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Event not found' });
  recordAudit(req, { action: 'soft_delete', entityType: 'event', entityId: req.params.id });
  res.status(204).send();
});
