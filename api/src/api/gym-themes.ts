import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { validateTokens } from '../domain/themeTokens';
import { buildThemeLogoKey, themeLogoFolderKeys, themeLogoUrl } from '../domain/themeLogo';
import { themeStorageFolderKeys } from '../domain/themeFolders';
import {
  assignedCenterIds,
  planChangesNothing,
  themeCenterAssignmentPlan,
  unknownCenterIds,
  type ThemeCenterRow,
} from '../domain/themeCenterAssignments';
import { folderStageForKey, themeFolderStageForKey } from '../domain/storageFailureStage';
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
import { loadMemberImagesByTheme } from './theme-member-images';
import {
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
    // the Members App answers it with the theme's background colour.
    //
    // #732: a Base Theme now carries its own six as well — the platform's, in
    // `cordel/themes/…`, which is why this no longer forces a Base Theme to six
    // nulls. The gym reads them (its members see them if it runs that theme)
    // but cannot write them: the upload and remove routes below are scoped to
    // `gym_id = gymId` and answer 404 for a Base Theme, which is what keeps a
    // platform asset out of any one gym's hands.
    members_images: memberImageUrls(memberImages),
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
      // The theme ids are named so the read also picks up the platform's own
      // rows for the Base Themes in this list (#732) — without them it stays
      // strictly this gym's.
      const memberImages = await loadMemberImagesByTheme([gymId], rows.map((row: any) => row.id));
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

      // #827: a Custom Theme cannot exist without somewhere to keep its assets,
      // so the gym's bucket is checked *before* the row is written — a
      // deployment with no R2 answers 503 and a gym whose folder tree was never
      // initialized answers 409, and in both cases no theme is created. Cloning
      // is the only way a Custom Theme comes into existence (there is no
      // gym-side `POST /system/themes`), so this one check covers both the
      // Create and the Clone flow of the ticket.
      const folderPrefix = await resolveGymFolderPrefix(
        gymId,
        res,
        'Cloudflare storage has not been initialized for this gym, therefore a theme cannot be created.',
      );
      if (!folderPrefix) return;

      // The new theme's own folder and its `Logo/` and `Members/` leaves. Written
      // before the INSERT rather than after it, which is what makes the failure
      // mode the ticket forbids impossible: a storage error leaves no theme
      // behind to be half-created, and the markers a later retry re-writes are
      // zero-byte objects whose keys end in `/`, so re-creating them is
      // idempotent (§8) and can never overwrite a real object.
      if (!(await ensureThemeStorage(res, folderPrefix, id, baseName, { gymId, sourceThemeId: src.id }))) return;

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
// #824: the file goes into the theme's *own* folder inside the gym's R2 tree,
// under `<storage_folder_prefix>/themes/<theme_id>-<name>/logo/logo.<ext>`. The
// folder prefix is read from the *tenant's* `gyms` row — never from the request
// — so a caller cannot aim an upload at another gym's storage, and the theme
// lookup already restricts the row to `gym_id = gymId`.
//
// The key names the *theme*, so each theme of a gym holds its own logo and an
// upload takes nothing away from its siblings. That replaces #713's gym-wide
// `Branding/Logo/logo.<ext>` and the hand-over that came with it: `Branding/` is
// obsolete and nothing writes there any more. Rows written before this are left
// exactly as they are (§6 of the ticket) — they still render from their stored
// key, and move to the theme folder the next time the logo is replaced.
//
// The theme's own folder and its `Logo/` leaf are created on demand
// (`themeLogoFolderKeys`), the same way #725 creates `Members/`. The gym-level
// `themes/` root is deliberately *not*: it belongs to Gym Bucket Initialization
// (#735), and until it exists the control is disabled in the admin (#823) and
// this route answers 409.
//
// The three storage failure modes reuse #417's conventions verbatim: 503 when
// the deployment has no R2 configured, 409 when this gym's folder was never
// initialized, 502 when the R2 call itself fails (structured `details`, no
// platform `diagnostics` — this route is gym-staff-facing; see storage.ts).
// Every one of them names the `stage` it failed at and, once known, the `path`
// it was working on, so the admin sees which step broke rather than a bare
// message (#824).

/**
 * The tenant's R2 folder prefix, or a response explaining why there isn't one.
 *
 * `notInitialized` is the 409's wording: the uploads say images cannot be
 * uploaded, while Theme creation (#827) says a Theme cannot be created — the
 * same missing folder tree, two different things the admin was trying to do.
 */
async function resolveGymFolderPrefix(
  gymId: string,
  res: express.Response,
  notInitialized = 'Cloudflare storage has not been initialized for this gym, therefore images cannot be uploaded.',
): Promise<string | null> {
  if (!isStorageConfigured()) {
    const missingConfig = getMissingStorageConfigKeys();
    res.status(503).json({
      error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
      stage: 'resolve_path',
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
    res.status(409).json({ error: notInitialized, stage: 'resolve_path' });
    return null;
  }
  return folderPrefix;
}

/**
 * Writes a Theme's own folder tree — `themes/<theme_id>-<sanitized name>/` with
 * its `Logo/` and `Members/` leaves — and answers `502` naming the marker that
 * broke when R2 refuses. The markers it wrote come back on success, `null` means
 * the response has already been sent.
 *
 * Shared by its two callers rather than inlined twice: Theme creation writes the
 * tree before the row exists (#827) and `POST /:id/storage/initialize` re-writes
 * it for a Theme that already does (#828). The keys, the stage and the failure
 * shape are the same operation either way — only what is logged beside it
 * differs.
 */
async function ensureThemeStorage(
  res: express.Response,
  folderPrefix: string,
  themeId: string,
  themeName: string,
  logContext: Record<string, unknown>,
): Promise<string[] | null> {
  const themeFolderKeys = themeStorageFolderKeys(folderPrefix, themeId, themeName);
  try {
    await ensureStorageFolders(themeFolderKeys);
    return themeFolderKeys;
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'ensureStorageFolders', key: themeFolderKeys[0] });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), ...logContext },
      'Cloudflare R2 theme folder creation failed',
    );
    res.status(502).json({
      error: `Failed to create the theme storage folders: ${details.message}`,
      stage: themeFolderStageForKey(details.key, themeFolderKeys),
      path: details.key ?? themeFolderKeys[0],
      details,
    });
    return null;
  }
}

// ─── Initialize a Custom Theme's Cloudflare storage structure (#828) ──────────

/**
 * Creates (or re-creates) the folders a Theme's own assets live in:
 * `<gym prefix>/themes/<theme_id>-<sanitized name>/` with its `Logo/` and
 * `Members/` leaves. Theme creation already writes them (#827); this is the
 * manual, explicitly repeatable version, for a Theme whose folders are not there
 * — one created before #827, or one renamed since (a rename moves the folder,
 * and nothing re-creates it until the next upload).
 *
 * It initializes the **Theme's** structure and nothing above it (§5): the gym
 * root and its `themes/` branch belong to Gym Bucket Initialization (#735), so a
 * gym with no `storage_folder_prefix` is a `409` here rather than having its tree
 * papered over — which is also what the disabled menu item states in the admin
 * (#823).
 *
 * Idempotent by construction (§3): the markers are zero-byte objects whose keys
 * end in `/`, so re-writing one overwrites another marker and can never touch a
 * real object. Nothing here reads, deletes or overwrites a file, and nothing
 * writes to `themes` — the Theme's id, name and configuration are untouched.
 */
gymThemesRouter.post('/:id/storage/initialize', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      // A Base Theme is a `gym_id IS NULL` row and so is 404 here, whoever asks:
      // its objects are the platform's (`cordel/…`) and are initialized by
      // `POST /platform/themes/:id/storage/initialize`.
      const { rows } = await db.query<{ id: string; name: string }>(
        'SELECT id, name FROM themes WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
        [req.params.id, gymId],
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Theme not found' });
      const theme = rows[0];

      const folderPrefix = await resolveGymFolderPrefix(
        gymId,
        res,
        'Cloudflare storage has not been initialized for this gym, therefore the theme folders cannot be created.',
      );
      if (!folderPrefix) return;

      const folders = await ensureThemeStorage(res, folderPrefix, theme.id, theme.name, { gymId, themeId: theme.id });
      if (!folders) return;

      recordAudit(req, {
        action: 'initialize_storage',
        entityType: 'theme',
        entityId: theme.id,
        next: { folders },
      });
      res.json({ initialized: true, folders });
    });
  } catch (err) { next(err); }
});

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

        // The theme's `name` is part of its folder, so it is read here rather
        // than assumed: a renamed theme writes to its new folder and the key it
        // held before is cleaned up below, exactly as a type change is.
        const { rows: existing } = await db.query<{ id: string; name: string; logo_object_key: string | null }>(
          'SELECT id, name, logo_object_key FROM themes WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
          [req.params.id, gymId],
        );
        if (existing.length === 0) return res.status(404).json({ error: 'Theme not found' });
        const theme = existing[0];

        const folderPrefix = await resolveGymFolderPrefix(gymId, res);
        if (!folderPrefix) return;

        const key = buildThemeLogoKey(folderPrefix, theme.id, theme.name, mime);

        // `themes/<theme_id>-<name>/` and its `Logo/` leaf, created on demand.
        // Idempotent: every key ends in `/`, so what it overwrites is always
        // another zero-byte marker and never a file.
        const logoFolderKeys = themeLogoFolderKeys(folderPrefix, theme.id, theme.name);
        try {
          await ensureStorageFolders(logoFolderKeys);
        } catch (err: any) {
          const details = err instanceof StorageOperationError
            ? err.details
            : describeStorageError(err, { operation: 'ensureStorageFolders', key });
          logger.error(
            { err, details, diagnostics: getStorageDiagnostics(), gymId, themeId: theme.id },
            'Cloudflare R2 theme logo folder creation failed',
          );
          return res.status(502).json({
            error: `Failed to create the theme logo folder: ${details.message}`,
            stage: folderStageForKey(details.key, logoFolderKeys, 'create_logo_folder'),
            path: details.key ?? key,
            details,
          });
        }

        try {
          await uploadStorageObject(key, mime, body);
        } catch (err: any) {
          const details = err instanceof StorageOperationError
            ? err.details
            : describeStorageError(err, { operation: 'uploadStorageObject', key });
          logger.error(
            { err, details, diagnostics: getStorageDiagnostics(), gymId, themeId: theme.id },
            'Cloudflare R2 theme logo upload failed',
          );
          return res.status(502).json({
            error: `Failed to upload logo: ${details.message}`,
            stage: 'upload_logo',
            path: key,
            details,
          });
        }

        // One logo per theme: `logo.png` and `logo.svg` are different keys, and
        // so are two folders of a renamed theme, so whatever this theme pointed
        // at before — including a pre-#824 `Branding/Logo/` key — is removed.
        // Best-effort *after* the new logo is safely stored: the upload has
        // already succeeded and is what the gym asked for, so a failure here is
        // an orphaned old file to clean up, not a failed save. No other theme's
        // logo is touched (§6: existing logos are not deleted or moved).
        const previousKey = theme.logo_object_key;
        if (previousKey && previousKey !== key) {
          try {
            await deleteStorageObject(previousKey);
          } catch (err: any) {
            const details = err instanceof StorageOperationError
              ? err.details
              : describeStorageError(err, { operation: 'deleteStorageObject', key: previousKey });
            logger.warn(
              { err, details, gymId, themeId: theme.id },
              'Replaced theme logo left an orphaned object in Cloudflare R2',
            );
          }
        }

        // `logo_bytes = NULL`: R2 is now the source of the binary, and leaving
        // the old blob behind would be a second copy the readers could prefer.
        await db.query(
          'UPDATE themes SET logo_bytes = NULL, logo_object_key = ?, logo_mime = ?, logo_updated_at = UTC_TIMESTAMP() WHERE id = ?',
          [key, mime, theme.id],
        );
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
          return res.status(502).json({
            error: `Failed to remove logo: ${details.message}`,
            stage: 'remove_logo',
            path: key,
            details,
          });
        }
      }

      // #824: the key names this theme's own folder, so removing it concerns
      // this row alone — a sibling theme's logo is a different object and stays
      // where it is. (Before #824 one gym-wide key could be claimed by several
      // rows; the upload's hand-over kept that to one, so scoping the clear to
      // this row leaves no legacy row stranded either.)
      await db.query(
        `UPDATE themes SET logo_bytes = NULL, logo_object_key = NULL, logo_mime = NULL, logo_updated_at = NULL
         WHERE id = ?`,
        [req.params.id],
      );
      const { rows } = await db.query(`SELECT ${SELECT_COLS} FROM themes WHERE id = ?`, [req.params.id]);
      res.json(shapeTheme(rows[0], await getGymThemeId(gymId), await loadThemeMemberImages(gymId, req.params.id)));
    });
  } catch (err) { next(err); }
});

// ─── Members App background images (customer themes only) ────────────────────
//
// #725: six fixed slots per Custom Theme, each stored in the gym's own R2 folder
// under `<storage_folder_prefix>/themes/<theme_id>-<name>/members_app/<slot>.png`.
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
        // `req.body` is whatever a parser left there, and a request can make
        // that a string or an array — both of which have a `length` and numeric
        // indices, so they would flow into the size and signature checks below
        // as if they were bytes (CodeQL
        // `js/type-confusion-through-parameter-tampering`). Reject both
        // explicitly, then take the value as a Buffer or not at all: this route
        // is only ever reached through `express.raw`.
        const raw: unknown = req.body;
        if (typeof raw === 'string' || Array.isArray(raw) || !Buffer.isBuffer(raw)) {
          return res.status(400).json({ error: 'Request body must be raw image bytes' });
        }
        const body: Buffer = raw;
        if (body.length === 0) return res.status(400).json({ error: 'Request body is empty' });
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

        const memberFolderKeys = themeMemberFolderKeys(folderPrefix, theme.id, theme.name);
        try {
          await ensureStorageFolders(memberFolderKeys);
          await uploadStorageObject(key, mime, body);
        } catch (err: any) {
          const details = err instanceof StorageOperationError
            ? err.details
            : describeStorageError(err, { operation: 'uploadStorageObject', key });
          logger.error(
            { err, details, diagnostics: getStorageDiagnostics(), gymId, themeId: theme.id, slot },
            'Cloudflare R2 theme Members image upload failed',
          );
          return res.status(502).json({
            error: `Failed to upload image: ${details.message}`,
            // Two calls share this handler, so the stage is read off the one
            // that actually threw rather than assumed to be the upload.
            stage: details.operation === 'ensureStorageFolders'
              ? folderStageForKey(details.key, memberFolderKeys, 'create_members_folder')
              : 'upload_members_image',
            path: details.key ?? key,
            details,
          });
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
        //
        // `gym_id` is assigned too (#732): since migration 182 it may also be
        // NULL (the platform's), so whichever router wrote a slot last also
        // owns its row — no cross-table CHECK can keep the column in step with
        // `themes.gym_id`.
        await db.query(
          `INSERT INTO theme_member_images (gym_id, theme_id, slot, object_key, created_at, modified_at)
           VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
           ON DUPLICATE KEY UPDATE
             gym_id      = VALUES(gym_id),
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

      // #985: every Center of the gym, not only the ones using this theme — the
      // Assignments section is a checkbox list and an unticked box has to be a
      // Center you can tick. `is_assigned` is the Center's own `theme_id`
      // (null-safe `<=>`, since `theme_id = ?` is NULL for an inheriting
      // Center), and `is_inherited` says this theme reaches it through the Gym
      // Default instead — reported so the list can say so beside the name,
      // never as a checked box, because the box is what the save writes.
      const { rows: centers } = await db.query(
        `SELECT c.id, c.name,
                (c.theme_id <=> ?) AS is_assigned,
                (c.theme_id IS NULL AND g.theme_id <=> ?) AS is_inherited
         FROM centers c
         JOIN gyms g ON g.id = c.gym_id
         WHERE c.gym_id = ? AND c.deleted_at IS NULL
         ORDER BY c.name ASC`,
        [req.params.id, req.params.id, gymId],
      );

      res.json({
        is_gym_default,
        centers: centers.map((c: any) => ({
          id: c.id,
          name: c.name,
          is_assigned: !!c.is_assigned,
          is_inherited: !!c.is_inherited,
        })),
      });
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

// ─── Assignments: replace this theme's Center assignments (#985) ─────────────

/**
 * One replace-all write, so the Assignments section can be a checkbox list the
 * page's own Save persists: the submitted ids become this theme's Centers and a
 * Center the request leaves out goes back to inheriting the Gym Default Theme.
 * It replaces `POST /:id/assign-centers`, `GET /:id/unassigned-centers` and
 * `DELETE /:id/centers/:centerId` — a set edited as a set has one writer, and
 * the two halves must commit together or a half-saved list would assign some
 * Centers and leave others pointing at a theme the admin had unticked.
 */
gymThemesRouter.put('/:id/centers', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const { rows: themeRows } = await db.query(
        'SELECT id, status FROM themes WHERE id = ? AND deleted_at IS NULL AND (gym_id IS NULL OR gym_id = ?)',
        [req.params.id, gymId],
      );
      if (themeRows.length === 0) return res.status(404).json({ error: 'Theme not found' });

      const { center_ids } = req.body ?? {};
      if (!Array.isArray(center_ids) || center_ids.some((id: unknown) => typeof id !== 'string')) {
        return res.status(400).json({ error: 'center_ids must be an array of center ids' });
      }
      // An empty set is a legitimate save (every box unticked), so the Active
      // rule guards *assigning* rather than the request: a theme taken out of
      // service must still be removable from the Centers it was on.
      if (center_ids.length > 0 && themeRows[0].status !== 'active') {
        return res.status(400).json({ error: 'Only Active themes can be assigned to Centers.' });
      }

      const { rows: centers } = await db.query<ThemeCenterRow & { id: string }>(
        'SELECT id, theme_id FROM centers WHERE gym_id = ? AND deleted_at IS NULL',
        [gymId],
      );
      const unknown = unknownCenterIds(centers, center_ids);
      if (unknown.length > 0) return res.status(400).json({ error: 'One or more centers not found' });

      const plan = themeCenterAssignmentPlan(centers, req.params.id, center_ids);
      const previous = assignedCenterIds(centers, req.params.id);
      if (planChangesNothing(plan)) return res.json({ ok: true, assigned: previous });

      await db.transaction(async (tx) => {
        if (plan.clear.length > 0) {
          await tx.query(
            `UPDATE centers SET theme_id = NULL
             WHERE gym_id = ? AND id IN (${plan.clear.map(() => '?').join(', ')})`,
            [gymId, ...plan.clear],
          );
        }
        if (plan.assign.length > 0) {
          await tx.query(
            `UPDATE centers SET theme_id = ?
             WHERE gym_id = ? AND id IN (${plan.assign.map(() => '?').join(', ')})`,
            [req.params.id, gymId, ...plan.assign],
          );
        }
      });

      // Every requested id is a Center of this gym (the unknown check above), so
      // the set that is now stored is exactly what the request asked for.
      const assigned = Array.from(new Set<string>(center_ids));
      recordAudit(req, {
        action: 'update',
        entityType: 'theme',
        entityId: req.params.id,
        previous: { assigned_center_ids: previous },
        next: { assigned_center_ids: assigned },
      });
      res.json({ ok: true, assigned });
    });
  } catch (err) { next(err); }
});
