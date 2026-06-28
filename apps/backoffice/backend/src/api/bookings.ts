import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

export const bookingsRouter = Router();

bookingsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM bookings WHERE gym_id = $1 ORDER BY created_at DESC',
    [gymId],
  );
  res.json(rows);
});

bookingsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM bookings WHERE id = $1 AND gym_id = $2',
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
  res.json(rows[0]);
});

bookingsRouter.post('/', requireRole('admin', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { member_id, class_id } = req.body;
  if (!member_id || !class_id) {
    return res.status(400).json({ error: 'member_id and class_id are required' });
  }
  const { rows } = await db.query(
    'INSERT INTO bookings (member_id, class_id, gym_id) VALUES ($1, $2, $3) RETURNING *',
    [member_id, class_id, gymId],
  );
  res.status(201).json(rows[0]);
});

bookingsRouter.put('/:id', requireRole('admin', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { status } = req.body;
  const { rows } = await db.query(
    'UPDATE bookings SET status = COALESCE($1, status) WHERE id = $2 AND gym_id = $3 RETURNING *',
    [status ?? null, req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
  res.json(rows[0]);
});

bookingsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM bookings WHERE id = $1 AND gym_id = $2',
    [req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Booking not found' });
  res.status(204).send();
});
