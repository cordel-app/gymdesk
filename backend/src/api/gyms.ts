import { getAuth } from '@clerk/express';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../infra/db';
import { tenantContext, requireRole, requireSuperadmin } from '../infra/tenantContext';

export const gymsRouter = Router();
export const platformRouter = Router();

// ─── User-facing: list gyms for the authenticated user ───────────────────────

gymsRouter.get('/', async (req, res) => {
  const userId = getAuth(req).userId;
  const { rows } = await db.query(
    `SELECT g.*, gm.role
     FROM gyms g
     JOIN gym_memberships gm ON gm.gym_id = g.id
     WHERE gm.user_id = ?
     ORDER BY g.created_at ASC`,
    [userId],
  );
  res.json(rows);
});

// ─── Gym membership management (admin only within a gym) ─────────────────────

gymsRouter.get('/:gymId/memberships', tenantContext, requireRole('admin'), async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM gym_memberships WHERE gym_id = ? ORDER BY created_at ASC',
    [req.params.gymId],
  );
  res.json(rows);
});

gymsRouter.post('/:gymId/memberships', tenantContext, requireRole('admin'), async (req, res) => {
  const { user_id, role } = req.body;
  if (!user_id || !role) return res.status(400).json({ error: 'user_id and role are required' });
  if (!['admin', 'coach', 'staff'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin, coach, or staff' });
  }
  try {
    const { insertId } = await db.query(
      'INSERT INTO gym_memberships (user_id, gym_id, role) VALUES (?, ?, ?)',
      [user_id, req.params.gymId, role],
    );
    const { rows } = await db.query('SELECT * FROM gym_memberships WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'User already a member of this gym' });
    throw err;
  }
});

gymsRouter.delete('/:gymId/memberships/:userId', tenantContext, requireRole('admin'), async (req, res) => {
  const { rowCount } = await db.query(
    'DELETE FROM gym_memberships WHERE gym_id = ? AND user_id = ?',
    [req.params.gymId, req.params.userId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Membership not found' });
  res.status(204).send();
});

// ─── Platform (superadmin only) ───────────────────────────────────────────────

platformRouter.get('/gyms', requireSuperadmin, async (_req, res) => {
  const { rows } = await db.query('SELECT * FROM gyms ORDER BY created_at ASC');
  res.json(rows);
});

platformRouter.post('/gyms', requireSuperadmin, async (req, res) => {
  const { name, slug, plan } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });
  const id = randomUUID();
  try {
    await db.query(
      'INSERT INTO gyms (id, name, slug, plan) VALUES (?, ?, ?, ?)',
      [id, name, slug, plan ?? 'free'],
    );
    const { rows } = await db.query('SELECT * FROM gyms WHERE id = ?', [id]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Slug already taken' });
    throw err;
  }
});

platformRouter.post('/gyms/:gymId/admins', requireSuperadmin, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  try {
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role) VALUES (?, ?, 'admin') AS new
       ON DUPLICATE KEY UPDATE role = new.role`,
      [user_id, req.params.gymId],
    );
    const { rows } = await db.query(
      'SELECT * FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
      [user_id, req.params.gymId],
    );
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_NO_REFERENCED_ROW_2') return res.status(404).json({ error: 'Gym not found' });
    throw err;
  }
});
