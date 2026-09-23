import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../infra/db';
import { tenantContext, requireRole, requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { insertAndFetch } from '../infra/db-helpers';
import { ASSIGNABLE_ROLES, AppRole } from '../infra/permissions';
import {
  buildGymFolderPrefix,
  describeStorageError,
  getMissingStorageConfigKeys,
  getStorageDiagnostics,
  initializeGymBucket,
  isStorageConfigured,
  StorageOperationError,
} from '../infra/storage';
import { logger } from '../lib/logger';

export const gymsRouter = Router();
export const platformRouter = Router();

// SQL fragment to LEFT JOIN theme data onto a gyms query.
const THEME_JOIN = `
  LEFT JOIN themes t ON t.id = g.theme_id AND t.deleted_at IS NULL
`;
const THEME_SELECT = `
  , t.id AS theme_id_val, t.name AS theme_name, t.status AS theme_status,
    t.logo_mime AS theme_logo_mime, t.logo_updated_at AS theme_logo_updated_at,
    t.logo_contains_gym_name AS theme_logo_contains_gym_name,
    t.tokens AS theme_tokens
`;

// #636: the gym's Payment Provider, joined only into the superadmin reads below.
// It is deliberately absent from the user-facing `GET /gyms` (any member of the
// gym can call that): the row carries platform state — the provider's status and
// whether it is the platform default — that belongs to Cordel, not to a member.
// The join stays LEFT although the column is NOT NULL: a read is the wrong place
// to discover that a FK the database enforces has somehow been broken.
const PLATFORM_GYM_JOIN = `
  ${THEME_JOIN}
  LEFT JOIN payment_providers pp ON pp.id = g.payment_provider_id
`;
const PLATFORM_GYM_SELECT = `
  ${THEME_SELECT}
  , pp.id AS payment_provider_id_val, pp.name AS payment_provider_name,
    pp.provider_key AS payment_provider_key, pp.status AS payment_provider_status,
    pp.is_default AS payment_provider_is_default
`;

// #371: system Sellable Item seeded for every gym (existing gyms backfilled
// by migration 124; this keeps gyms created afterwards in sync).
const SYSTEM_PT_PACKAGE_NAME = 'Personal Training Class Package (10 Sessions)';

async function seedSystemPtPackage(gymId: string) {
  await db.query(
    `INSERT INTO gym_charges
       (gym_id, name, type, units, status, enrollment_status, is_system,
        validity_days, tax_rate_id, currency, tax_behavior, created_at, modified_at)
     SELECT ?, ?, 'sessions', 10, 'active', 'staff_only', 1, 182,
       (SELECT tr.id FROM tax_rates tr
        WHERE tr.gym_id = ? AND tr.is_system = 1 AND tr.deleted_at IS NULL
        ORDER BY tr.id LIMIT 1),
       'EUR', 'inclusive', UTC_TIMESTAMP(), UTC_TIMESTAMP()
     FROM DUAL
     WHERE NOT EXISTS (
       SELECT 1 FROM gym_charges gc WHERE gc.gym_id = ? AND gc.is_system = 1 AND gc.name = ?
     )`,
    [gymId, SYSTEM_PT_PACKAGE_NAME, gymId, gymId, SYSTEM_PT_PACKAGE_NAME],
  );
}

// #599: gym rows are read with `g.*`, so the website API key hash must be
// dropped before a row is serialised — into a response or an audit payload.
function stripGymSecrets<T extends Record<string, any>>(row: T): Omit<T, 'website_api_key_hash'> {
  const { website_api_key_hash: _hash, ...rest } = row;
  return rest;
}

function attachTheme(row: any) {
  const {
    theme_id_val, theme_name, theme_status, theme_logo_mime, theme_logo_updated_at,
    theme_logo_contains_gym_name, theme_tokens,
    payment_provider_id_val, payment_provider_name, payment_provider_key,
    payment_provider_status, payment_provider_is_default,
    ...rest
  } = stripGymSecrets(row);
  // #636: the joined provider, alongside the raw `payment_provider_id` the edit
  // form submits back — same split as `theme_id` / `theme`. Only the superadmin
  // reads select these columns (PLATFORM_GYM_SELECT); the key is left off the
  // response entirely for the ones that don't, rather than serialised as null.
  const selectedProvider = 'payment_provider_id_val' in row;
  const payment_provider = payment_provider_id_val ? {
    id: payment_provider_id_val,
    name: payment_provider_name,
    provider_key: payment_provider_key,
    status: payment_provider_status,
    is_default: !!payment_provider_is_default,
  } : null;
  const theme = theme_id_val ? {
    id: theme_id_val,
    name: theme_name,
    status: theme_status,
    has_logo: !!theme_logo_mime,
    logo_updated_at: theme_logo_updated_at,
    logo_contains_gym_name: !!theme_logo_contains_gym_name,
    tokens: typeof theme_tokens === 'string' ? JSON.parse(theme_tokens) : (theme_tokens ?? null),
  } : null;
  // #417: platform-wide flag (same for every gym on this deployment), not a
  // per-row DB column — lets the admin UI disable the init action.
  return {
    ...rest,
    theme,
    ...(selectedProvider ? { payment_provider } : {}),
    storage_configured: isStorageConfigured(),
  };
}

/**
 * #636: a gym's Payment Provider is mandatory, so creation resolves the
 * platform default when the caller names none. Returns null when the catalogue
 * has no default at all — the caller turns that into a 400 rather than letting
 * the NOT NULL column fail as a 500.
 */
async function resolveDefaultPaymentProviderId(): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    "SELECT id FROM payment_providers WHERE is_default = 1 AND status = 'active' AND deleted_at IS NULL LIMIT 1",
  );
  return rows[0]?.id ?? null;
}

/** Validates an explicitly supplied provider: it must exist and be active. */
async function assertAssignablePaymentProvider(id: unknown): Promise<number | null> {
  // Numeric strings are accepted (a form field submits one), but nothing else
  // is coerced: `Number(true)` is 1, which would silently re-point the gym at
  // whichever provider happens to be id 1.
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  const { rows } = await db.query<{ id: number }>(
    "SELECT id FROM payment_providers WHERE id = ? AND status = 'active' AND deleted_at IS NULL",
    [numeric],
  );
  return rows[0]?.id ?? null;
}

const PAYMENT_PROVIDER_REQUIRED_ERROR =
  'payment_provider_id must reference an active payment provider';

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
    `SELECT g.* ${PLATFORM_GYM_SELECT} FROM gyms g ${PLATFORM_GYM_JOIN}
     WHERE ${conditions.join(' AND ')}
     ORDER BY g.created_at ASC`,
    params,
  );
  res.json(rows.map(attachTheme));
});

platformRouter.get('/gyms/:id', requireSuperadmin, async (req, res) => {
  const { rows } = await db.query(
    `SELECT g.* ${PLATFORM_GYM_SELECT} FROM gyms g ${PLATFORM_GYM_JOIN} WHERE g.id = ?`,
    [req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Gym not found' });
  res.json(attachTheme(rows[0]));
});

platformRouter.post('/gyms', requireSuperadmin, async (req, res) => {
  const { name, slug: rawSlug, plan, theme_id, description, payment_provider_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  // #636: pre-populated with the default provider when the caller sends none,
  // so the Cordel "Add gym" form does not have to.
  const providerId = payment_provider_id === undefined || payment_provider_id === null
    ? await resolveDefaultPaymentProviderId()
    : await assertAssignablePaymentProvider(payment_provider_id);
  if (providerId === null) {
    return res.status(400).json({
      error: payment_provider_id === undefined || payment_provider_id === null
        ? 'No default payment provider is configured. Create one under Cordel → Payment Providers first.'
        : PAYMENT_PROVIDER_REQUIRED_ERROR,
    });
  }

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
      `INSERT INTO gyms (id, name, slug, plan, theme_id, payment_provider_id, description, status, created_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, slug, plan ?? 'free', theme_id ?? null, providerId, description?.trim() || null, 'active', actorName],
    );
    // #59: every gym needs at least one Center — mirrors migration 046's
    // backfill for pre-existing gyms, so resolveCenterId()'s "sole active
    // center" fallback works from day one for gyms created after this ships.
    await db.query(
      "INSERT INTO centers (gym_id, name, status) VALUES (?, ?, 'active')",
      [id, name],
    );
    // #543: name/type must be seeded from charge_types here too — they're
    // the Sellable Items catalogue columns (added by migration 102 as a
    // one-time backfill), not generated from charge_type_id at read time.
    await db.query(
      `INSERT IGNORE INTO gym_charges (gym_id, charge_type_id, name, type, is_system, created_at)
       SELECT ?, id, name, 'fee', 1, UTC_TIMESTAMP() FROM charge_types WHERE is_gym_charge = 1`,
      [id],
    );
    await db.query(
      `INSERT IGNORE INTO tax_rates (gym_id, name, rate_percent, is_system, status, created_at)
       VALUES (?, 'Standard VAT', 21.00, 1, 'active', UTC_TIMESTAMP())`,
      [id],
    );
    await db.query(
      `INSERT IGNORE INTO gym_professional_services (gym_id, professional_service_id, status, created_at)
       SELECT ?, id, 'active', UTC_TIMESTAMP() FROM professional_services WHERE is_system = 1`,
      [id],
    );
    await seedSystemPtPackage(id);
    const { rows } = await db.query(
      `SELECT g.* ${PLATFORM_GYM_SELECT} FROM gyms g ${PLATFORM_GYM_JOIN} WHERE g.id = ?`,
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
  const { name, theme_id, description, status, payment_provider_id } = req.body;
  if (
    name === undefined && theme_id === undefined && description === undefined
    && status === undefined && payment_provider_id === undefined
  ) {
    return res.status(400).json({ error: 'At least one field must be provided' });
  }
  // #636: mandatory and never nullable — an explicit null is a 400, not a clear.
  let providerId: number | undefined;
  if (payment_provider_id !== undefined) {
    const resolved = payment_provider_id === null ? null : await assertAssignablePaymentProvider(payment_provider_id);
    if (resolved === null) return res.status(400).json({ error: PAYMENT_PROVIDER_REQUIRED_ERROR });
    providerId = resolved;
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
       name                = COALESCE(?, name),
       description         = IF(? IS NOT NULL, ?, description),
       status              = COALESCE(?, status),
       theme_id            = IF(?, ?, theme_id),
       payment_provider_id = COALESCE(?, payment_provider_id),
       modified_at         = UTC_TIMESTAMP(),
       modified_by_name    = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      name ?? null,
      description !== undefined ? (description?.trim() || null) : null,
      description !== undefined ? (description?.trim() || null) : null,
      status ?? null,
      themeIdValue !== undefined ? 1 : 0,
      themeIdValue ?? null,
      providerId ?? null,
      actorName,
      req.params.id,
    ],
  );

  const { rows } = await db.query(
    `SELECT g.* ${PLATFORM_GYM_SELECT} FROM gyms g ${PLATFORM_GYM_JOIN} WHERE g.id = ?`,
    [req.params.id],
  );
  recordAudit(req, { action: 'update', entityType: 'gym', entityId: req.params.id, previous: stripGymSecrets(existing[0]), next: attachTheme(rows[0]) });
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
    `SELECT g.* ${PLATFORM_GYM_SELECT} FROM gyms g ${PLATFORM_GYM_JOIN} WHERE g.id = ?`,
    [req.params.id],
  );
  recordAudit(req, { action: 'update', entityType: 'gym', entityId: req.params.id, previous: stripGymSecrets(existing[0]), next: attachTheme(rows[0]) });
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
  recordAudit(req, { action: 'delete', entityType: 'gym', entityId: req.params.id, previous: stripGymSecrets(existing[0]) });
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
  // #636: the copy keeps the source gym's Payment Provider — the column is NOT
  // NULL, and a duplicate that silently switched providers would be a surprise.
  await db.query(
    `INSERT INTO gyms (id, name, slug, plan, theme_id, payment_provider_id, description, status, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId, newName, newSlug, src.plan, src.theme_id ?? null, src.payment_provider_id, src.description ?? null, 'active', actorName],
  );
  await db.query(
    "INSERT INTO centers (gym_id, name, status) VALUES (?, ?, 'active')",
    [newId, newName],
  );
  // #543: name/type must be seeded from charge_types here too — see the
  // matching comment on the POST /gyms insert above.
  await db.query(
    `INSERT IGNORE INTO gym_charges (gym_id, charge_type_id, name, type, created_at)
     SELECT ?, id, name, 'fee', UTC_TIMESTAMP() FROM charge_types WHERE is_gym_charge = 1`,
    [newId],
  );
  await db.query(
    `INSERT IGNORE INTO tax_rates (gym_id, name, rate_percent, is_system, status, created_at)
     VALUES (?, 'Standard VAT', 21.00, 1, 'active', UTC_TIMESTAMP())`,
    [newId],
  );
  await db.query(
    `INSERT IGNORE INTO gym_professional_services (gym_id, professional_service_id, status, created_at)
     SELECT ?, id, 'active', UTC_TIMESTAMP() FROM professional_services WHERE is_system = 1`,
    [newId],
  );
  await seedSystemPtPackage(newId);
  const { rows } = await db.query(
    `SELECT g.* ${PLATFORM_GYM_SELECT} FROM gyms g ${PLATFORM_GYM_JOIN} WHERE g.id = ?`,
    [newId],
  );
  recordAudit(req, { action: 'create', entityType: 'gym', entityId: newId, next: attachTheme(rows[0]) });
  res.status(201).json(attachTheme(rows[0]));
});

// #417 stage 1: provisions the gym's folder structure inside the shared R2
// bucket. Idempotent — re-running reuses the prefix captured on first init
// rather than recomputing from the (possibly since-renamed) gym name.
platformRouter.post('/gyms/:id/storage/initialize', requireSuperadmin, async (req, res) => {
  const { rows: existing } = await db.query(
    'SELECT * FROM gyms WHERE id = ? AND deleted_at IS NULL',
    [req.params.id],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Gym not found' });
  const gym = existing[0];

  if (!isStorageConfigured()) {
    const missingConfig = getMissingStorageConfigKeys();
    return res.status(503).json({
      error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
      missingConfig,
      // #542: even a 503 carries the snapshot, so an admin can see *which*
      // parts of the R2 config did arrive in the container.
      diagnostics: getStorageDiagnostics(),
    });
  }

  const folderPrefix: string = gym.storage_folder_prefix ?? buildGymFolderPrefix(gym.id, gym.name);

  try {
    await initializeGymBucket(folderPrefix);
  } catch (err: any) {
    // #542: a one-line toast was not enough to tell a wrong endpoint from a
    // wrong bucket from a bad key — return the structured detail as well, and
    // log the raw error server-side so the stack survives for support.
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'initializeGymBucket' });
    const diagnostics = getStorageDiagnostics();
    logger.error({ err, details, diagnostics, gymId: req.params.id, folderPrefix }, 'Cloudflare R2 bucket initialization failed');
    return res.status(502).json({
      error: `Failed to initialize Cloudflare storage: ${details.message}`,
      details,
      diagnostics,
    });
  }

  const actorName = req.superadminName ?? null;
  await db.query(
    `UPDATE gyms SET
       storage_folder_prefix   = ?,
       storage_initialized_at  = UTC_TIMESTAMP(),
       modified_at             = UTC_TIMESTAMP(),
       modified_by_name        = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [folderPrefix, actorName, req.params.id],
  );

  const { rows } = await db.query(
    `SELECT g.* ${PLATFORM_GYM_SELECT} FROM gyms g ${PLATFORM_GYM_JOIN} WHERE g.id = ?`,
    [req.params.id],
  );
  recordAudit(req, { action: 'update', entityType: 'gym', entityId: req.params.id, previous: stripGymSecrets(gym), next: attachTheme(rows[0]) });
  res.json(attachTheme(rows[0]));
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
