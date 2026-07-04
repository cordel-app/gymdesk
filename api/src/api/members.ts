import { Router } from 'express';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

export const membersRouter = Router();

membersRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `SELECT m.*, f.name AS fare_name, f.price AS fare_price
     FROM members m
     LEFT JOIN fares f ON f.id = m.fare_id
     WHERE m.deleted_at IS NULL AND m.gym_id = ?
     ORDER BY m.created_at DESC`,
    [gymId],
  );
  res.json(rows);
});

membersRouter.get('/count', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT COUNT(*) AS count FROM members WHERE deleted_at IS NULL AND gym_id = ?',
    [gymId],
  );
  res.json({ count: Number(rows[0].count) });
});

membersRouter.get('/deleted', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM members WHERE deleted_at IS NOT NULL AND gym_id = ? ORDER BY deleted_at DESC',
    [gymId],
  );
  res.json(rows);
});

membersRouter.post('/:id/restore', requireRole('admin', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'UPDATE members SET deleted_at = NULL WHERE id = ? AND gym_id = ? AND deleted_at IS NOT NULL',
    [req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Member not found or not deleted' });
  const { rows } = await db.query('SELECT * FROM members WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  res.json(rows[0]);
});

membersRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Member not found' });
  res.json(rows[0]);
});

membersRouter.post('/', requireRole('admin', 'staff'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, email, phone, fare_id } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  try {
    const { insertId } = await db.query(
      'INSERT INTO members (name, email, phone, fare_id, gym_id) VALUES (?, ?, ?, ?, ?)',
      [name, email, phone ?? null, fare_id ?? null, gymId],
    );
    const { rows } = await db.query('SELECT * FROM members WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A member with this email already exists.' });
    next(err);
  }
});

membersRouter.put('/:id', requireRole('admin', 'staff'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, email, phone, fare_id } = req.body;
  try {
    const { rowCount } = await db.query(
      `UPDATE members SET
        name    = COALESCE(?, name),
        email   = COALESCE(?, email),
        phone   = COALESCE(?, phone),
        fare_id = IF(?, ?, fare_id)
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [name ?? null, email ?? null, phone ?? null, 'fare_id' in req.body ? 1 : 0, fare_id ?? null, req.params.id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Member not found' });
    const { rows } = await db.query(
      'SELECT * FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [req.params.id, gymId],
    );
    res.json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A member with this email already exists.' });
    next(err);
  }
});

membersRouter.post('/:id/invite', requireRole('admin', 'staff'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberAppUrl = process.env.MEMBER_APP_URL ?? '';
  try {
    const { rows } = await db.query(
      'SELECT email FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [req.params.id, gymId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Member not found' });
    await clerkClient.invitations.createInvitation({
      emailAddress: rows[0].email,
      redirectUrl: `${memberAppUrl}/en/link?gym_id=${gymId}`,
    });
    res.json({ ok: true });
  } catch (err: any) {
    // Clerk returns 422 when an invitation for this email already exists/user already exists
    if (err.status === 422) return res.status(409).json({ error: 'An invitation or account already exists for this email.' });
    next(err);
  }
});

membersRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Member not found' });
  res.status(204).send();
});
