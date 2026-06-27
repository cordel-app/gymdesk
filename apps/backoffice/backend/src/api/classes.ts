import { Router } from 'express';
import { db } from '../infra/db';

export const classesRouter = Router();

classesRouter.get('/', async (_req, res) => {
  const { rows } = await db.query('SELECT * FROM classes ORDER BY starts_at ASC');
  res.json(rows);
});

classesRouter.get('/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM classes WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Class not found' });
  res.json(rows[0]);
});

classesRouter.post('/', async (req, res) => {
  const { name, description, capacity, starts_at, ends_at } = req.body;
  if (!name || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'name, starts_at and ends_at are required' });
  }
  const { rows } = await db.query(
    'INSERT INTO classes (name, description, capacity, starts_at, ends_at) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [name, description ?? null, capacity ?? 10, starts_at, ends_at],
  );
  res.status(201).json(rows[0]);
});

classesRouter.put('/:id', async (req, res) => {
  const { name, description, capacity, starts_at, ends_at } = req.body;
  const { rows } = await db.query(
    `UPDATE classes SET
      name        = COALESCE($1, name),
      description = COALESCE($2, description),
      capacity    = COALESCE($3, capacity),
      starts_at   = COALESCE($4, starts_at),
      ends_at     = COALESCE($5, ends_at)
     WHERE id = $6 RETURNING *`,
    [name ?? null, description ?? null, capacity ?? null, starts_at ?? null, ends_at ?? null, req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Class not found' });
  res.json(rows[0]);
});

classesRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM classes WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Class not found' });
  res.status(204).send();
});
