import express, { Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { logger } from '../lib/logger';
import { normalizeMuscleKey } from '../domain/muscles';
import {
  EXERCISE_IMAGE_MASTER_MAX_BYTES,
  EXERCISE_IMAGE_MIME,
  EXERCISE_IMAGE_THUMBNAIL_MAX_BYTES,
  validateExerciseImagePair,
} from '../domain/exerciseImages';
import {
  baseExerciseImageFolderKeys,
  buildBaseExerciseImageKey,
  buildBaseExerciseImageThumbnailKey,
  isPlatformOwnedExerciseImageUrl,
} from '../domain/baseExerciseImages';
import {
  EXERCISE_VIDEO_MIME,
  EXERCISE_VIDEO_POSTER_MAX_BYTES,
  EXERCISE_VIDEO_POSTER_MIME,
  exerciseVideoMaxBytes,
  validateExerciseVideoPair,
} from '../domain/exerciseVideos';
import {
  baseExerciseVideoFolderKeys,
  buildBaseExerciseVideoKey,
  buildBaseExerciseVideoPosterKey,
  isPlatformOwnedExerciseVideoUrl,
} from '../domain/baseExerciseVideos';
import {
  StorageOperationError,
  buildStorageObjectUrl,
  deleteStorageObject,
  describeStorageError,
  ensureStorageFolders,
  getMissingStorageConfigKeys,
  getStorageDiagnostics,
  isStorageConfigured,
  storageKeyFromObjectUrl,
  uploadStorageObject,
} from '../infra/storage';

export const platformExercisesRouter = Router();

const SETTABLE_STATUSES = ['active', 'inactive'];

const SELECT = `
  SELECT e.*,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('key', em.muscle, 'role', em.role))
     FROM exercise_muscles em WHERE em.exercise_id = e.id) AS muscles,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', rt.id, 'name', rt.name, 'slug', rt.slug))
     FROM exercise_allowed_result_types eart
     JOIN result_types rt ON rt.id = eart.result_type_id
     WHERE eart.exercise_id = e.id ORDER BY rt.id) AS allowed_result_types
  FROM exercises e
`;

function parseMuscles(input: unknown): { key: string; role: 'principal' | 'secondary' }[] | string | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return 'muscles must be an array of { key, role }';
  const seen = new Set<string>();
  const parsed: { key: string; role: 'principal' | 'secondary' }[] = [];
  for (const m of input) {
    const key = normalizeMuscleKey(m?.key);
    if (!key) return `invalid muscle key: ${JSON.stringify(m?.key)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({ key, role: m.role === 'secondary' ? 'secondary' : 'principal' });
  }
  return parsed;
}

async function nameTaken(name: string, excludeId?: string | number): Promise<boolean> {
  let sql = "SELECT id FROM exercises WHERE gym_id IS NULL AND name = ? AND status != 'deleted'";
  const params: any[] = [name];
  if (excludeId !== undefined) { sql += ' AND id != ?'; params.push(excludeId); }
  const { rows } = await db.query(sql, params);
  return rows.length > 0;
}

/* ── List ─────────────────────────────────────────────────────────────────── */

platformExercisesRouter.get('/', requireSuperadmin, async (req, res, next) => {
  const status = req.query.status as string | undefined;
  const q = req.query.q as string | undefined;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const params: any[] = [];
  let sql = `${SELECT} WHERE e.gym_id IS NULL AND e.status != 'deleted'`;
  if (status) { sql += ' AND e.status = ?'; params.push(status); }
  if (q) { sql += ' AND e.name LIKE ?'; params.push(`%${q}%`); }
  sql += ' ORDER BY e.name ASC';
  try {
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
});

/* ── Get one ──────────────────────────────────────────────────────────────── */

platformExercisesRouter.get('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `${SELECT} WHERE e.id = ? AND e.gym_id IS NULL AND e.status != 'deleted'`,
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Exercise not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ── Create ───────────────────────────────────────────────────────────────── */

platformExercisesRouter.post('/', requireSuperadmin, async (req, res, next) => {
  const {
    name, description, video_url, image_url,
    min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default, status,
  } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const muscles = parseMuscles(req.body.muscles);
  if (typeof muscles === 'string') return res.status(400).json({ error: muscles });
  const allowedResultTypeIds: number[] | undefined =
    Array.isArray(req.body.allowed_result_type_ids) ? req.body.allowed_result_type_ids.map(Number) : undefined;
  try {
    if (await nameTaken(name.trim())) {
      return res.status(409).json({ error: 'A base exercise with this name already exists.' });
    }
    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO exercises
          (gym_id, name, description, video_url, image_url,
           min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default, status)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name.trim(), description ?? null, video_url ?? null, image_url ?? null,
         min_reps_default ?? null, max_reps_default ?? null, rest_default_seconds ?? null,
         sets_default ?? null, notes_default ?? null, status ?? 'active'],
      );
      if (muscles) {
        for (const m of muscles) {
          await tx.query(
            'INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (NULL, ?, ?, ?)',
            [insertId, m.key, m.role],
          );
        }
      }
      if (allowedResultTypeIds) {
        for (const rtId of allowedResultTypeIds) {
          await tx.query(
            'INSERT IGNORE INTO exercise_allowed_result_types (exercise_id, result_type_id) VALUES (?, ?)',
            [insertId, rtId],
          );
        }
      }
      return insertId;
    });
    const { rows } = await db.query(`${SELECT} WHERE e.id = ?`, [insertId]);
    recordAudit(req, { action: 'create', entityType: 'exercise', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

/* ── Update ───────────────────────────────────────────────────────────────── */

platformExercisesRouter.put('/:id', requireSuperadmin, async (req, res, next) => {
  const id = String(req.params.id);
  const {
    name, description, video_url, image_url,
    min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default, status,
  } = req.body;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const muscles = parseMuscles(req.body.muscles);
  if (typeof muscles === 'string') return res.status(400).json({ error: muscles });
  const allowedResultTypeIds: number[] | undefined =
    Array.isArray(req.body.allowed_result_type_ids) ? req.body.allowed_result_type_ids.map(Number) : undefined;
  try {
    const { rows: existing } = await db.query(
      "SELECT id FROM exercises WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Exercise not found' });
    if (name?.trim() && await nameTaken(name.trim(), id)) {
      return res.status(409).json({ error: 'A base exercise with this name already exists.' });
    }
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE exercises SET
          name                  = COALESCE(?, name),
          description           = IF(?, ?, description),
          video_url             = IF(?, ?, video_url),
          -- #719 part 2: and the video's poster belongs to the video it was
          -- captured from, so repointing video_url drops it too.
          video_thumbnail_url   = IF(?, NULL, video_thumbnail_url),
          image_url             = IF(?, ?, image_url),
          -- #719: same rule as the gym-side PUT — a thumbnail belongs to the
          -- master it was made from, so repointing the master drops it. A Base
          -- Exercise has no thumbnail to drop yet (#716 is what will upload
          -- one), which is exactly why the clause belongs here now rather than
          -- after something starts writing it.
          image_thumbnail_url   = IF(?, NULL, image_thumbnail_url),
          min_reps_default      = IF(?, ?, min_reps_default),
          max_reps_default      = IF(?, ?, max_reps_default),
          rest_default_seconds  = IF(?, ?, rest_default_seconds),
          sets_default          = IF(?, ?, sets_default),
          notes_default         = IF(?, ?, notes_default),
          status                = COALESCE(?, status),
          modified_at           = UTC_TIMESTAMP()
         WHERE id = ? AND gym_id IS NULL AND status != 'deleted'`,
        [
          name?.trim() ?? null,
          'description' in req.body ? 1 : 0, description ?? null,
          'video_url' in req.body ? 1 : 0, video_url ?? null,
          'video_url' in req.body ? 1 : 0,
          'image_url' in req.body ? 1 : 0, image_url ?? null,
          'image_url' in req.body ? 1 : 0,
          'min_reps_default' in req.body ? 1 : 0, min_reps_default ?? null,
          'max_reps_default' in req.body ? 1 : 0, max_reps_default ?? null,
          'rest_default_seconds' in req.body ? 1 : 0, rest_default_seconds ?? null,
          'sets_default' in req.body ? 1 : 0, sets_default ?? null,
          'notes_default' in req.body ? 1 : 0, notes_default ?? null,
          status ?? null,
          id,
        ],
      );
      if (muscles) {
        await tx.query('DELETE FROM exercise_muscles WHERE exercise_id = ? AND gym_id IS NULL', [id]);
        for (const m of muscles) {
          await tx.query(
            'INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (NULL, ?, ?, ?)',
            [id, m.key, m.role],
          );
        }
      }
      if (allowedResultTypeIds) {
        await tx.query('DELETE FROM exercise_allowed_result_types WHERE exercise_id = ?', [id]);
        for (const rtId of allowedResultTypeIds) {
          await tx.query(
            'INSERT IGNORE INTO exercise_allowed_result_types (exercise_id, result_type_id) VALUES (?, ?)',
            [id, rtId],
          );
        }
      }
    });
    const { rows } = await db.query(`${SELECT} WHERE e.id = ?`, [id]);
    recordAudit(req, { action: 'update', entityType: 'exercise', entityId: id, next: rows[0] });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ── Base Exercise image (#716) ───────────────────────────────────────────── */
//
// A Base Exercise's image is a **2048×2048 master plus a 512×512 thumbnail**
// (§2, §3) — the same pair a Gym Exercise carries, validated by the same rules
// (`domain/exerciseImages.ts`) and stored in the same two columns (§7: no
// `image_object_key`; migration 187's `image_url`/`image_thumbnail_url` hold the
// resulting Cloudflare URLs, exactly as a gym-owned row's do).
//
// What differs is *where*: a base exercise is a `gym_id IS NULL` row and belongs
// to no gym, so the objects go in the platform's own folder under keys derived
// from the row — `cordel/Exercises/Images/<id>-<Name>[-thumbnail].png` (§1, §13).
// The route takes neither the folder nor the key from the request: the prefix is
// the `cordel` constant, the exercise is looked up with `gym_id IS NULL` (so a
// gym-owned row is simply 404 here, whoever asks) and the key comes from the
// row's own id and name. Nothing a client sends can reach a gym's folder (§15).
//
// The **browser** produces the thumbnail (the answer on #719 Q2, which this
// ticket inherits: no `sharp`, no `ffmpeg` in the API image) and uploads both
// files in one JSON request, so a failed thumbnail fails the whole upload rather
// than leaving a master without one (§12). The server re-validates each file
// from its own bytes — PNG signature, exact square, alpha channel — never from
// the `Content-Type` header or the file name (§11). Nothing is uploaded and
// nothing is written until both pass, so an invalid upload cannot disturb the
// image already there.
//
// **Generating the artwork is out of scope for this ticket**: the columns stay
// NULL until an administrator uploads a master, which is what §5's backfill was
// replaced by on the issue thread. So there is no generator, no backfill script
// and no runtime fallback — a Base Exercise with no image simply has none.

/** base64 → Buffer, or null when the value is not base64 at all (a PNG, an MP4). */
function decodeBase64File(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  // A data: URL is what a careless client sends; take the payload rather than
  // decoding the prefix into garbage bytes that would fail as "not a PNG".
  const payload = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  const buffer = Buffer.from(payload, 'base64');
  return buffer.length > 0 ? buffer : null;
}

/** The four media references a platform media route reads and writes. */
interface BaseExerciseMediaRow {
  id: number;
  name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
  video_url: string | null;
  video_thumbnail_url: string | null;
}

/**
 * The base exercise this media request is about, or the response that says why
 * there isn't one. A gym-owned row is 404 rather than 403: the platform router
 * answers only for the library (`gym_id IS NULL`), exactly as the gym-scoped
 * `POST /exercises/:id/image` answers 403 for a base row and 404 for another
 * gym's (#719's rule, kept symmetrical).
 */
async function loadBaseExerciseForMedia(
  req: express.Request,
  res: express.Response,
): Promise<BaseExerciseMediaRow | null> {
  const { rows } = await db.query<BaseExerciseMediaRow & { status: string }>(
    `SELECT id, name, status, image_url, image_thumbnail_url, video_url, video_thumbnail_url
       FROM exercises WHERE id = ? AND gym_id IS NULL`,
    [req.params.id],
  );
  const row = rows[0];
  if (!row || row.status === 'deleted') {
    res.status(404).json({ error: 'Exercise not found' });
    return null;
  }
  return row;
}

/**
 * Whether any *other* non-deleted exercise still points at `url` — through any
 * of its **four** media columns, and including a **gym's** exercise, which is
 * the case this check exists for.
 *
 * `POST /exercises/import` copies media *references* rather than objects (#719
 * §2), so every gym that imported a base exercise points at the platform's own
 * object. Deleting it because the library replaced or removed its image would
 * break each of those rows, so a shared object is left in the bucket and only
 * the base row's reference changes. Unlike the gym-side check (`gym_id = ?`),
 * this one deliberately spans every tenant: the platform is the one owner whose
 * objects other rows legitimately reference. All four columns are read because
 * a duplicate, a clone or an import copies media *references*, and an object
 * this exercise stopped pointing at may be another row's image, thumbnail,
 * video or poster (#719's rule, the same one `isMediaStillReferenced()` applies
 * gym-side).
 */
async function isBaseMediaStillReferenced(url: string, exceptExerciseId: number | string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT id FROM exercises
      WHERE id != ? AND status != 'deleted'
        AND (image_url = ? OR image_thumbnail_url = ? OR video_url = ? OR video_thumbnail_url = ?)
      LIMIT 1`,
    [exceptExerciseId, url, url, url, url],
  );
  return rows.length > 0;
}

/**
 * Best-effort removal of objects a base exercise has stopped pointing at (#716
 * §13, #717 §6: replacing media leaves no orphan). Only ever called *after* the
 * row has been updated, so a failure here leaves an orphan to sweep rather than
 * an exercise pointing at a missing object.
 *
 * `isPlatformOwnedExerciseImageUrl()` / `isPlatformOwnedExerciseVideoUrl()` are
 * what keep a gym's object and an external link (a YouTube URL, typically) out
 * of this — the mirror of the rule that stops a gym deleting a `cordel/…`
 * object (#719 §19). Both are asked, because one sweep serves both kinds of
 * media and each owns its own folder.
 */
async function deleteReplacedBaseExerciseMedia(
  exerciseId: number | string,
  staleUrls: (string | null)[],
  keepUrls: (string | null)[],
): Promise<void> {
  const keep = new Set(keepUrls.filter((u): u is string => !!u));
  const seen = new Set<string>();
  for (const url of staleUrls) {
    if (!url || keep.has(url) || seen.has(url)) continue;
    seen.add(url);
    if (!isPlatformOwnedExerciseImageUrl(url) && !isPlatformOwnedExerciseVideoUrl(url)) continue;
    if (await isBaseMediaStillReferenced(url, exerciseId)) continue;
    const key = storageKeyFromObjectUrl(url);
    if (!key) continue;
    try {
      await deleteStorageObject(key);
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'deleteStorageObject', key });
      logger.warn({ err, details, exerciseId }, 'Replaced base exercise media left an orphaned object in Cloudflare R2');
    }
  }
}

/**
 * The body parser for `POST /platform/exercises/:id/image`, and the path it
 * applies to. Mounted in `app.ts` **before** the global `express.json()`, whose
 * 100 kB default a pair of PNGs blows through long before this route is reached
 * — the request would fail as a bare 413 with no chance to say which file was
 * too large. Same ceiling and same reasoning as the gym-side upload's parser.
 */
export const PLATFORM_EXERCISE_IMAGE_UPLOAD_PATH = /^\/platform\/exercises\/[^/]+\/image\/?$/;

export const platformExerciseImageBodyParser = express.json({
  limit: Math.ceil((EXERCISE_IMAGE_MASTER_MAX_BYTES + EXERCISE_IMAGE_THUMBNAIL_MAX_BYTES) * 1.4),
});

platformExercisesRouter.post('/:id/image', requireSuperadmin, async (req, res, next) => {
  try {
    const image = decodeBase64File(req.body?.image);
    const thumbnail = decodeBase64File(req.body?.thumbnail);
    if (!image || !thumbnail) {
      return res.status(400).json({
        error: 'Both `image` (the 2048×2048 master) and `thumbnail` (the 512×512 thumbnail) are required, base64-encoded.',
      });
    }
    const problem = validateExerciseImagePair(image, thumbnail);
    if (problem) {
      return res.status(problem.rejection === 'too_large' ? 413 : 400).json({
        error: problem.message,
        reason: problem.rejection,
        file: problem.kind,
      });
    }

    if (!isStorageConfigured()) {
      const missingConfig = getMissingStorageConfigKeys();
      return res.status(503).json({
        error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
        missingConfig,
      });
    }

    const exercise = await loadBaseExerciseForMedia(req, res);
    if (!exercise) return;

    const imageKey = buildBaseExerciseImageKey(exercise.id, exercise.name);
    const thumbnailKey = buildBaseExerciseImageThumbnailKey(exercise.id, exercise.name);
    const imageUrl = buildStorageObjectUrl(imageKey);
    const thumbnailUrl = buildStorageObjectUrl(thumbnailKey);

    try {
      await ensureStorageFolders(baseExerciseImageFolderKeys());
      await uploadStorageObject(imageKey, EXERCISE_IMAGE_MIME, image);
      await uploadStorageObject(thumbnailKey, EXERCISE_IMAGE_MIME, thumbnail);
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'uploadStorageObject', key: imageKey });
      logger.error(
        { err, details, diagnostics: getStorageDiagnostics(), exerciseId: exercise.id },
        'Cloudflare R2 base exercise image upload failed',
      );
      // The row still points at whatever it pointed at before, so the previous
      // image stays exactly as it was — nothing was written (§11).
      return res.status(502).json({ error: `Failed to upload image: ${details.message}`, details });
    }

    await db.query(
      `UPDATE exercises SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP()
        WHERE id = ? AND gym_id IS NULL`,
      [imageUrl, thumbnailUrl, exercise.id],
    );

    // The keys are deterministic, so a replacement normally overwrites the
    // objects it replaces and there is nothing to orphan. The exception is an
    // exercise renamed since its last upload: the derived keys moved, so the
    // row's old objects are now unreachable.
    await deleteReplacedBaseExerciseMedia(
      exercise.id,
      [exercise.image_url, exercise.image_thumbnail_url],
      // The video pair is kept as well as the new image pair: an exercise whose
      // poster happens to share an object with its old thumbnail must not lose
      // it because the image was replaced (#719's four-reference rule).
      [imageUrl, thumbnailUrl, exercise.video_url, exercise.video_thumbnail_url],
    );

    recordAudit(req, {
      action: 'update',
      entityType: 'exercise',
      entityId: exercise.id,
      previous: { image_url: exercise.image_url, image_thumbnail_url: exercise.image_thumbnail_url },
      next: { image_url: imageUrl, image_thumbnail_url: thumbnailUrl },
    });
    const { rows } = await db.query(`${SELECT} WHERE e.id = ? AND e.gym_id IS NULL`, [exercise.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/**
 * Clears a Base Exercise's image. Both references go, the platform's own objects
 * are deleted when nothing else references them, and a gym's object a `PUT` had
 * somehow left on the row is never touched. There is deliberately no fallback
 * afterwards — the exercise simply has no image, and uploading one is how it
 * gets another (the no-runtime-fallback rule, #719 §12).
 */
platformExercisesRouter.delete('/:id/image', requireSuperadmin, async (req, res, next) => {
  try {
    const exercise = await loadBaseExerciseForMedia(req, res);
    if (!exercise) return;

    await db.query(
      `UPDATE exercises SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP()
        WHERE id = ? AND gym_id IS NULL`,
      [exercise.id],
    );

    await deleteReplacedBaseExerciseMedia(
      exercise.id,
      [exercise.image_url, exercise.image_thumbnail_url],
      [exercise.video_url, exercise.video_thumbnail_url],
    );

    recordAudit(req, {
      action: 'update',
      entityType: 'exercise',
      entityId: exercise.id,
      previous: { image_url: exercise.image_url, image_thumbnail_url: exercise.image_thumbnail_url },
      next: { image_url: null, image_thumbnail_url: null },
    });
    const { rows } = await db.query(`${SELECT} WHERE e.id = ? AND e.gym_id IS NULL`, [exercise.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ── Base Exercise video (#717) ───────────────────────────────────────────── */
//
// A Base Exercise's video is an **MP4 plus a 512×512 poster** (§3, and the
// answer to this ticket's Q4), stored in the platform's own folder under keys
// derived from the row: `cordel/Exercises/Videos/<id>-<Name>.mp4` and
// `…-thumbnail.png` (§1). It is the image pair of #716 one folder over, and
// every rule established there holds unchanged — the route takes neither the
// folder nor the key from the request, the exercise is looked up with
// `gym_id IS NULL` (so a gym-owned row is simply 404 here, whoever asks), and
// nothing a client sends can reach a gym's folder.
//
// The columns are the ones migration 188 already added: `video_url` holds the
// uploaded object's URL and `video_thumbnail_url` its poster (this ticket's Q5 —
// **no** `video_object_key` column). A base row whose `video_url` is an external
// link today keeps working: an upload replaces the link with the object's URL,
// and a `PUT` that repoints `video_url` back at a YouTube link clears the
// poster, because the poster belonged to the MP4 it was captured from.
//
// The **browser** captures that poster (#719 Q2, inherited here: no `sharp`, no
// `ffmpeg` in the API image) and uploads both files in one JSON body, so a
// failed poster fails the whole upload rather than leaving a video the UI would
// have to download to draw a row (§5, §9). The server validates each file from
// its own bytes — the MP4's `ftyp` brand, its `moov` and its video sample
// entries (`domain/mp4Video.ts`, this ticket's Q3), the poster's PNG signature
// and exact size — and never from the `Content-Type` header or the file name
// (§3). Nothing is uploaded and nothing is written until both pass, so an
// invalid upload cannot disturb the video already there (§6). The old objects
// are deleted only *after* the row points at the new ones, and only when they
// are the platform's own and no other exercise — in any gym — still references
// them (§6's "no orphaned video objects").

/** The path `platformExerciseVideoBodyParser` applies to, mounted in `app.ts`. */
export const PLATFORM_EXERCISE_VIDEO_UPLOAD_PATH = /^\/platform\/exercises\/[^/]+\/video\/?$/;

/**
 * The body parser for `POST /platform/exercises/:id/video`.
 *
 * Mounted **before** the global `express.json()`, whose 100 kB default an MP4
 * blows through long before the route is reached — the request would fail as a
 * bare 413 with no chance to say which file was too large. Same ceiling and same
 * reasoning as the gym-side upload's parser: the two file limits plus base64's
 * ~4/3 overhead, read once at start-up (`EXERCISE_VIDEO_MAX_MB` — this ticket's
 * Q2 — needs a restart to change the request ceiling; the per-file check
 * re-reads it).
 */
export const platformExerciseVideoBodyParser = express.json({
  limit: Math.ceil((exerciseVideoMaxBytes() + EXERCISE_VIDEO_POSTER_MAX_BYTES) * 1.4),
});

platformExercisesRouter.post('/:id/video', requireSuperadmin, async (req, res, next) => {
  try {
    const video = decodeBase64File(req.body?.video);
    const poster = decodeBase64File(req.body?.poster);
    if (!video || !poster) {
      return res.status(400).json({
        error: 'Both `video` (the MP4) and `poster` (its 512×512 thumbnail) are required, base64-encoded.',
      });
    }
    const problem = validateExerciseVideoPair(video, poster);
    if (problem) {
      return res.status(problem.rejection === 'too_large' ? 413 : 400).json({
        error: problem.message,
        reason: problem.rejection,
        file: problem.kind,
      });
    }

    if (!isStorageConfigured()) {
      const missingConfig = getMissingStorageConfigKeys();
      return res.status(503).json({
        error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
        missingConfig,
      });
    }

    const exercise = await loadBaseExerciseForMedia(req, res);
    if (!exercise) return;

    const videoKey = buildBaseExerciseVideoKey(exercise.id, exercise.name);
    const posterKey = buildBaseExerciseVideoPosterKey(exercise.id, exercise.name);
    const videoUrl = buildStorageObjectUrl(videoKey);
    const posterUrl = buildStorageObjectUrl(posterKey);

    try {
      await ensureStorageFolders(baseExerciseVideoFolderKeys());
      await uploadStorageObject(videoKey, EXERCISE_VIDEO_MIME, video);
      await uploadStorageObject(posterKey, EXERCISE_VIDEO_POSTER_MIME, poster);
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'uploadStorageObject', key: videoKey });
      logger.error(
        { err, details, diagnostics: getStorageDiagnostics(), exerciseId: exercise.id },
        'Cloudflare R2 base exercise video upload failed',
      );
      // The row still points at whatever it pointed at before, so the previous
      // video and poster stay exactly as they were — nothing was written (§6).
      return res.status(502).json({ error: `Failed to upload video: ${details.message}`, details });
    }

    await db.query(
      `UPDATE exercises SET video_url = ?, video_thumbnail_url = ?, modified_at = UTC_TIMESTAMP()
        WHERE id = ? AND gym_id IS NULL`,
      [videoUrl, posterUrl, exercise.id],
    );

    // The keys are deterministic, so a replacement normally overwrites the
    // objects it replaces and there is nothing to orphan. The exceptions are an
    // exercise renamed since its last upload (the derived keys moved) and a row
    // that carried an external link, which is never ours to delete anyway.
    await deleteReplacedBaseExerciseMedia(
      exercise.id,
      [exercise.video_url, exercise.video_thumbnail_url],
      [videoUrl, posterUrl, exercise.image_url, exercise.image_thumbnail_url],
    );

    recordAudit(req, {
      action: 'update',
      entityType: 'exercise',
      entityId: exercise.id,
      previous: { video_url: exercise.video_url, video_thumbnail_url: exercise.video_thumbnail_url },
      next: { video_url: videoUrl, video_thumbnail_url: posterUrl },
    });
    const { rows } = await db.query(`${SELECT} WHERE e.id = ? AND e.gym_id IS NULL`, [exercise.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/**
 * Clears a Base Exercise's video (§7). Both references go, the platform's own
 * objects are deleted when nothing else references them, and a gym's object a
 * `PUT` had somehow left on the row is never touched. There is deliberately no
 * fallback afterwards — the exercise simply has no video, and uploading one is
 * how it gets another (the no-runtime-fallback rule, #719 §12).
 */
platformExercisesRouter.delete('/:id/video', requireSuperadmin, async (req, res, next) => {
  try {
    const exercise = await loadBaseExerciseForMedia(req, res);
    if (!exercise) return;

    await db.query(
      `UPDATE exercises SET video_url = NULL, video_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP()
        WHERE id = ? AND gym_id IS NULL`,
      [exercise.id],
    );

    await deleteReplacedBaseExerciseMedia(
      exercise.id,
      [exercise.video_url, exercise.video_thumbnail_url],
      [exercise.image_url, exercise.image_thumbnail_url],
    );

    recordAudit(req, {
      action: 'update',
      entityType: 'exercise',
      entityId: exercise.id,
      previous: { video_url: exercise.video_url, video_thumbnail_url: exercise.video_thumbnail_url },
      next: { video_url: null, video_thumbnail_url: null },
    });
    const { rows } = await db.query(`${SELECT} WHERE e.id = ? AND e.gym_id IS NULL`, [exercise.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ── Soft delete ──────────────────────────────────────────────────────────── */

platformExercisesRouter.delete('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      "UPDATE exercises SET status = 'deleted', deleted_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
      [req.params.id],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Exercise not found' });
    recordAudit(req, { action: 'delete', entityType: 'exercise', entityId: req.params.id });
    res.status(204).send();
  } catch (err) { next(err); }
});
