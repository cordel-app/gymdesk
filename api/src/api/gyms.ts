import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../infra/db';
import { tenantContext, requireRole, requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { insertAndFetch } from '../infra/db-helpers';
import { ASSIGNABLE_ROLES, AppRole } from '../infra/permissions';

export const gymsRouter = Router();
export const platformRouter = Router();

// SQL fragment to LEFT JOIN theme data onto a gyms query.
const THEME_JOIN = `
  LEFT JOIN themes t ON t.id = g.theme_id AND t.deleted_at IS NULL
`;
const THEME_SELECT = `
  , t.id AS theme_id_val, t.name AS theme_name, t.status AS theme_status,
    t.logo_mime AS theme_logo_mime, t.logo_updated_at AS theme_logo_updated_at,
    t.tokens AS theme_tokens
`;

function attachTheme(row: any) {
  const { theme_id_val, theme_name, theme_status, theme_logo_mime, theme_logo_updated_at, theme_tokens, ...rest } = row;
  const theme = theme_id_val ? {
    id: theme_id_val,
    name: theme_name,
    status: theme_status,
    has_logo: !!theme_logo_mime,
    logo_updated_at: theme_logo_updated_at,
    tokens: typeof theme_tokens === 'string' ? JSON.parse(theme_tokens) : (theme_tokens ?? null),
  } : null;
  return { ...rest, theme };
}

/** Slugify a name: lowercase, spaces→hyphens, strip non-alphanumeric. */
function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/** Generate a unique slug from a base, appending -2, -3, … as needed. */
async function uniqueSlug(base: string): Promise<string> {
  const safe = slugify(base) || 'gym';
  let candidate = safe;
  let i = 2;
  for (;;) {
    const { rows } = await db.query<{ id: string }>('SELECT id FROM gyms WHERE slug = ?', [candidate]);
    if (rows.length === 0) return candidate;
    candidate = `${safe}-${i++}`;
  }
}

// ─── User-facing: list gyms for the authenticated user ───────────────────────

gymsRouter.get('/', async (req, res) => {
  // /gyms is guarded by the custom requireAuth() (sets req.auth), not Clerk's
  // express middleware — so read req.auth, consistent with every other route.
  // getAuth() here throws (no clerkMiddleware registered) → 500, which broke
  // the admin-app self-heal for freshly-invited non-superadmin users.
  const userId = req.auth?.userId;
  const { rows } = await db.query(
    `SELECT g.* ${THEME_SELECT}, gm.role
     FROM gyms g
     ${THEME_JOIN}
     JOIN gym_memberships gm ON gm.gym_id = g.id
     WHERE gm.user_id = ? AND g.deleted_at IS NULL
     ORDER BY g.created_at ASC`,
    [userId],
  );
  res.json(rows.map(attachTheme));
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
  if (!ASSIGNABLE_ROLES.includes(role as AppRole)) {
    return res.status(400).json({ error: `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` });
  }
  try {
    const row = await insertAndFetch(
      'INSERT INTO gym_memberships (user_id, gym_id, role) VALUES (?, ?, ?)',
      [user_id, req.params.gymId, role],
      'SELECT * FROM gym_memberships WHERE id = ?',
      (id) => [id],
    );
    res.status(201).json(row);
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

platformRouter.get('/gyms', requireSuperadmin, async (req, res) => {
  const { status } = req.query as { status?: string };
  const conditions: string[] = ['g.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (status && ['active', 'inactive'].includes(status)) {
    conditions.push('g.status = ?');
    params.push(status);
  }
  const { rows } = await db.query(
    `SELECT g.* ${THEME_SELECT} FROM gyms g ${THEME_JOIN}
     WHERE ${conditions.join(' AND ')}
     ORDER BY g.created_at ASC`,
    params,
  );
  res.json(rows.map(attachTheme));
});

platformRouter.get('/gyms/:id', requireSuperadmin, async (req, res) => {
  const { rows } = await db.query(
    `SELECT g.* ${THEME_SELECT} FROM gyms g ${THEME_JOIN} WHERE g.id = ?`,
    [req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Gym not found' });
  res.json(attachTheme(rows[0]));
});

platformRouter.post('/gyms', requireSuperadmin, async (req, res) => {
  const { name, slug: rawSlug, plan, theme_id, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  if (theme_id) {
    const { rows: themeRows } = await db.query(
      "SELECT id FROM themes WHERE id = ? AND status = 'active' AND deleted_at IS NULL",
      [theme_id],
    );
    if (themeRows.length === 0) return res.status(400).json({ error: 'theme_id must reference an active theme' });
  }

  const slug = rawSlug?.trim() ? rawSlug.trim() : await uniqueSlug(name);
  const id = randomUUID();
  const actorName = req.superadminName ?? null;

  try {
    await db.query(
      'INSERT INTO gyms (id, name, slug, plan, theme_id, description, status, created_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, slug, plan ?? 'free', theme_id ?? null, description?.trim() || null, 'active', actorName],
    );
    // #59: every gym needs at least one Center — mirrors migration 046's
    // backfill for pre-existing gyms, so resolveCenterId()'s "sole active
    // center" fallback works from day one for gyms created after this ships.
    await db.query(
      "INSERT INTO centers (gym_id, name, status) VALUES (?, ?, 'active')",
      [id, name],
    );
    await db.query(
      `INSERT IGNORE INTO gym_charges (gym_id, charge_type_id, is_system, created_at)
       SELECT ?, id, 1, UTC_TIMESTAMP() FROM charge_types WHERE is_gym_charge = 1`,
      [id],
    );
    const { rows } = await db.query(
      `SELECT g.* ${THEME_SELECT} FROM gyms g ${THEME_JOIN} WHERE g.id = ?`,
      [id],
    );
    recordAudit(req, { action: 'create', entityType: 'gym', entityId: id, next: attachTheme(rows[0]) });
    res.status(201).json(attachTheme(rows[0]));
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Slug already taken' });
    throw err;
  }
});

platformRouter.put('/gyms/:id', requireSuperadmin, async (req, res) => {
  const { name, theme_id, description, status } = req.body;
  if (name === undefined && theme_id === undefined && description === undefined && status === undefined) {
    return res.status(400).json({ error: 'At least one field must be provided' });
  }
  if (status !== undefined && !['active', 'inactive'].includes(status)) {
    return res.status(400).json({ error: "status must be 'active' or 'inactive'" });
  }
  if (theme_id !== undefined && theme_id !== null) {
    const { rows: themeRows } = await db.query(
      "SELECT id FROM themes WHERE id = ? AND status = 'active' AND deleted_at IS NULL",
      [theme_id],
    );
    if (themeRows.length === 0) return res.status(400).json({ error: 'theme_id must reference an active theme' });
  }

  const { rows: existing } = await db.query(
    'SELECT * FROM gyms WHERE id = ? AND deleted_at IS NULL',
    [req.params.id],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Gym not found' });

  const themeIdValue = 'theme_id' in req.body ? (theme_id ?? null) : undefined;
  const actorName = req.superadminName ?? null;

  await db.query(
    `UPDATE gyms SET
       name             = COALESCE(?, name),
       description      = IF(? IS NOT NULL, ?, description),
       status           = COALESCE(?, status),
       theme_id         = IF(?, ?, theme_id),
       modified_at      = UTC_TIMESTAMP(),
       modified_by_name = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      name ?? null,
      description !== undefined ? (description?.trim() || null) : null,
      description !== undefined ? (description?.trim() || null) : null,
      status ?? null,
      themeIdValue !== undefined ? 1 : 0,
      themeIdValue ?? null,
      actorName,
      req.params.id,
    ],
  );

  const { rows } = await db.query(
    `SELECT g.* ${THEME_SELECT} FROM gyms g ${THEME_JOIN} WHERE g.id = ?`,
    [req.params.id],
  );
  recordAudit(req, { action: 'update', entityType: 'gym', entityId: req.params.id, previous: existing[0], next: attachTheme(rows[0]) });
  res.json(attachTheme(rows[0]));
});

/** Kept for backwards compatibility — delegates to PUT logic. */
platformRouter.patch('/gyms/:id', requireSuperadmin, async (req, res) => {
  const { name, theme_id } = req.body;
  if (name === undefined && theme_id === undefined) {
    return res.status(400).json({ error: 'At least one of name or theme_id must be provided' });
  }
  if (theme_id !== undefined && theme_id !== null) {
    const { rows: themeRows } = await db.query(
      "SELECT id FROM themes WHERE id = ? AND status = 'active' AND deleted_at IS NULL",
      [theme_id],
    );
    if (themeRows.length === 0) return res.status(400).json({ error: 'theme_id must reference an active theme' });
  }
  const { rows: existing } = await db.query('SELECT * FROM gyms WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  if (existing.length === 0) return res.status(404).json({ error: 'Gym not found' });
  const themeIdValue = 'theme_id' in req.body ? (theme_id ?? null) : undefined;
  const actorName = req.superadminName ?? null;
  await db.query(
    `UPDATE gyms SET
       name             = COALESCE(?, name),
       theme_id         = IF(?, ?, theme_id),
       modified_at      = UTC_TIMESTAMP(),
       modified_by_name = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [name ?? null, themeIdValue !== undefined ? 1 : 0, themeIdValue ?? null, actorName, req.params.id],
  );
  const { rows } = await db.query(
    `SELECT g.* ${THEME_SELECT} FROM gyms g ${THEME_JOIN} WHERE g.id = ?`,
    [req.params.id],
  );
  recordAudit(req, { action: 'update', entityType: 'gym', entityId: req.params.id, previous: existing[0], next: attachTheme(rows[0]) });
  res.json(attachTheme(rows[0]));
});

platformRouter.delete('/gyms/:id', requireSuperadmin, async (req, res) => {
  const { rows: existing } = await db.query(
    'SELECT * FROM gyms WHERE id = ? AND deleted_at IS NULL',
    [req.params.id],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Gym not found' });
  const actorName = req.superadminName ?? null;
  await db.query(
    `UPDATE gyms SET deleted_at = UTC_TIMESTAMP(), deleted_by_name = ?, status = 'deleted'
     WHERE id = ? AND deleted_at IS NULL`,
    [actorName, req.params.id],
  );
  recordAudit(req, { action: 'delete', entityType: 'gym', entityId: req.params.id, previous: existing[0] });
  res.status(204).send();
});

platformRouter.post('/gyms/:id/duplicate', requireSuperadmin, async (req, res) => {
  const { rows: source } = await db.query(
    'SELECT * FROM gyms WHERE id = ? AND deleted_at IS NULL',
    [req.params.id],
  );
  if (source.length === 0) return res.status(404).json({ error: 'Gym not found' });
  const src = source[0];
  const newName = `Copy of ${src.name}`;
  const newSlug = await uniqueSlug(newName);
  const newId = randomUUID();
  const actorName = req.superadminName ?? null;
  await db.query(
    'INSERT INTO gyms (id, name, slug, plan, theme_id, description, status, created_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [newId, newName, newSlug, src.plan, src.theme_id ?? null, src.description ?? null, 'active', actorName],
  );
  await db.query(
    "INSERT INTO centers (gym_id, name, status) VALUES (?, ?, 'active')",
    [newId, newName],
  );
  await db.query(
    `INSERT IGNORE INTO gym_charges (gym_id, charge_type_id, created_at)
     SELECT ?, id, UTC_TIMESTAMP() FROM charge_types WHERE is_gym_charge = 1`,
    [newId],
  );
  const { rows } = await db.query(
    `SELECT g.* ${THEME_SELECT} FROM gyms g ${THEME_JOIN} WHERE g.id = ?`,
    [newId],
  );
  recordAudit(req, { action: 'create', entityType: 'gym', entityId: newId, next: attachTheme(rows[0]) });
  res.status(201).json(attachTheme(rows[0]));
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
