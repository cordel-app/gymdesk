import { Router } from 'express';
import { db } from '../infra/db';

export const subscriptionsRouter = Router();

subscriptionsRouter.get('/', async (_req, res) => {
  const { rows } = await db.query('SELECT * FROM subscriptions ORDER BY created_at DESC');
  res.json(rows);
});

subscriptionsRouter.get('/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM subscriptions WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Subscription not found' });
  res.json(rows[0]);
});

subscriptionsRouter.post('/', async (req, res) => {
  const { member_id, plan, starts_at, ends_at } = req.body;
  if (!member_id || !plan || !starts_at) {
    return res.status(400).json({ error: 'member_id, plan and starts_at are required' });
  }
  const { rows } = await db.query(
    'INSERT INTO subscriptions (member_id, plan, starts_at, ends_at) VALUES ($1, $2, $3, $4) RETURNING *',
    [member_id, plan, starts_at, ends_at ?? null],
  );
  res.status(201).json(rows[0]);
});

subscriptionsRouter.put('/:id', async (req, res) => {
  const { plan, starts_at, ends_at, status } = req.body;
  const { rows } = await db.query(
    `UPDATE subscriptions SET
      plan      = COALESCE($1, plan),
      starts_at = COALESCE($2, starts_at),
      ends_at   = COALESCE($3, ends_at),
      status    = COALESCE($4, status)
     WHERE id = $5 RETURNING *`,
    [plan ?? null, starts_at ?? null, ends_at ?? null, status ?? null, req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Subscription not found' });
  res.json(rows[0]);
});

subscriptionsRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM subscriptions WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Subscription not found' });
  res.status(204).send();
});
