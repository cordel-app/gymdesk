import { Router } from 'express';
import { db } from '../infra/db';

export const membersRouter = Router();

membersRouter.get('/', async (_req, res) => {
  const { rows } = await db.query('SELECT * FROM members WHERE deleted_at IS NULL ORDER BY created_at DESC');
  res.json(rows);
});

membersRouter.get('/count', async (_req, res) => {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM members WHERE deleted_at IS NULL');
  res.json({ count: rows[0].count });
});

membersRouter.get('/deleted', async (_req, res) => {
  const { rows } = await db.query('SELECT * FROM members WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
  res.json(rows);
});

membersRouter.post('/:id/restore', async (req, res) => {
  const { rows } = await db.query(
    'UPDATE members SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *',
    [req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Member not found or not deleted' });
  res.json(rows[0]);
});

membersRouter.get('/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM members WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Member not found' });
  res.json(rows[0]);
});

membersRouter.post('/', async (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  const { rows } = await db.query(
    'INSERT INTO members (name, email, phone) VALUES ($1, $2, $3) RETURNING *',
    [name, email, phone ?? null],
  );
  res.status(201).json(rows[0]);
});

membersRouter.put('/:id', async (req, res) => {
  const { name, email, phone } = req.body;
  const { rows } = await db.query(
    'UPDATE members SET name = COALESCE($1, name), email = COALESCE($2, email), phone = COALESCE($3, phone) WHERE id = $4 AND deleted_at IS NULL RETURNING *',
    [name ?? null, email ?? null, phone ?? null, req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Member not found' });
  res.json(rows[0]);
});

membersRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await db.query(
    'UPDATE members SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
    [req.params.id],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Member not found' });
  res.status(204).send();
});
