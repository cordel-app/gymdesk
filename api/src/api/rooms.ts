import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

const STATUSES = ['active', 'inactive'] as const;

export const roomsRouter = Router();

roomsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const params: any[] = [gymId];
  let sql = 'SELECT * FROM rooms WHERE gym_id = ?';
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY name ASC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

roomsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query('SELECT * FROM rooms WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Room not found' });
  res.json(rows[0]);
});

roomsRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, capacity, status } = req.body;
  if (!name || capacity == null) return res.status(400).json({ error: 'name and capacity are required' });
  const cap = parseInt(capacity, 10);
  if (isNaN(cap) || cap <= 0) return res.status(400).json({ error: 'capacity must be a positive integer' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const { insertId } = await db.query(
      'INSERT INTO rooms (name, description, capacity, status, gym_id) VALUES (?, ?, ?, ?, ?)',
      [name.trim(), description ?? null, cap, status ?? 'active', gymId],
    );
    const { rows } = await db.query('SELECT * FROM rooms WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A room with this name already exists.' });
    next(err);
  }
});

roomsRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
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
        status      = COALESCE(?, status)
       WHERE id = ? AND gym_id = ?`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        cap, status ?? null,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Room not found' });
    const { rows } = await db.query('SELECT * FROM rooms WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A room with this name already exists.' });
    next(err);
  }
});

roomsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query('DELETE FROM rooms WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Room not found' });
  res.status(204).send();
});
