import { Router } from 'express';
import { db } from '../infra/db';

export const bookingsRouter = Router();

bookingsRouter.get('/', async (_req, res) => {
  const { rows } = await db.query('SELECT * FROM bookings ORDER BY created_at DESC');
  res.json(rows);
});

bookingsRouter.get('/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
  res.json(rows[0]);
});

bookingsRouter.post('/', async (req, res) => {
  const { member_id, class_id } = req.body;
  if (!member_id || !class_id) {
    return res.status(400).json({ error: 'member_id and class_id are required' });
  }
  const { rows } = await db.query(
    'INSERT INTO bookings (member_id, class_id) VALUES ($1, $2) RETURNING *',
    [member_id, class_id],
  );
  res.status(201).json(rows[0]);
});

bookingsRouter.put('/:id', async (req, res) => {
  const { status } = req.body;
  const { rows } = await db.query(
    'UPDATE bookings SET status = COALESCE($1, status) WHERE id = $2 RETURNING *',
    [status ?? null, req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
  res.json(rows[0]);
});

bookingsRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM bookings WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Booking not found' });
  res.status(204).send();
});
