import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

export const membersRouter = Router();

membersRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `SELECT m.*, f.name AS fare_name, f.price AS fare_price
     FROM members m
     LEFT JOIN fares f ON f.id = m.fare_id
     WHERE m.deleted_at IS NULL AND m.gym_id = $1
     ORDER BY m.created_at DESC`,
    [gymId],
  );
  res.json(rows);
});

membersRouter.get('/count', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS count FROM members WHERE deleted_at IS NULL AND gym_id = $1',
    [gymId],
  );
  res.json({ count: rows[0].count });
});

membersRouter.get('/deleted', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM members WHERE deleted_at IS NOT NULL AND gym_id = $1 ORDER BY deleted_at DESC',
    [gymId],
  );
  res.json(rows);
});

membersRouter.post('/:id/restore', requireRole('admin', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'UPDATE members SET deleted_at = NULL WHERE id = $1 AND gym_id = $2 AND deleted_at IS NOT NULL RETURNING *',
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Member not found or not deleted' });
  res.json(rows[0]);
});

membersRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM members WHERE id = $1 AND gym_id = $2 AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Member not found' });
  res.json(rows[0]);
});

membersRouter.post('/', requireRole('admin', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { name, email, phone, fare_id } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  const { rows } = await db.query(
    'INSERT INTO members (name, email, phone, fare_id, gym_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [name, email, phone ?? null, fare_id ?? null, gymId],
  );
  res.status(201).json(rows[0]);
});

membersRouter.put('/:id', requireRole('admin', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { name, email, phone, fare_id } = req.body;
  const { rows } = await db.query(
    `UPDATE members SET
      name    = COALESCE($1, name),
      email   = COALESCE($2, email),
      phone   = COALESCE($3, phone),
      fare_id = CASE WHEN $4::boolean THEN $5::integer ELSE fare_id END
     WHERE id = $6 AND gym_id = $7 AND deleted_at IS NULL RETURNING *`,
    [name ?? null, email ?? null, phone ?? null, 'fare_id' in req.body, fare_id ?? null, req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Member not found' });
  res.json(rows[0]);
});

membersRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'UPDATE members SET deleted_at = now() WHERE id = $1 AND gym_id = $2 AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Member not found' });
  res.status(204).send();
});
