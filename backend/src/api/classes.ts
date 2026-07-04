import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

export const classesRouter = Router();

// Body dates arrive as ISO strings; mysql2 serializes JS Dates as UTC (pool timezone 'Z')
const toDate = (v: unknown) => (v == null ? null : new Date(v as string));

classesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM classes WHERE gym_id = ? ORDER BY starts_at ASC',
    [gymId],
  );
  res.json(rows);
});

classesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM classes WHERE id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Class not found' });
  res.json(rows[0]);
});

classesRouter.post('/', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { name, description, capacity, starts_at, ends_at } = req.body;
  if (!name || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'name, starts_at and ends_at are required' });
  }
  const { insertId } = await db.query(
    'INSERT INTO classes (name, description, capacity, starts_at, ends_at, gym_id) VALUES (?, ?, ?, ?, ?, ?)',
    [name, description ?? null, capacity ?? 10, toDate(starts_at), toDate(ends_at), gymId],
  );
  const { rows } = await db.query('SELECT * FROM classes WHERE id = ?', [insertId]);
  res.status(201).json(rows[0]);
});

classesRouter.put('/:id', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { name, description, capacity, starts_at, ends_at } = req.body;
  const { rowCount } = await db.query(
    `UPDATE classes SET
      name        = COALESCE(?, name),
      description = COALESCE(?, description),
      capacity    = COALESCE(?, capacity),
      starts_at   = COALESCE(?, starts_at),
      ends_at     = COALESCE(?, ends_at)
     WHERE id = ? AND gym_id = ?`,
    [name ?? null, description ?? null, capacity ?? null, toDate(starts_at), toDate(ends_at), req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Class not found' });
  const { rows } = await db.query('SELECT * FROM classes WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  res.json(rows[0]);
});

classesRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM classes WHERE id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Class not found' });
  res.status(204).send();
});
