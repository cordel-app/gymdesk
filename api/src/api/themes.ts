import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { defaultTokens, validateTokens } from '../domain/themeTokens';
import {
  bytesMatchImageMime,
  buildThemeMemberImageKey,
  isMemberImageSlot,
  MEMBER_IMAGE_MAX_BYTES,
  MEMBER_IMAGE_MIME_TYPES,
  MEMBER_IMAGE_SLOTS,
  memberImageUrls,
  themeMemberFolderKeys,
  type MemberImageRow,
} from '../domain/themeMemberImages';
import { loadPlatformMemberImagesByTheme } from './theme-member-images';
import {
  deleteStorageObject,
  describeStorageError,
  ensureStorageFolders,
  getMissingStorageConfigKeys,
  getStorageDiagnostics,
  getStorageObject,
  isStorageConfigured,
  PLATFORM_STORAGE_ROOT,
  StorageOperationError,
  uploadStorageObject,
} from '../infra/storage';
import { logger } from '../lib/logger';

// ─── Superadmin CRUD ──────────────────────────────────────────────────────────

export const themesRouter = Router();

// ─── Public logo endpoint (no auth) ──────────────────────────────────────────

export const themesPublicRouter = Router();

const ALLOWED_MIME_TYPES = ['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'];
const LOGO_MAX_BYTES = 512 * 1024; // 512 KB

/**
 * `memberImages` are this theme's `theme_member_images` rows (#732), passed in
 * rather than fetched here so a list of N themes costs one query, not N — #732
 * asks for the Members configuration inside the existing Theme payload and
 * explicitly not as six requests of its own.
 */
function shapeTheme(row: any, memberImages: MemberImageRow[] = []) {
  const { logo_bytes: _lb, ...rest } = row;
  return {
    ...rest,
    // #732: always all six fields; `null` is "this slot is not configured", and
    // the Members App answers it with the theme's background colour — it
    // resolves no fallback of its own, here or anywhere.
    members_images: memberImageUrls(memberImages),
    type: row.gym_id === null ? 'system' : 'custom',
    has_logo: !!row.logo_mime,
    is_system_default: !!row.is_system_default,
    logo_contains_gym_name: !!row.logo_contains_gym_name,
    tokens: typeof row.tokens === 'string' ? JSON.parse(row.tokens) : (row.tokens ?? null),
  };
}

/** The Members image rows of one Base Theme, for single-theme responses (#732). */
async function loadThemeMemberImages(themeId: string): Promise<MemberImageRow[]> {
  return (await loadPlatformMemberImagesByTheme([themeId])).get(themeId) ?? [];
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
  const memberImages = await loadPlatformMemberImagesByTheme(rows.map((r: any) => r.id));
  res.json(rows.map((r: any) => ({
    ...shapeTheme(r, memberImages.get(r.id) ?? []),
    usage_count: Number(r.usage_count),
  })));
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
    ...shapeTheme(row, await loadThemeMemberImages(row.id)),
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

// ─── Members App background images (base themes) ─────────────────────────────
//
// #732: the six fixed slots a Custom Theme has carried since #725, now on a
// Base Theme too — stored in the *platform's* own R2 folder, under
// `cordel/Themes/<theme_id>-<name>/Members/<slot>.png`.
//
// The routes below take neither the folder nor the object key from the request:
// the prefix is the `cordel` constant, the theme is looked up with
// `gym_id IS NULL` (so a Custom Theme is simply 404 here, whoever asks) and the
// key is derived from those two plus the slot. That is what makes "a client
// must not be able to manipulate another Theme's assets by changing the Theme
// ID or storage path" true by construction. `requireSuperadmin` is the same
// authorization every other Base Theme write on this router uses.
//
// The storage failure modes are #417's, as the Custom Theme routes use them:
// 503 when the deployment has no R2, 502 when an R2 call fails. There is no 409
// counterpart — the platform folder is a constant, not a per-gym row, and its
// markers are written by the upload itself.

/** The Base Theme this request may write Members images to, or null (404 sent). */
async function resolveWritableBaseTheme(
  themeId: string,
  res: express.Response,
): Promise<{ id: string; name: string } | null> {
  const { rows } = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM themes WHERE id = ? AND gym_id IS NULL AND deleted_at IS NULL',
    [themeId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Theme not found' });
    return null;
  }
  return rows[0];
}

themesRouter.post(
  '/:id/members-images/:slot',
  requireSuperadmin,
  express.raw({ type: (req: any) => (req.headers['content-type'] ?? '').startsWith('image/'), limit: MEMBER_IMAGE_MAX_BYTES + 64 * 1024 }),
  async (req, res) => {
    const slot = req.params.slot;
    if (!isMemberImageSlot(slot)) {
      return res.status(400).json({ error: `Unknown Members image slot. Allowed: ${MEMBER_IMAGE_SLOTS.join(', ')}` });
    }
    const mime = req.headers['content-type']?.split(';')[0]?.trim();
    if (!mime || !(MEMBER_IMAGE_MIME_TYPES as readonly string[]).includes(mime)) {
      return res.status(415).json({ error: `Unsupported image type. Allowed: ${MEMBER_IMAGE_MIME_TYPES.join(', ')}` });
    }
    // `req.body` is whatever a parser left there, and a request can make that a
    // string or an array — both of which carry a `length` and numeric indices,
    // so they would flow into the size and signature checks below as if they
    // were bytes (CodeQL `js/type-confusion-through-parameter-tampering`).
    const raw: unknown = req.body;
    if (typeof raw === 'string' || Array.isArray(raw) || !Buffer.isBuffer(raw)) {
      return res.status(400).json({ error: 'Request body must be raw image bytes' });
    }
    const body: Buffer = raw;
    if (body.length === 0) return res.status(400).json({ error: 'Request body is empty' });
    if (body.length > MEMBER_IMAGE_MAX_BYTES) {
      return res.status(413).json({ error: `Image exceeds ${MEMBER_IMAGE_MAX_BYTES / (1024 * 1024)} MB limit` });
    }
    // The header is the client's word; the signature is the file's. #732
    // requires the server to validate independently of the browser.
    if (!bytesMatchImageMime(mime, body)) {
      return res.status(400).json({ error: 'File contents do not match the declared image type' });
    }

    if (!isStorageConfigured()) {
      const missingConfig = getMissingStorageConfigKeys();
      return res.status(503).json({
        error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
        missingConfig,
      });
    }

    const theme = await resolveWritableBaseTheme(req.params.id as string, res);
    if (!theme) return;

    const key = buildThemeMemberImageKey(PLATFORM_STORAGE_ROOT, theme.id, theme.name, slot);
    // The row before this upload: it is what stays in place if anything below
    // fails, which is how "the existing image remains available if replacement
    // fails" holds — nothing is written until the new object is in the bucket.
    const { rows: previous } = await db.query<{ object_key: string }>(
      'SELECT object_key FROM theme_member_images WHERE gym_id IS NULL AND theme_id = ? AND slot = ?',
      [theme.id, slot],
    );

    try {
      await ensureStorageFolders(themeMemberFolderKeys(PLATFORM_STORAGE_ROOT, theme.id, theme.name));
      await uploadStorageObject(key, mime, body);
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'uploadStorageObject', key });
      logger.error(
        { err, details, diagnostics: getStorageDiagnostics(), themeId: theme.id, slot },
        'Cloudflare R2 base theme Members image upload failed',
      );
      return res.status(502).json({ error: `Failed to upload image: ${details.message}`, details });
    }

    // The key is deterministic, so a replacement normally overwrites the object
    // it replaces and there is nothing to clean up. The exception is a theme
    // renamed since the last upload: its folder moved, so the row's old key is
    // now unreachable. Removing it is best-effort *after* the new object is
    // safely stored — a failure here is an orphan to sweep, not a failed save.
    const staleKey = previous[0]?.object_key;
    if (staleKey && staleKey !== key) {
      try {
        await deleteStorageObject(staleKey);
      } catch (err: any) {
        const details = err instanceof StorageOperationError
          ? err.details
          : describeStorageError(err, { operation: 'deleteStorageObject', key: staleKey });
        logger.warn(
          { err, details, themeId: theme.id, slot },
          'Replaced base theme Members image left an orphaned object in Cloudflare R2',
        );
      }
    }

    // One upsert against `uq_theme_member_images (theme_id, slot)` rather than a
    // branch on the row read above: two uploads of the same slot racing each
    // other would otherwise both see "no row" and the second would fail on the
    // unique key. `modified_at` is assigned explicitly because a replacement
    // writes the *same* key and MySQL skips a row whose assigned values all
    // match — which would freeze the `?v=` cache-buster the Members App reads.
    // `gym_id` is assigned too, so whichever router wrote last also owns the
    // row: the column is what says whether an image is the platform's, and no
    // cross-table CHECK can keep it in step with `themes.gym_id`.
    await db.query(
      `INSERT INTO theme_member_images (gym_id, theme_id, slot, object_key, created_at, modified_at)
       VALUES (NULL, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE
         gym_id      = VALUES(gym_id),
         object_key  = VALUES(object_key),
         modified_at = UTC_TIMESTAMP()`,
      [theme.id, slot, key],
    );

    const { rows } = await db.query(
      'SELECT id, gym_id, is_system_default, name, description, status, logo_mime, logo_updated_at, logo_contains_gym_name, tokens, created_at, modified_at FROM themes WHERE id = ?',
      [theme.id],
    );
    res.json(shapeTheme(rows[0], await loadThemeMemberImages(theme.id)));
  },
);

themesRouter.delete('/:id/members-images/:slot', requireSuperadmin, async (req, res) => {
  const slot = req.params.slot;
  if (!isMemberImageSlot(slot)) {
    return res.status(400).json({ error: `Unknown Members image slot. Allowed: ${MEMBER_IMAGE_SLOTS.join(', ')}` });
  }
  const theme = await resolveWritableBaseTheme(req.params.id as string, res);
  if (!theme) return;

  // #732, deliberately unlike the logo: Remove clears the reference and leaves
  // the object in the bucket. The row — not the object — is what makes a slot
  // configured, so the slot reads `null` immediately, and re-uploading later
  // writes the same deterministic key again rather than a second one. Nothing
  // here touches storage, so nothing here can fail on it.
  await db.query(
    'DELETE FROM theme_member_images WHERE gym_id IS NULL AND theme_id = ? AND slot = ?',
    [theme.id, slot],
  );

  const { rows } = await db.query(
    'SELECT id, gym_id, is_system_default, name, description, status, logo_mime, logo_updated_at, logo_contains_gym_name, tokens, created_at, modified_at FROM themes WHERE id = ?',
    [theme.id],
  );
  res.json(shapeTheme(rows[0], await loadThemeMemberImages(theme.id)));
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
