import { Router } from 'express';
import { db } from '../infra/db';

export const membersRouter = Router();

membersRouter.get('/', async (_req, res) => {
  const { rows } = await db.query('SELECT * FROM members ORDER BY created_at DESC');
  res.json(rows);
});

membersRouter.get('/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM members WHERE id = $1', [req.params.id]);
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
    'UPDATE members SET name = COALESCE($1, name), email = COALESCE($2, email), phone = COALESCE($3, phone) WHERE id = $4 RETURNING *',
    [name ?? null, email ?? null, phone ?? null, req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Member not found' });
  res.json(rows[0]);
});

membersRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM members WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Member not found' });
  res.status(204).send();
});
