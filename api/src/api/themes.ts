import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { defaultTokens, validateTokens } from '../domain/themeTokens';
import {
  describeStorageError,
  getStorageObject,
  isStorageConfigured,
  StorageOperationError,
} from '../infra/storage';
import { logger } from '../lib/logger';

// ─── Superadmin CRUD ──────────────────────────────────────────────────────────

export const themesRouter = Router();

// ─── Public logo endpoint (no auth) ──────────────────────────────────────────

export const themesPublicRouter = Router();

const ALLOWED_MIME_TYPES = ['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'];
const LOGO_MAX_BYTES = 512 * 1024; // 512 KB

function shapeTheme(row: any) {
  const { logo_bytes: _lb, ...rest } = row;
  return {
    ...rest,
    type: row.gym_id === null ? 'system' : 'custom',
    has_logo: !!row.logo_mime,
    is_system_default: !!row.is_system_default,
    logo_contains_gym_name: !!row.logo_contains_gym_name,
    tokens: typeof row.tokens === 'string' ? JSON.parse(row.tokens) : (row.tokens ?? null),
  };
}

async function checkThemeProtected(id: string): Promise<{ isGymDefault: boolean; centerCount: number }> {
  const { rows: gymRefs } = await db.query<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM gyms WHERE theme_id = ?',
    [id],
  );
  const { rows: centerRefs } = await db.query<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM centers WHERE theme_id = ? AND deleted_at IS NULL',
    [id],
  );
  return {
    isGymDefault: Number(gymRefs[0].cnt) > 0,
    centerCount: Number(centerRefs[0].cnt),
  };
}

// ─── List ─────────────────────────────────────────────────────────────────────

themesRouter.get('/', requireSuperadmin, async (req, res) => {
  const status = req.query.status as string | undefined;
  const params: any[] = [];

  let whereClause = '1=1';
  if (status) {
    whereClause += ' AND t.status = ?';
    params.push(status);
  } else {
    whereClause += ' AND t.deleted_at IS NULL';
  }

  // usage_count: distinct orgs using this base theme as their default or via center assignment
  const sql = `
    SELECT
      t.id, t.gym_id, t.is_system_default, t.name, t.description, t.status,
      t.logo_mime, t.logo_updated_at, t.logo_contains_gym_name, t.tokens, t.created_at, t.modified_at, t.deleted_at,
      (
        SELECT COUNT(DISTINCT gg.id)
        FROM gyms gg
        LEFT JOIN centers cc ON cc.gym_id = gg.id AND cc.deleted_at IS NULL
        WHERE gg.theme_id = t.id OR cc.theme_id = t.id
      ) AS usage_count
    FROM themes t
    WHERE t.gym_id IS NULL AND ${whereClause}
    ORDER BY t.created_at ASC
  `;
  const { rows } = await db.query(sql, params);
  res.json(rows.map((r: any) => ({ ...shapeTheme(r), usage_count: Number(r.usage_count) })));
});

// ─── Get single ───────────────────────────────────────────────────────────────

themesRouter.get('/:id', requireSuperadmin, async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.id, t.gym_id, t.is_system_default, t.name, t.description, t.status,
            t.logo_mime, t.logo_updated_at, t.logo_contains_gym_name, t.tokens, t.created_at, t.modified_at, t.deleted_at,
            (
              SELECT COUNT(DISTINCT gg.id) FROM gyms gg
              LEFT JOIN centers cc ON cc.gym_id = gg.id AND cc.deleted_at IS NULL
              WHERE gg.theme_id = t.id OR cc.theme_id = t.id
            ) AS usage_count
     FROM themes t
     WHERE t.id = ? AND t.gym_id IS NULL`,
    [req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Theme not found' });

  const [{ rows: auditRows }] = await Promise.all([
    db.query(
      `SELECT action, actor_name, created_at FROM audit_logs
       WHERE entity_type = 'theme' AND entity_id = ?
       ORDER BY created_at ASC`,
      [req.params.id],
    ),
  ]);
  const createEntry = auditRows.find((r: any) => r.action === 'create');
  const updateEntry = [...auditRows].reverse().find((r: any) => r.action === 'update');
  const deleteEntry = [...auditRows].reverse().find((r: any) => r.action === 'delete');

  const row = rows[0];
  res.json({
    ...shapeTheme(row),
    usage_count: Number(row.usage_count),
    created_by_name: createEntry?.actor_name ?? null,
    modified_by_name: updateEntry?.actor_name ?? null,
    deleted_by_name: deleteEntry?.actor_name ?? null,
  });
});

// ─── Create ───────────────────────────────────────────────────────────────────

themesRouter.post('/', requireSuperadmin, async (req, res) => {
  const { name, description, tokens, status, logo_contains_gym_name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

  const ALLOWED_CREATE_STATUSES = ['draft', 'active'];
  const resolvedStatus = status ?? 'draft';
  if (!ALLOWED_CREATE_STATUSES.includes(resolvedStatus)) {
    return res.status(400).json({ error: `status must be one of: ${ALLOWED_CREATE_STATUSES.join(', ')}` });
  }

  if (logo_contains_gym_name !== undefined && typeof logo_contains_gym_name !== 'boolean') {
    return res.status(400).json({ error: 'logo_contains_gym_name must be a boolean' });
  }

  // Enforce name uniqueness among non-deleted rows.
  const { rows: existing } = await db.query(
    "SELECT id FROM themes WHERE name = ? AND deleted_at IS NULL",
    [name.trim()],
  );
  if (existing.length > 0) return res.status(409).json({ error: 'A theme with this name already exists' });

  const mergedTokens = tokens ?? defaultTokens();
  const err = validateTokens(mergedTokens);
  if (err) return res.status(400).json({ error: err });

  const id = randomUUID();
  await db.query(
    'INSERT INTO themes (id, gym_id, is_system_default, name, description, status, logo_contains_gym_name, tokens, created_at) VALUES (?, NULL, 0, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
    [id, name.trim(), description?.trim() ?? null, resolvedStatus, logo_contains_gym_name ?? false, JSON.stringify(mergedTokens)],
  );
  const { rows } = await db.query(
    'SELECT id, gym_id, is_system_default, name, description, status, logo_mime, logo_updated_at, logo_contains_gym_name, tokens, created_at, modified_at FROM themes WHERE id = ?',
    [id],
  );
  recordAudit(req, { action: 'create', entityType: 'theme', entityId: id, next: shapeTheme(rows[0]) });
  res.status(201).json(shapeTheme(rows[0]));
});

// ─── Update name / tokens / status ───────────────────────────────────────────

themesRouter.put('/:id', requireSuperadmin, async (req, res) => {
  const { name, description, tokens, status, logo_contains_gym_name } = req.body;
  const ALLOWED_STATUSES = ['draft', 'active', 'inactive'];
  if (status !== undefined && !ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` });
  }
  if (logo_contains_gym_name !== undefined && typeof logo_contains_gym_name !== 'boolean') {
    return res.status(400).json({ error: 'logo_contains_gym_name must be a boolean' });
  }

  const { rows: existingRows } = await db.query(
    'SELECT id, name, status, tokens, logo_mime, logo_updated_at, logo_contains_gym_name, deleted_at FROM themes WHERE id = ? AND gym_id IS NULL',
    [req.params.id],
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'Theme not found' });
  const current = existingRows[0];
  if (current.deleted_at) return res.status(409).json({ error: 'Theme is deleted' });

  // Block status downgrade when theme is assigned
  if (status === 'draft' || status === 'inactive') {
    const { isGymDefault, centerCount } = await checkThemeProtected(req.params.id as string);
    if (isGymDefault) {
      return res.status(409).json({
        error: `This Theme cannot be marked as ${status === 'draft' ? 'Draft' : 'Inactive'} because it is configured as the Gym Default Theme.`,
      });
    }
    if (centerCount > 0) {
      return res.status(409).json({
        error: `This Theme cannot be marked as ${status === 'draft' ? 'Draft' : 'Inactive'} because it is assigned to one or more Centers.`,
      });
    }
  }

  if (name !== undefined && name.trim() !== current.name) {
    const { rows: nameConflict } = await db.query(
      'SELECT id FROM themes WHERE name = ? AND deleted_at IS NULL AND id != ?',
      [name.trim(), req.params.id],
    );
    if (nameConflict.length > 0) return res.status(409).json({ error: 'A theme with this name already exists' });
  }

  let tokensMerged = typeof current.tokens === 'string' ? JSON.parse(current.tokens) : current.tokens;
  if (tokens !== undefined) {
    tokensMerged = tokens;
    const err = validateTokens(tokensMerged);
    if (err) return res.status(400).json({ error: err });
  }

  await db.query(
    `UPDATE themes SET
       name                   = COALESCE(?, name),
       description            = CASE WHEN ? IS NOT NULL THEN ? ELSE description END,
       status                 = COALESCE(?, status),
       logo_contains_gym_name = COALESCE(?, logo_contains_gym_name),
       tokens                 = ?
     WHERE id = ?`,
    [name?.trim() ?? null, description !== undefined ? description : null, description ?? null, status ?? null, logo_contains_gym_name ?? null, JSON.stringify(tokensMerged), req.params.id],
  );
  const { rows } = await db.query(
    'SELECT id, gym_id, is_system_default, name, description, status, logo_mime, logo_updated_at, logo_contains_gym_name, tokens, created_at, modified_at FROM themes WHERE id = ?',
    [req.params.id],
  );
  recordAudit(req, { action: 'update', entityType: 'theme', entityId: req.params.id, previous: shapeTheme(current), next: shapeTheme(rows[0]) });
  res.json(shapeTheme(rows[0]));
});

// ─── Logo upload ──────────────────────────────────────────────────────────────

themesRouter.post(
  '/:id/logo',
  requireSuperadmin,
  express.raw({ type: (req: any) => (req.headers['content-type'] ?? '').startsWith('image/'), limit: '600kb' }),
  async (req, res) => {
    const mime = req.headers['content-type']?.split(';')[0]?.trim();
    if (!mime || !ALLOWED_MIME_TYPES.includes(mime)) {
      return res.status(415).json({ error: `Unsupported image type. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}` });
    }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'Request body is empty' });
    if (body.length > LOGO_MAX_BYTES) {
      return res.status(413).json({ error: 'Logo exceeds 512 KB limit' });
    }

    const { rows: existing } = await db.query('SELECT id FROM themes WHERE id = ? AND gym_id IS NULL AND deleted_at IS NULL', [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Theme not found' });

    await db.query(
      'UPDATE themes SET logo_bytes = ?, logo_mime = ?, logo_updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [body, mime, req.params.id],
    );
    const { rows } = await db.query(
      'SELECT id, gym_id, is_system_default, name, description, status, logo_mime, logo_updated_at, logo_contains_gym_name, tokens, created_at, modified_at FROM themes WHERE id = ?',
      [req.params.id],
    );
    res.json(shapeTheme(rows[0]));
  },
);

// ─── Logo delete ──────────────────────────────────────────────────────────────

themesRouter.delete('/:id/logo', requireSuperadmin, async (req, res) => {
  const { rows: existing } = await db.query('SELECT id FROM themes WHERE id = ? AND gym_id IS NULL AND deleted_at IS NULL', [req.params.id]);
  if (existing.length === 0) return res.status(404).json({ error: 'Theme not found' });
  await db.query('UPDATE themes SET logo_bytes = NULL, logo_mime = NULL, logo_updated_at = NULL WHERE id = ?', [req.params.id]);
  const { rows } = await db.query(
    'SELECT id, gym_id, is_system_default, name, description, status, logo_mime, logo_updated_at, logo_contains_gym_name, tokens, created_at, modified_at FROM themes WHERE id = ?',
    [req.params.id],
  );
  res.json(shapeTheme(rows[0]));
});

// ─── Clone a base theme into a new base theme ────────────────────────────────

themesRouter.post('/clone/:sourceId', requireSuperadmin, async (req, res) => {
  const { rows: source } = await db.query(
    'SELECT id, name, tokens, logo_contains_gym_name FROM themes WHERE id = ? AND gym_id IS NULL AND deleted_at IS NULL',
    [req.params.sourceId],
  );
  if (source.length === 0) return res.status(404).json({ error: 'Theme not found' });

  const src = source[0];
  const baseName = req.body?.name?.trim() || `${src.name} (copy)`;

  const { rows: nameConflict } = await db.query(
    'SELECT id FROM themes WHERE gym_id IS NULL AND name = ? AND deleted_at IS NULL',
    [baseName],
  );
  if (nameConflict.length > 0) return res.status(409).json({ error: 'A theme with this name already exists' });

  const id = randomUUID();
  const tokens = typeof src.tokens === 'string' ? src.tokens : JSON.stringify(src.tokens);
  await db.query(
    "INSERT INTO themes (id, gym_id, is_system_default, name, status, logo_contains_gym_name, tokens, created_at) VALUES (?, NULL, 0, ?, 'draft', ?, ?, UTC_TIMESTAMP())",
    [id, baseName, src.logo_contains_gym_name, tokens],
  );
  const { rows } = await db.query(
    'SELECT id, gym_id, is_system_default, name, description, status, logo_mime, logo_updated_at, logo_contains_gym_name, tokens, created_at, modified_at FROM themes WHERE id = ?',
    [id],
  );
  recordAudit(req, { action: 'clone', entityType: 'theme', entityId: id, next: shapeTheme(rows[0]) });
  res.status(201).json(shapeTheme(rows[0]));
});

// ─── Set system default ───────────────────────────────────────────────────────

themesRouter.put('/:id/set-system-default', requireSuperadmin, async (req, res) => {
  const { rows: existing } = await db.query(
    'SELECT id FROM themes WHERE id = ? AND gym_id IS NULL AND deleted_at IS NULL',
    [req.params.id],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Theme not found' });

  await db.query('UPDATE themes SET is_system_default = 0 WHERE gym_id IS NULL');
  await db.query('UPDATE themes SET is_system_default = 1 WHERE id = ?', [req.params.id]);
  recordAudit(req, { action: 'update', entityType: 'theme', entityId: req.params.id, next: { is_system_default: true } });
  res.json({ ok: true });
});

// ─── Soft delete ──────────────────────────────────────────────────────────────

themesRouter.delete('/:id', requireSuperadmin, async (req, res) => {
  const { rows: existing } = await db.query('SELECT id, deleted_at FROM themes WHERE id = ? AND gym_id IS NULL', [req.params.id]);
  if (existing.length === 0) return res.status(404).json({ error: 'Theme not found' });
  if (existing[0].deleted_at) return res.status(409).json({ error: 'Theme is already deleted' });

  const { isGymDefault, centerCount } = await checkThemeProtected(req.params.id as string);
  if (isGymDefault) {
    return res.status(409).json({ error: 'This Theme cannot be deleted because it is configured as the Gym Default Theme.' });
  }
  if (centerCount > 0) {
    return res.status(409).json({ error: 'This Theme cannot be deleted because it is assigned to one or more Centers.' });
  }

  await db.query(
    "UPDATE themes SET status = 'deleted', deleted_at = UTC_TIMESTAMP() WHERE id = ?",
    [req.params.id],
  );
  recordAudit(req, { action: 'delete', entityType: 'theme', entityId: req.params.id });
  res.status(204).send();
});

// ─── Public logo endpoint ─────────────────────────────────────────────────────

themesPublicRouter.get('/:id/logo', async (req, res) => {
  const { rows } = await db.query(
    'SELECT logo_bytes, logo_mime, logo_object_key FROM themes WHERE id = ? AND deleted_at IS NULL',
    [req.params.id],
  );
  // #713: a Custom Theme logo lives in the gym's R2 folder, and this endpoint
  // stays the one logo URL every consumer can use whichever way the binary is
  // stored — it reads the object and returns the bytes. Deliberately not a
  // redirect to the bucket: the Payment app loads this URL under
  // `img-src 'self'` (its nginx proxies `/themes/` for exactly that reason) and
  // CSP still matches a redirect's host, so a 302 would be blocked there.
  // Clients that hold the theme shape use its `logo_url` and skip this hop.
  const objectKey: string | null = rows[0]?.logo_object_key ?? null;
  if (objectKey) {
    if (!isStorageConfigured()) return res.status(503).json({ error: 'Cloudflare storage is not configured for this deployment' });
    try {
      const object = await getStorageObject(objectKey);
      res.set('Content-Type', object.contentType ?? rows[0].logo_mime ?? 'application/octet-stream');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(object.body);
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'getStorageObject', key: objectKey });
      // A missing object is a 404 like a missing blob; anything else is the
      // storage layer failing, which an unauthenticated caller gets as a 502
      // without the platform detail (that goes to the log).
      logger.error({ err, details, themeId: req.params.id }, 'Cloudflare R2 theme logo read failed');
      const notFound = details.httpStatusCode === 404 || details.name === 'NoSuchKey';
      return res.status(notFound ? 404 : 502).json({ error: notFound ? 'Logo not found' : 'Failed to read logo' });
    }
  }
  if (rows.length === 0 || !rows[0].logo_bytes || !rows[0].logo_mime) {
    return res.status(404).json({ error: 'Logo not found' });
  }
  res.set('Content-Type', rows[0].logo_mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(rows[0].logo_bytes);
});
