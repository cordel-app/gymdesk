import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

export const subscriptionsRouter = Router();

subscriptionsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM subscriptions WHERE gym_id = $1 ORDER BY created_at DESC',
    [gymId],
  );
  res.json(rows);
});

subscriptionsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM subscriptions WHERE id = $1 AND gym_id = $2',
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Subscription not found' });
  res.json(rows[0]);
});

subscriptionsRouter.post('/', requireRole('admin', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { member_id, plan, starts_at, ends_at } = req.body;
  if (!member_id || !plan || !starts_at) {
    return res.status(400).json({ error: 'member_id, plan and starts_at are required' });
  }
  const { rows } = await db.query(
    'INSERT INTO subscriptions (member_id, plan, starts_at, ends_at, gym_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [member_id, plan, starts_at, ends_at ?? null, gymId],
  );
  res.status(201).json(rows[0]);
});

subscriptionsRouter.put('/:id', requireRole('admin', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { plan, starts_at, ends_at, status } = req.body;
  const { rows } = await db.query(
    `UPDATE subscriptions SET
      plan      = COALESCE($1, plan),
      starts_at = COALESCE($2, starts_at),
      ends_at   = COALESCE($3, ends_at),
      status    = COALESCE($4, status)
     WHERE id = $5 AND gym_id = $6 RETURNING *`,
    [plan ?? null, starts_at ?? null, ends_at ?? null, status ?? null, req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Subscription not found' });
  res.json(rows[0]);
});

subscriptionsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM subscriptions WHERE id = $1 AND gym_id = $2',
    [req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Subscription not found' });
  res.status(204).send();
});
