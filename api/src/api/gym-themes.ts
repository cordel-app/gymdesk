import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { validateTokens } from '../domain/themeTokens';
import { themeLogoUrl } from '../domain/themeLogo';
import {
  bytesMatchImageMime,
  buildThemeMemberImageKey,
  emptyMemberImageUrls,
  isMemberImageSlot,
  MEMBER_IMAGE_MAX_BYTES,
  MEMBER_IMAGE_MIME_TYPES,
  MEMBER_IMAGE_SLOTS,
  memberImageUrls,
  themeMemberFolderKeys,
  type MemberImageRow,
} from '../domain/themeMemberImages';
import { loadMemberImagesByTheme } from './theme-member-images';
import {
  buildGymLogoKey,
  deleteStorageObject,
  describeStorageError,
  ensureStorageFolders,
  getMissingStorageConfigKeys,
  getStorageDiagnostics,
  isStorageConfigured,
  StorageOperationError,
  uploadStorageObject,
} from '../infra/storage';
import { logger } from '../lib/logger';

// ─── Gym-admin theme management ───────────────────────────────────────────────

export const gymThemesRouter = Router();

const ALLOWED_MIME_TYPES = ['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'];
const LOGO_MAX_BYTES = 512 * 1024;

/**
 * `gymThemeId` is the requesting gym's currently selected theme (`gyms.theme_id`);
 * it drives `is_gym_theme` (#712), the only piece of the shape that depends on
 * the caller rather than on the row itself.
 *
 * `memberImages` are this theme's `theme_member_images` rows (#725), passed in
 * rather than fetched here so a list of N themes costs one query, not N — #725
 * asks for the Members configuration inside the existing Theme payload and
 * explicitly not as six requests of its own.
 */
function shapeTheme(row: any, gymThemeId: string | null = null, memberImages: MemberImageRow[] = []) {
  const { logo_bytes: _lb, logo_object_key: _lk, ...rest } = row;
  return {
    ...rest,
    // #725: always all six fields; `null` is "this slot is not configured", and
    // the Members App answers it with the theme's background colour. A Base
    // Theme has no gym folder to store an image in (out of scope), so it always
    // reads as six nulls.
    members_images: row.gym_id === null ? emptyMemberImageUrls() : memberImageUrls(memberImages),
    is_base: row.gym_id === null,
    has_logo: !!row.logo_mime,
    // #713: where the binary actually is, for a Custom Theme logo stored in the
    // gym's R2 folder. Null for a logo that is still a blob (every Base Theme,
    // and a Custom one uploaded before migration 180) — `GET /themes/:id/logo`
    // serves both, so a client can treat this as "load it straight from R2 when
    // you can" rather than as the only way to reach the logo.
    logo_url: themeLogoUrl(row),
    logo_contains_gym_name: !!row.logo_contains_gym_name,
    is_gym_theme: gymThemeId !== null && row.id === gymThemeId,
    tokens: typeof row.tokens === 'string' ? JSON.parse(row.tokens) : (row.tokens ?? null),
  };
}

const SELECT_COLS = 'id, gym_id, name, description, status, logo_mime, logo_updated_at, logo_object_key, logo_contains_gym_name, tokens, created_at, created_by_name, created_by_type, modified_at, deleted_at';

/** The Members image rows of one theme, for the single-theme responses (#725). */
async function loadThemeMemberImages(gymId: string, themeId: string): Promise<MemberImageRow[]> {
  return (await loadMemberImagesByTheme([gymId], [themeId])).get(themeId) ?? [];
}

/** The theme currently assigned to this gym, or null when it has none. */
async function getGymThemeId(gymId: string): Promise<string | null> {
  const { rows } = await db.query<{ theme_id: string | null }>('SELECT theme_id FROM gyms WHERE id = ?', [gymId]);
  return rows[0]?.theme_id ?? null;
}

async function checkGymThemeProtected(id: string, gymId: string): Promise<{ isGymDefault: boolean; centerCount: number }> {
  const { rows: gymRefs } = await db.query<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM gyms WHERE theme_id = ? AND id = ?',
    [id, gymId],
  );
  const { rows: centerRefs } = await db.query<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM centers WHERE theme_id = ? AND gym_id = ? AND deleted_at IS NULL',
    [id, gymId],
  );
  return {
    isGymDefault: Number(gymRefs[0].cnt) > 0,
    centerCount: Number(centerRefs[0].cnt),
  };
}

// ─── List: base themes + customer themes for this gym ─────────────────────────

gymThemesRouter.get('/', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const status = req.query.status as string | undefined;
      const params: any[] = [gymId];
      let statusClause = 'AND deleted_at IS NULL';
      if (status) {
        statusClause = 'AND status = ?';
        params.push(status);
      }
      const { rows } = await db.query(
        `SELECT ${SELECT_COLS} FROM themes
         WHERE (gym_id IS NULL OR gym_id = ?) ${statusClause}
         ORDER BY gym_id IS NULL DESC, created_at ASC`,
        params,
      );
      const gymThemeId = await getGymThemeId(gymId);
      const memberImages = await loadMemberImagesByTheme([gymId]);
      res.json(rows.map((row) => shapeTheme(row, gymThemeId, memberImages.get(row.id) ?? [])));
    });
  } catch (err) { next(err); }
});

// ─── Clone a theme (base or customer) into a customer theme ───────────────────

gymThemesRouter.post('/clone/:sourceId', async (req, res, next) => {
  try {
    const { gymId, actorName, isSuperadmin } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const { rows: source } = await db.query(
        `SELECT ${SELECT_COLS} FROM themes
         WHERE id = ? AND deleted_at IS NULL AND (gym_id IS NULL OR gym_id = ?)`,
        [req.params.sourceId, gymId],
      );
      if (source.length === 0) return res.status(404).json({ error: 'Theme not found' });

      const src = source[0];
      const baseName = req.body?.name?.trim() || `${src.name} (copy)`;

      // Ensure name uniqueness within the gym's customer themes.
      const { rows: nameConflict } = await db.query(
        'SELECT id FROM themes WHERE gym_id = ? AND name = ? AND deleted_at IS NULL',
        [gymId, baseName],
      );
      if (nameConflict.length > 0) return res.status(409).json({ error: 'A theme with this name already exists' });

      const id = randomUUID();
      const tokens = typeof src.tokens === 'string' ? src.tokens : JSON.stringify(src.tokens);
      // Cloning is the only way a customer theme comes into existence, so this
      // is where the creator snapshot is captured (#712).
      await db.query(
        `INSERT INTO themes (id, gym_id, name, status, logo_contains_gym_name, tokens, created_at, created_by_name, created_by_type)
         VALUES (?, ?, ?, 'draft', ?, ?, UTC_TIMESTAMP(), ?, ?)`,
        [id, gymId, baseName, src.logo_contains_gym_name, tokens, actorName, isSuperadmin ? 'superadmin' : 'staff'],
      );

      // No Members images: the clone gets its own, independent (and initially
      // empty) configuration. Cloning has never copied a theme's R2 assets —
      // it does not copy the logo either — and #725 makes copying them
      // conditional on it already doing so ("*if* the existing Theme cloning
      // mechanism copies Theme-owned R2 assets"). What it requires
      // unconditionally is independence, and a clone that starts unconfigured
      // shares no object path with its source and cannot be changed by it.
      const { rows } = await db.query(`SELECT ${SELECT_COLS} FROM themes WHERE id = ?`, [id]);
      const gymThemeId = await getGymThemeId(gymId);
      recordAudit(req, { action: 'clone', entityType: 'theme', entityId: id, next: shapeTheme(rows[0], gymThemeId) });
      res.status(201).json(shapeTheme(rows[0], gymThemeId));
    });
  } catch (err) { next(err); }
});

// ─── Update a customer theme ──────────────────────────────────────────────────

gymThemesRouter.put('/:id', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const { rows: existingRows } = await db.query(
        `SELECT ${SELECT_COLS} FROM themes WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
        [req.params.id, gymId],
      );
      if (existingRows.length === 0) return res.status(404).json({ error: 'Theme not found' });
      const current = existingRows[0];

      const { name, description, tokens, status, logo_contains_gym_name } = req.body;
      const ALLOWED_STATUSES = ['draft', 'active', 'inactive'];
      if (status !== undefined && !ALLOWED_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` });
      }
      if (logo_contains_gym_name !== undefined && typeof logo_contains_gym_name !== 'boolean') {
        return res.status(400).json({ error: 'logo_contains_gym_name must be a boolean' });
      }

      // Block status downgrade when theme is assigned
      if (status === 'draft' || status === 'inactive') {
        const { isGymDefault, centerCount } = await checkGymThemeProtected(req.params.id, gymId);
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
          'SELECT id FROM themes WHERE gym_id = ? AND name = ? AND deleted_at IS NULL AND id != ?',
          [gymId, name.trim(), req.params.id],
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
         WHERE id = ? AND gym_id = ?`,
        [name?.trim() ?? null, description !== undefined ? description : null, description ?? null, status ?? null, logo_contains_gym_name ?? null, JSON.stringify(tokensMerged), req.params.id, gymId],
      );
      const { rows } = await db.query(`SELECT ${SELECT_COLS} FROM themes WHERE id = ?`, [req.params.id]);
      const gymThemeId = await getGymThemeId(gymId);
      const memberImages = await loadThemeMemberImages(gymId, req.params.id);
      recordAudit(req, { action: 'update', entityType: 'theme', entityId: req.params.id, previous: shapeTheme(current, gymThemeId, memberImages), next: shapeTheme(rows[0], gymThemeId, memberImages) });
      res.json(shapeTheme(rows[0], gymThemeId, memberImages));
    });
  } catch (err) { next(err); }
});

// ─── Logo upload (customer themes only) ───────────────────────────────────────
//
// #713: the file goes into the gym's own R2 folder under the fixed key
// `<storage_folder_prefix>/Branding/Logo/logo.<ext>`, and the row keeps the key
// instead of the bytes. The folder prefix is read from the *tenant's* `gyms` row
// — never from the request — so a caller cannot aim an upload at another gym's
// storage, and the theme lookup already restricts the row to `gym_id = gymId`.
//
// That key names the *gym*, not the theme, which #713 is explicit about: there is
// one branding logo per gym and `Branding/Logo/` is its canonical location. A gym
// can hold several Custom Themes, so the upload also hands the branding slot over:
// every other theme of the gym that pointed at it stops claiming a logo (it falls
// back to the gym name, exactly as a theme that never had one). Without that
// hand-over the sibling rows would keep a reference to a file someone else has
// replaced — they would silently render the new gym's logo, and removing it from
// the theme that uploaded it would leave them pointing at nothing.
//
// The three storage failure modes reuse #417's conventions verbatim: 503 when
// the deployment has no R2 configured, 409 when this gym's folder was never
// initialized, 502 when the R2 call itself fails (structured `details`, no
// platform `diagnostics` — this route is gym-staff-facing; see storage.ts).

/** The tenant's R2 folder prefix, or a response explaining why there isn't one. */
async function resolveGymFolderPrefix(gymId: string, res: express.Response): Promise<string | null> {
  if (!isStorageConfigured()) {
    const missingConfig = getMissingStorageConfigKeys();
    res.status(503).json({
      error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
      missingConfig,
    });
    return null;
  }
  const { rows } = await db.query(
    'SELECT storage_folder_prefix FROM gyms WHERE id = ? AND deleted_at IS NULL',
    [gymId],
  );
  const folderPrefix: string | null = rows[0]?.storage_folder_prefix ?? null;
  if (!folderPrefix) {
    res.status(409).json({ error: 'Cloudflare storage has not been initialized for this gym, therefore images cannot be uploaded.' });
    return null;
  }
  return folderPrefix;
}

gymThemesRouter.post(
  '/:id/logo',
  express.raw({ type: (req: any) => (req.headers['content-type'] ?? '').startsWith('image/'), limit: '600kb' }),
  async (req, res, next) => {
    try {
      const { gymId } = getTenantContext(req);
      await requireRole('admin')(req, res, async () => {
        // The extension is derived from this validated MIME type, never from the
        // uploaded file's name — which never reaches the object key at all.
        const mime = req.headers['content-type']?.split(';')[0]?.trim();
        if (!mime || !ALLOWED_MIME_TYPES.includes(mime)) {
          return res.status(415).json({ error: `Unsupported image type. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}` });
        }
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'Request body is empty' });
        if (body.length > LOGO_MAX_BYTES) return res.status(413).json({ error: 'Logo exceeds 512 KB limit' });

        const { rows: existing } = await db.query(
          'SELECT id FROM themes WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
          [req.params.id, gymId],
        );
        if (existing.length === 0) return res.status(404).json({ error: 'Theme not found' });

        const folderPrefix = await resolveGymFolderPrefix(gymId, res);
        if (!folderPrefix) return;

        // Every key any of this gym's themes points at — all of them live in the
        // gym's own `Branding/Logo/`, since that is the only key this route ever
        // writes. Read before the upload so the set is the pre-upload state.
        const { rows: heldKeys } = await db.query<{ logo_object_key: string }>(
          'SELECT DISTINCT logo_object_key FROM themes WHERE gym_id = ? AND logo_object_key IS NOT NULL',
          [gymId],
        );

        const key = buildGymLogoKey(folderPrefix, mime);
        try {
          await uploadStorageObject(key, mime, body);
        } catch (err: any) {
          const details = err instanceof StorageOperationError
            ? err.details
            : describeStorageError(err, { operation: 'uploadStorageObject', key });
          logger.error(
            { err, details, diagnostics: getStorageDiagnostics(), gymId, themeId: req.params.id },
            'Cloudflare R2 theme logo upload failed',
          );
          return res.status(502).json({ error: `Failed to upload logo: ${details.message}`, details });
        }

        // Only one logo may exist in the gym's `Branding/Logo/`, and `logo.png`
        // and `logo.svg` are different keys — so a type change has to remove the
        // file it replaces. Best-effort *after* the new logo is safely stored:
        // the upload has already succeeded and is what the gym asked for, so a
        // failure here is an orphaned old file to clean up, not a failed save.
        for (const previousKey of heldKeys.map((r) => r.logo_object_key).filter((k) => k !== key)) {
          try {
            await deleteStorageObject(previousKey);
          } catch (err: any) {
            const details = err instanceof StorageOperationError
              ? err.details
              : describeStorageError(err, { operation: 'deleteStorageObject', key: previousKey });
            logger.warn(
              { err, details, gymId, themeId: req.params.id },
              'Replaced theme logo left an orphaned object in Cloudflare R2',
            );
          }
        }

        // One transaction so the gym can never be left with two themes claiming
        // the same object — see the hand-over note above. `logo_bytes = NULL`:
        // R2 is now the source of the binary, and leaving the old blob behind
        // would be a second copy the readers could prefer.
        await db.transaction(async (tx) => {
          await tx.query(
            `UPDATE themes SET logo_object_key = NULL, logo_mime = NULL, logo_updated_at = NULL
             WHERE gym_id = ? AND id <> ? AND logo_object_key IS NOT NULL`,
            [gymId, req.params.id],
          );
          await tx.query(
            'UPDATE themes SET logo_bytes = NULL, logo_object_key = ?, logo_mime = ?, logo_updated_at = UTC_TIMESTAMP() WHERE id = ?',
            [key, mime, req.params.id],
          );
        });
        const { rows } = await db.query(`SELECT ${SELECT_COLS} FROM themes WHERE id = ?`, [req.params.id]);
        res.json(shapeTheme(rows[0], await getGymThemeId(gymId), await loadThemeMemberImages(gymId, req.params.id)));
      });
    } catch (err) { next(err); }
  },
);

// ─── Logo delete (customer themes only) ──────────────────────────────────────

gymThemesRouter.delete('/:id/logo', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const { rows: existing } = await db.query(
        'SELECT id, logo_object_key FROM themes WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
        [req.params.id, gymId],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Theme not found' });

      // #713: an R2-backed logo is removed from the bucket first. Unlike the
      // orphan cleanup on replace, this failure is reported (502) and the row is
      // left alone: clearing the reference while the file survives would strand
      // an object nothing points at any more.
      const key: string | null = existing[0].logo_object_key ?? null;
      if (key) {
        try {
          await deleteStorageObject(key);
        } catch (err: any) {
          const details = err instanceof StorageOperationError
            ? err.details
            : describeStorageError(err, { operation: 'deleteStorageObject', key });
          logger.error(
            { err, details, diagnostics: getStorageDiagnostics(), gymId, themeId: req.params.id },
            'Cloudflare R2 theme logo delete failed',
          );
          return res.status(502).json({ error: `Failed to remove logo: ${details.message}`, details });
        }
      }

      // `logo_object_key = ?` rather than `id = ?`: the object is the gym's one
      // branding logo, so once it is gone no theme of this gym may keep claiming
      // it — including a soft-deleted one, which is why this is not scoped to
      // `deleted_at IS NULL`. Normally that is just this row (the upload hands
      // the slot over, so only one theme holds it at a time).
      await db.query(
        `UPDATE themes SET logo_bytes = NULL, logo_object_key = NULL, logo_mime = NULL, logo_updated_at = NULL
         WHERE id = ? OR (gym_id = ? AND logo_object_key = ?)`,
        [req.params.id, gymId, key],
      );
      const { rows } = await db.query(`SELECT ${SELECT_COLS} FROM themes WHERE id = ?`, [req.params.id]);
      res.json(shapeTheme(rows[0], await getGymThemeId(gymId), await loadThemeMemberImages(gymId, req.params.id)));
    });
  } catch (err) { next(err); }
});

// ─── Members App background images (customer themes only) ────────────────────
//
// #725: six fixed slots per Custom Theme, each stored in the gym's own R2 folder
// under `<storage_folder_prefix>/Themes/<theme_id>-<name>/Members/<slot>.png`.
//
// Three things the routes below never take from the request: the gym (the
// folder prefix is read from the *tenant's* `gyms` row), the theme (the lookup
// is scoped to `gym_id = gymId`, so another gym's theme is simply 404) and the
// object key (it is derived from those two plus the slot). That is what makes
// "a gym must not be able to manipulate another gym's Theme assets by changing
// gym_id, theme_id, the Theme name, the storage path or request parameters"
// true by construction rather than by a check that could be forgotten.
//
// The storage failure modes are #417's, as the logo routes use them: 503 when
// the deployment has no R2, 409 when this gym's folder was never initialized,
// 502 when an R2 call fails.

/** The Custom Theme this gym may write Members images to, or null (404 sent). */
async function resolveWritableTheme(
  themeId: string,
  gymId: string,
  res: express.Response,
): Promise<{ id: string; name: string } | null> {
  const { rows } = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM themes WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [themeId, gymId],
  );
  if (rows.length === 0) {
    // Also the answer for a Base Theme (`gym_id IS NULL`): Base Theme Members
    // images are out of scope, and the platform has no gym folder to store one
    // in — see the migration.
    res.status(404).json({ error: 'Theme not found' });
    return null;
  }
  return rows[0];
}

gymThemesRouter.post(
  '/:id/members-images/:slot',
  express.raw({ type: (req: any) => (req.headers['content-type'] ?? '').startsWith('image/'), limit: MEMBER_IMAGE_MAX_BYTES + 64 * 1024 }),
  async (req, res, next) => {
    try {
      const { gymId } = getTenantContext(req);
      await requireRole('admin')(req, res, async () => {
        const slot = req.params.slot;
        if (!isMemberImageSlot(slot)) {
          return res.status(400).json({ error: `Unknown Members image slot. Allowed: ${MEMBER_IMAGE_SLOTS.join(', ')}` });
        }
        const mime = req.headers['content-type']?.split(';')[0]?.trim();
        if (!mime || !(MEMBER_IMAGE_MIME_TYPES as readonly string[]).includes(mime)) {
          return res.status(415).json({ error: `Unsupported image type. Allowed: ${MEMBER_IMAGE_MIME_TYPES.join(', ')}` });
        }
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'Request body is empty' });
        if (body.length > MEMBER_IMAGE_MAX_BYTES) {
          return res.status(413).json({ error: `Image exceeds ${MEMBER_IMAGE_MAX_BYTES / (1024 * 1024)} MB limit` });
        }
        // The header is the client's word; the signature is the file's. #725
        // requires the server to validate independently of the browser.
        if (!bytesMatchImageMime(mime, body)) {
          return res.status(400).json({ error: 'File contents do not match the declared image type' });
        }

        const theme = await resolveWritableTheme(req.params.id, gymId, res);
        if (!theme) return;

        const folderPrefix = await resolveGymFolderPrefix(gymId, res);
        if (!folderPrefix) return;

        const key = buildThemeMemberImageKey(folderPrefix, theme.id, theme.name, slot);
        // The row before this upload: it is what stays in place if anything
        // below fails, which is how "the existing image remains available if
        // replacement fails" holds — nothing is written until the new object is
        // in the bucket.
        const { rows: previous } = await db.query<{ object_key: string }>(
          'SELECT object_key FROM theme_member_images WHERE gym_id = ? AND theme_id = ? AND slot = ?',
          [gymId, theme.id, slot],
        );

        try {
          await ensureStorageFolders(themeMemberFolderKeys(folderPrefix, theme.id, theme.name));
          await uploadStorageObject(key, mime, body);
        } catch (err: any) {
          const details = err instanceof StorageOperationError
            ? err.details
            : describeStorageError(err, { operation: 'uploadStorageObject', key });
          logger.error(
            { err, details, diagnostics: getStorageDiagnostics(), gymId, themeId: theme.id, slot },
            'Cloudflare R2 theme Members image upload failed',
          );
          return res.status(502).json({ error: `Failed to upload image: ${details.message}`, details });
        }

        // The key is deterministic, so a replacement normally overwrites the
        // object it replaces and there is nothing to clean up. The exception is
        // a theme renamed since the last upload: its folder moved, so the row's
        // old key is now unreachable. Removing it is best-effort *after* the new
        // object is safely stored — a failure here is an orphan to sweep, not a
        // failed save.
        const staleKey = previous[0]?.object_key;
        if (staleKey && staleKey !== key) {
          try {
            await deleteStorageObject(staleKey);
          } catch (err: any) {
            const details = err instanceof StorageOperationError
              ? err.details
              : describeStorageError(err, { operation: 'deleteStorageObject', key: staleKey });
            logger.warn(
              { err, details, gymId, themeId: theme.id, slot },
              'Replaced Members image left an orphaned object in Cloudflare R2',
            );
          }
        }

        // One upsert against `uq_theme_member_images (theme_id, slot)` rather
        // than a branch on the row read above: two uploads of the same slot
        // racing each other would otherwise both see "no row" and the second
        // would fail on the unique key.
        //
        // `modified_at` is assigned explicitly rather than left to the column's
        // `ON UPDATE CURRENT_TIMESTAMP`: a replacement normally writes the
        // *same* key, and MySQL skips a row whose assigned values all match, so
        // the auto-stamp would keep pointing at the previous upload — and the
        // `?v=` cache-buster derived from it would let the Members App go on
        // serving the image this call just replaced. `UTC_TIMESTAMP()` because
        // every DATETIME in this schema is UTC (`timezone: 'Z'`,
        // docs/architecture.md).
        await db.query(
          `INSERT INTO theme_member_images (gym_id, theme_id, slot, object_key, created_at, modified_at)
           VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
           ON DUPLICATE KEY UPDATE
             object_key  = VALUES(object_key),
             modified_at = UTC_TIMESTAMP()`,
          [gymId, theme.id, slot, key],
        );

        const { rows } = await db.query(`SELECT ${SELECT_COLS} FROM themes WHERE id = ?`, [theme.id]);
        res.json(shapeTheme(rows[0], await getGymThemeId(gymId), await loadThemeMemberImages(gymId, theme.id)));
      });
    } catch (err) { next(err); }
  },
);

gymThemesRouter.delete('/:id/members-images/:slot', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const slot = req.params.slot;
      if (!isMemberImageSlot(slot)) {
        return res.status(400).json({ error: `Unknown Members image slot. Allowed: ${MEMBER_IMAGE_SLOTS.join(', ')}` });
      }
      const theme = await resolveWritableTheme(req.params.id, gymId, res);
      if (!theme) return;

      // #725, deliberately unlike the logo: Remove clears the reference and
      // leaves the object in the bucket. The row — not the object — is what
      // makes a slot configured, so the slot reads `null` immediately, and
      // re-uploading later writes the same deterministic key again rather than
      // a second one. Nothing here touches storage, so nothing here can fail
      // on it.
      await db.query(
        'DELETE FROM theme_member_images WHERE gym_id = ? AND theme_id = ? AND slot = ?',
        [gymId, theme.id, slot],
      );

      const { rows } = await db.query(`SELECT ${SELECT_COLS} FROM themes WHERE id = ?`, [theme.id]);
      res.json(shapeTheme(rows[0], await getGymThemeId(gymId), await loadThemeMemberImages(gymId, theme.id)));
    });
  } catch (err) { next(err); }
});

// ─── Soft delete (customer themes only) ──────────────────────────────────────

gymThemesRouter.delete('/:id', async (req, res, next) => {
  try {
    const { gymId, actorName } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const { rows: existing } = await db.query(
        'SELECT id, deleted_at FROM themes WHERE id = ? AND gym_id = ?',
        [req.params.id, gymId],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Theme not found' });
      if (existing[0].deleted_at) return res.status(409).json({ error: 'Theme is already deleted' });

      const { isGymDefault, centerCount } = await checkGymThemeProtected(req.params.id, gymId);
      if (isGymDefault) {
        return res.status(409).json({ error: 'This Theme cannot be deleted because it is configured as the Gym Default Theme.' });
      }
      if (centerCount > 0) {
        return res.status(409).json({ error: 'This Theme cannot be deleted because it is assigned to one or more Centers.' });
      }

      await db.query(
        "UPDATE themes SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by_name = ? WHERE id = ?",
        [actorName, req.params.id],
      );
      recordAudit(req, { action: 'delete', entityType: 'theme', entityId: req.params.id });
      res.status(204).send();
    });
  } catch (err) { next(err); }
});

// ─── Assignments: get org-default status + centers using this theme ────────────

gymThemesRouter.get('/:id/assignments', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      // Verify the theme is accessible to this gym (base or customer)
      const { rows: themeRows } = await db.query(
        'SELECT id FROM themes WHERE id = ? AND deleted_at IS NULL AND (gym_id IS NULL OR gym_id = ?)',
        [req.params.id, gymId],
      );
      if (themeRows.length === 0) return res.status(404).json({ error: 'Theme not found' });

      const { rows: gymRows } = await db.query('SELECT theme_id FROM gyms WHERE id = ?', [gymId]);
      const is_gym_default = gymRows[0]?.theme_id === req.params.id;

      const { rows: centers } = await db.query(
        `SELECT c.id, c.name, (c.theme_id IS NULL) AS is_inherited
         FROM centers c
         JOIN gyms g ON g.id = c.gym_id
         WHERE c.gym_id = ? AND c.deleted_at IS NULL
           AND (c.theme_id = ? OR (c.theme_id IS NULL AND g.theme_id = ?))
         ORDER BY c.name ASC`,
        [gymId, req.params.id, req.params.id],
      );

      res.json({ is_gym_default, centers: centers.map((c: any) => ({ ...c, is_inherited: !!c.is_inherited })) });
    });
  } catch (err) { next(err); }
});

// ─── Assignments: set as gym default ─────────────────────────────────────────

gymThemesRouter.put('/:id/set-default', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const { rows: themeRows } = await db.query(
        'SELECT id, status FROM themes WHERE id = ? AND deleted_at IS NULL AND (gym_id IS NULL OR gym_id = ?)',
        [req.params.id, gymId],
      );
      if (themeRows.length === 0) return res.status(404).json({ error: 'Theme not found' });
      if (themeRows[0].status !== 'active') {
        return res.status(400).json({ error: 'Only Active themes can be set as the Gym Default Theme.' });
      }

      await db.query('UPDATE gyms SET theme_id = ? WHERE id = ?', [req.params.id, gymId]);
      recordAudit(req, { action: 'update', entityType: 'gym', entityId: gymId, next: { default_theme_id: req.params.id } });
      res.json({ ok: true });
    });
  } catch (err) { next(err); }
});

// ─── Assignments: list unassigned centers (for the picker) ────────────────────

gymThemesRouter.get('/:id/unassigned-centers', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const { rows: themeRows } = await db.query(
        'SELECT id FROM themes WHERE id = ? AND deleted_at IS NULL AND (gym_id IS NULL OR gym_id = ?)',
        [req.params.id, gymId],
      );
      if (themeRows.length === 0) return res.status(404).json({ error: 'Theme not found' });

      const { rows: centers } = await db.query(
        `SELECT c.id, c.name
         FROM centers c
         JOIN gyms g ON g.id = c.gym_id
         WHERE c.gym_id = ? AND c.deleted_at IS NULL
           AND NOT (c.theme_id = ? OR (c.theme_id IS NULL AND g.theme_id = ?))
         ORDER BY c.name ASC`,
        [gymId, req.params.id, req.params.id],
      );

      res.json(centers);
    });
  } catch (err) { next(err); }
});

// ─── Assignments: assign centers to this theme ────────────────────────────────

gymThemesRouter.post('/:id/assign-centers', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const { rows: themeRows } = await db.query(
        'SELECT id, status FROM themes WHERE id = ? AND deleted_at IS NULL AND (gym_id IS NULL OR gym_id = ?)',
        [req.params.id, gymId],
      );
      if (themeRows.length === 0) return res.status(404).json({ error: 'Theme not found' });
      if (themeRows[0].status !== 'active') {
        return res.status(400).json({ error: 'Only Active themes can be assigned to Centers.' });
      }

      const { center_ids } = req.body;
      if (!Array.isArray(center_ids) || center_ids.length === 0) {
        return res.status(400).json({ error: 'center_ids must be a non-empty array' });
      }

      // Verify all centers belong to this gym
      const placeholders = center_ids.map(() => '?').join(', ');
      const { rows: validCenters } = await db.query(
        `SELECT id FROM centers WHERE id IN (${placeholders}) AND gym_id = ? AND deleted_at IS NULL`,
        [...center_ids, gymId],
      );
      if (validCenters.length !== center_ids.length) {
        return res.status(400).json({ error: 'One or more centers not found' });
      }

      await db.query(
        `UPDATE centers SET theme_id = ? WHERE id IN (${placeholders}) AND gym_id = ?`,
        [req.params.id, ...center_ids, gymId],
      );
      res.json({ ok: true });
    });
  } catch (err) { next(err); }
});

// ─── Assignments: restore inheritance for a center ────────────────────────────

gymThemesRouter.delete('/:id/centers/:centerId', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const { rows: centerRows } = await db.query(
        'SELECT id, theme_id FROM centers WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
        [req.params.centerId, gymId],
      );
      if (centerRows.length === 0) return res.status(404).json({ error: 'Center not found' });
      if (centerRows[0].theme_id !== req.params.id) {
        return res.status(409).json({ error: 'Center is not explicitly assigned to this theme' });
      }

      await db.query('UPDATE centers SET theme_id = NULL WHERE id = ? AND gym_id = ?', [req.params.centerId, gymId]);
      res.json({ ok: true });
    });
  } catch (err) { next(err); }
});
