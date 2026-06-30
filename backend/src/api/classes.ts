import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

export const classesRouter = Router();

classesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM classes WHERE gym_id = $1 ORDER BY starts_at ASC',
    [gymId],
  );
  res.json(rows);
});

classesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM classes WHERE id = $1 AND gym_id = $2',
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
  const { rows } = await db.query(
    'INSERT INTO classes (name, description, capacity, starts_at, ends_at, gym_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [name, description ?? null, capacity ?? 10, starts_at, ends_at, gymId],
  );
  res.status(201).json(rows[0]);
});

classesRouter.put('/:id', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { name, description, capacity, starts_at, ends_at } = req.body;
  const { rows } = await db.query(
    `UPDATE classes SET
      name        = COALESCE($1, name),
      description = COALESCE($2, description),
      capacity    = COALESCE($3, capacity),
      starts_at   = COALESCE($4, starts_at),
      ends_at     = COALESCE($5, ends_at)
     WHERE id = $6 AND gym_id = $7 RETURNING *`,
    [name ?? null, description ?? null, capacity ?? null, starts_at ?? null, ends_at ?? null, req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Class not found' });
  res.json(rows[0]);
});

classesRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM classes WHERE id = $1 AND gym_id = $2',
    [req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Class not found' });
  res.status(204).send();
});
