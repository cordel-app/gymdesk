import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

export const bookingsRouter = Router();

bookingsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM bookings WHERE gym_id = ? ORDER BY created_at DESC',
    [gymId],
  );
  res.json(rows);
});

bookingsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM bookings WHERE id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
  res.json(rows[0]);
});

bookingsRouter.post('/', requireRole('admin', 'staff'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { member_id, class_id } = req.body;
  if (!member_id || !class_id) {
    return res.status(400).json({ error: 'member_id and class_id are required' });
  }
  try {
    const { insertId } = await db.query(
      'INSERT INTO bookings (member_id, class_id, gym_id) VALUES (?, ?, ?)',
      [member_id, class_id, gymId],
    );
    const { rows } = await db.query('SELECT * FROM bookings WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This member is already booked for this class.' });
    next(err);
  }
});

bookingsRouter.put('/:id', requireRole('admin', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { status } = req.body;
  const { rowCount } = await db.query(
    'UPDATE bookings SET status = COALESCE(?, status) WHERE id = ? AND gym_id = ?',
    [status ?? null, req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Booking not found' });
  const { rows } = await db.query('SELECT * FROM bookings WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  res.json(rows[0]);
});

bookingsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM bookings WHERE id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Booking not found' });
  res.status(204).send();
});
