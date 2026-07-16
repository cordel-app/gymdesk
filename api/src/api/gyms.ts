import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../infra/db';
import { tenantContext, requireRole, requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

/** Kept in sync with migration 030 and apps/admin/src/lib/themes.ts. */
const THEME_KEYS = ['indigo', 'emerald', 'crimson', 'amber'] as const;
type ThemeKey = (typeof THEME_KEYS)[number];

export const gymsRouter = Router();
export const platformRouter = Router();

// ─── User-facing: list gyms for the authenticated user ───────────────────────

gymsRouter.get('/', async (req, res) => {
  // /gyms is guarded by the custom requireAuth() (sets req.auth), not Clerk's
  // express middleware — so read req.auth, consistent with every other route.
  // getAuth() here throws (no clerkMiddleware registered) → 500, which broke
  // the admin-app self-heal for freshly-invited non-superadmin users.
  const userId = (req as any).auth?.userId;
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
  const { name, slug, plan, theme_key } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });
  if (theme_key && !THEME_KEYS.includes(theme_key)) {
    return res.status(400).json({ error: `theme_key must be one of: ${THEME_KEYS.join(', ')}` });
  }
  const id = randomUUID();
  try {
    await db.query(
      'INSERT INTO gyms (id, name, slug, plan, theme_key) VALUES (?, ?, ?, ?, ?)',
      [id, name, slug, plan ?? 'free', (theme_key as ThemeKey) ?? 'indigo'],
    );
    // #59: every gym needs at least one Center — mirrors migration 046's
    // backfill for pre-existing gyms, so resolveCenterId()'s "sole active
    // center" fallback works from day one for gyms created after this ships.
    await db.query(
      "INSERT INTO centers (gym_id, name, status) VALUES (?, ?, 'active')",
      [id, name],
    );
    const { rows } = await db.query('SELECT * FROM gyms WHERE id = ?', [id]);
    recordAudit(req, { action: 'create', entityType: 'gym', entityId: id, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Slug already taken' });
    throw err;
  }
});

/**
 * Update a gym's mutable metadata (name + theme). Slug and plan are
 * intentionally not editable here — slug is public URL-shaped and needs a
 * migration path, plan changes belong under billing (P8+).
 */
platformRouter.patch('/gyms/:id', requireSuperadmin, async (req, res) => {
  const { name, theme_key } = req.body;
  if (theme_key !== undefined && !THEME_KEYS.includes(theme_key)) {
    return res.status(400).json({ error: `theme_key must be one of: ${THEME_KEYS.join(', ')}` });
  }
  if (name === undefined && theme_key === undefined) {
    return res.status(400).json({ error: 'At least one of name or theme_key must be provided' });
  }
  const { rows: existing } = await db.query('SELECT * FROM gyms WHERE id = ?', [req.params.id]);
  if (existing.length === 0) return res.status(404).json({ error: 'Gym not found' });

  const { rowCount } = await db.query(
    `UPDATE gyms SET
       name      = COALESCE(?, name),
       theme_key = COALESCE(?, theme_key)
     WHERE id = ?`,
    [name ?? null, theme_key ?? null, req.params.id],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Gym not found' });
  const { rows } = await db.query('SELECT * FROM gyms WHERE id = ?', [req.params.id]);
  recordAudit(req, { action: 'update', entityType: 'gym', entityId: req.params.id, previous: existing[0], next: rows[0] });
  res.json(rows[0]);
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
