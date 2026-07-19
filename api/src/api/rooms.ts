import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { resolveCenterId } from '../infra/centerContext';
import { recordAudit } from '../infra/audit';
import { gymFetchOne, handleDupEntry, insertAndFetch } from '../infra/db-helpers';

const STATUSES = ['active', 'inactive'] as const;

export const roomsRouter = Router();

roomsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { status, center_id } = req.query as Record<string, string | undefined>;
  if (status && !STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const where: string[] = ['gym_id = ?', 'deleted_at IS NULL'];
  const params: any[] = [gymId];
  if (status) { where.push('status = ?'); params.push(status); }
  if (center_id) { where.push('center_id = ?'); params.push(center_id); }
  const { rows } = await db.query(
    `SELECT * FROM rooms WHERE ${where.join(' AND ')} ORDER BY name ASC`,
    params,
  );
  res.json(rows);
});

roomsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const row = await gymFetchOne('rooms', req.params.id, gymId, { softDelete: true });
  if (!row) return res.status(404).json({ error: 'Room not found' });
  res.json(row);
});

roomsRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, capacity, status, center_id } = req.body;
  if (!name || capacity == null) return res.status(400).json({ error: 'name and capacity are required' });
  const cap = parseInt(capacity, 10);
  if (isNaN(cap) || cap <= 0) return res.status(400).json({ error: 'capacity must be a positive integer' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const resolvedCenterId = await resolveCenterId(gymId, req, center_id);
    const row = await insertAndFetch(
      'INSERT INTO rooms (name, description, capacity, status, gym_id, center_id, modified_by_membership_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name.trim(), description ?? null, cap, status ?? 'active', gymId, resolvedCenterId, gymMembershipId],
      'SELECT * FROM rooms WHERE id = ?',
      (id) => [id],
    );
    res.status(201).json(row);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    handleDupEntry(err, res, next, 'A room with this name already exists.');
  }
});

roomsRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, capacity, status } = req.body;
  const cap = capacity != null ? parseInt(capacity, 10) : null;
  if (cap !== null && (isNaN(cap) || cap <= 0)) return res.status(400).json({ error: 'capacity must be a positive integer' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const { rowCount } = await db.query(
      `UPDATE rooms SET
        name        = COALESCE(?, name),
        description = IF(?, ?, description),
        capacity    = COALESCE(?, capacity),
        status      = COALESCE(?, status),
        modified_at = UTC_TIMESTAMP(),
        modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        cap, status ?? null,
        gymMembershipId,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Room not found' });
    const { rows } = await db.query('SELECT * FROM rooms WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A room with this name already exists.');
  }
});

roomsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rowCount } = await db.query(
    `UPDATE rooms SET deleted_at = UTC_TIMESTAMP(), modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [gymMembershipId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Room not found' });
  recordAudit(req, { action: 'soft_delete', entityType: 'room', entityId: req.params.id });
  res.status(204).send();
});
