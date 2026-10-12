// Gender-specific exercise media routes (#1420).
//
// One factory serves both exercise routers, because a Gym Exercise and a Base
// Exercise differ only in who may write, which folder the objects go in and whose
// objects a sweep may delete:
//
//   POST   /:id/image/:gender    {image}          any JPEG/PNG/WebP/GIF
//   DELETE /:id/image/:gender
//   POST   /:id/video/:gender    {video, frame}   an MP4 and one frame captured from it
//   DELETE /:id/video/:gender
//
// The **server** makes every WebP file (`domain/exerciseImageProcessing.ts`):
// the client sends the picture it picked as it is, base64 in one JSON body, and
// the server judges it from its decoded bytes — never from the Content-Type
// header or a file name — contains it in 1080x1080 with transparent padding and
// derives the 256x256 thumbnail from that master. `sharp` cannot decode MP4, so a
// video upload carries a `frame` the browser captured; it is processed like an
// image upload and stored as the video's preview under `videos/`. Nothing is
// uploaded and nothing is written until every file is valid, so an invalid upload
// cannot disturb the media already there. Only the master reference is stored;
// the companions are derived from it (`domain/exerciseGenderMedia.ts`). A video's
// preview objects live beside the video and never touch the image columns.
//
// The key comes from the row's id and name and the gender in the URL, never from
// anything else the request carries, so nothing a client sends can reach another
// gym's folder or the platform's.

import express, { Request, RequestHandler, Response, Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { db } from '../infra/db';
import { recordAudit } from '../infra/audit';
import { getTenantContext } from '../infra/tenantContext';
import { apiRateLimitKey } from '../domain/apiRateLimit';
import { resolvePlatformActor, resolveRequestActor } from '../domain/auditActor';
import { mediaIdentity, mediaReferenceClause } from '../domain/exerciseMediaReferences';
import {
  EXERCISE_GENDER_IMAGE_MIME,
  EXERCISE_GENDER_MEDIA_COLUMNS,
  EXERCISE_IMAGE_REJECTION_MESSAGES,
  EXERCISE_MEDIA_UPLOAD_RATE_LIMIT_WINDOW_MS,
  EXERCISE_GENDER_VIDEO_MIME,
  ExerciseGender,
  baseExerciseGenderFolderKeys,
  buildBaseExerciseGenderImageKey,
  buildBaseExerciseGenderVideoKey,
  buildGymExerciseGenderImageKey,
  buildGymExerciseGenderVideoKey,
  gymExerciseGenderFolderKeys,
  imageObjectUrls,
  isGymOwnedGenderMediaUrl,
  isPlatformOwnedGenderMediaUrl,
  parseExerciseGender,
  exerciseMediaUploadRateLimitMax,
  genderMediaRequestMaxBytes,
  thumbnailKeyFor,
  validateGenderImageInput,
  validateGenderVideo,
  videoObjectUrls,
  videoPreviewKeyFor,
} from '../domain/exerciseGenderMedia';
import { processExerciseImage } from '../domain/exerciseImageProcessing';
import { logger } from '../lib/logger';
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

export type ExerciseGenderMediaScope = 'gym' | 'platform';

/** Both scopes' upload paths: `/exercises/:id/(image|video)/:gender` and the `/platform` mirror. */
export const EXERCISE_GENDER_MEDIA_UPLOAD_PATH = /^\/(?:platform\/)?exercises\/[^/]+\/(?:image|video)\/[^/]+\/?$/;

/**
 * Mounted in `app.ts` before the global `express.json()` (whose 100 kB default an
 * MP4 or a camera original blows through). The ceiling is the largest request
 * either kind carries — the video plus one picture — with base64's ~4/3 overhead;
 * the per-file checks give each file its own message.
 */
export const exerciseGenderMediaBodyParser = express.json({ limit: genderMediaRequestMaxBytes() });

/**
 * A budget of its own for the upload routes, in front of the body parser so a
 * flooded request is refused before a byte is buffered. Keyed on the signed-in
 * person exactly like the global limiter (`apiRateLimitKey()`, #1395) — never the
 * address, which behind the two Next proxies would be everybody.
 */
export const exerciseGenderMediaUploadRateLimit = rateLimit({
  windowMs: EXERCISE_MEDIA_UPLOAD_RATE_LIMIT_WINDOW_MS,
  limit: exerciseMediaUploadRateLimitMax(),
  keyGenerator: (req) => apiRateLimitKey(req.headers.authorization, ipKeyGenerator(req.ip ?? '')),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many media uploads. Please try again later.' }),
}) as unknown as RequestHandler;

function decodeBase64File(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const payload = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  const buffer = Buffer.from(payload, 'base64');
  return buffer.length > 0 ? buffer : null;
}

interface MediaRow {
  id: number;
  name: string;
  image_male_url: string | null;
  image_female_url: string | null;
  video_male_url: string | null;
  video_female_url: string | null;
}

interface MediaContext {
  gymId: string | null;
  folderPrefix: string | null;
  exercise: MediaRow;
}

export interface ExerciseGenderMediaOptions {
  scope: ExerciseGenderMediaScope;
  /** `requireModuleWrite('TRAINING')` for a gym, `requireSuperadmin` for the platform. */
  guard: RequestHandler;
  /** Answers with the exercise as the owning router shapes it. */
  respond: (req: Request, res: Response, exerciseId: number | string, gymId: string | null) => Promise<void>;
}

export function createExerciseGenderMediaRouter(options: ExerciseGenderMediaOptions): Router {
  const { scope, guard, respond } = options;
  const router = Router();

  const actorOf = (req: Request) =>
    scope === 'platform'
      ? resolvePlatformActor((req as any).superadminName)
      : resolveRequestActor(getTenantContext(req));

  async function load(req: Request, res: Response, requireStoragePrefix: boolean, label: 'images' | 'videos'): Promise<MediaContext | null> {
    const columns = 'id, gym_id, name, status, image_male_url, image_female_url, video_male_url, video_female_url';
    if (scope === 'platform') {
      const { rows } = await db.query<MediaRow & { status: string }>(
        `SELECT ${columns} FROM exercises WHERE id = ? AND gym_id IS NULL`,
        [req.params.id],
      );
      const row = rows[0];
      if (!row || row.status === 'deleted') {
        res.status(404).json({ error: 'Exercise not found' });
        return null;
      }
      return { gymId: null, folderPrefix: null, exercise: row };
    }
    const { gymId } = getTenantContext(req);
    const { rows } = await db.query<MediaRow & { gym_id: string | null; status: string }>(
      `SELECT ${columns} FROM exercises WHERE id = ?`,
      [req.params.id],
    );
    const row = rows[0];
    if (row && row.gym_id === null) {
      res.status(403).json({ error: 'Base exercises can only be modified by Cordel administrators.' });
      return null;
    }
    if (!row || row.gym_id !== gymId || row.status === 'deleted') {
      res.status(404).json({ error: 'Exercise not found' });
      return null;
    }
    const { rows: gymRows } = await db.query<{ storage_folder_prefix: string | null }>(
      'SELECT storage_folder_prefix FROM gyms WHERE id = ? AND deleted_at IS NULL',
      [gymId],
    );
    const folderPrefix = gymRows[0]?.storage_folder_prefix ?? null;
    if (!folderPrefix && requireStoragePrefix) {
      res.status(409).json({
        error: `Cloudflare storage has not been initialized for this gym, therefore ${label} cannot be uploaded.`,
      });
      return null;
    }
    return { gymId, folderPrefix, exercise: row };
  }

  const owns = (url: string, ctx: MediaContext) =>
    scope === 'platform' ? isPlatformOwnedGenderMediaUrl(url) : isGymOwnedGenderMediaUrl(url, ctx.folderPrefix);

  async function stillReferenced(url: string, ctx: MediaContext): Promise<boolean> {
    const { clause, params } = mediaReferenceClause(url);
    const gymClause = scope === 'platform' ? '' : 'AND gym_id = ?';
    const { rows } = await db.query(
      `SELECT id FROM exercises
        WHERE id != ? AND status != 'deleted' ${gymClause}
          AND ${clause}
        LIMIT 1`,
      scope === 'platform' ? [ctx.exercise.id, ...params] : [ctx.exercise.id, ctx.gymId, ...params],
    );
    return rows.length > 0;
  }

  async function deleteObject(url: string, ctx: MediaContext): Promise<void> {
    const key = storageKeyFromObjectUrl(url);
    if (!key) return;
    try {
      await deleteStorageObject(key);
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'deleteStorageObject', key });
      logger.warn({ err, details, exerciseId: ctx.exercise.id }, 'Replaced exercise gender media left an orphaned object in Cloudflare R2');
    }
  }

  /**
   * Best-effort removal of the objects behind a master the row stopped pointing
   * at. Only called after the row was updated. A master the row still holds under
   * another column, one it does not own (a System object, an external link) and
   * one another exercise still references are all left alone.
   */
  async function sweep(staleMaster: string | null, kind: 'image' | 'video', keepMasters: (string | null)[], ctx: MediaContext) {
    if (!staleMaster) return;
    const keep = new Set(keepMasters.filter((u): u is string => !!u).map(mediaIdentity));
    if (keep.has(mediaIdentity(staleMaster))) return;
    if (!owns(staleMaster, ctx)) return;
    if (await stillReferenced(staleMaster, ctx)) return;
    for (const url of kind === 'image' ? imageObjectUrls(staleMaster) : videoObjectUrls(staleMaster)) {
      await deleteObject(url, ctx);
    }
  }

  /** The row's other three masters: what a sweep must not delete because it still holds them. */
  const othersOf = (row: MediaRow, col: string): (string | null)[] =>
    (['image_male_url', 'image_female_url', 'video_male_url', 'video_female_url'] as const)
      .filter((c) => c !== col)
      .map((c) => row[c]);

  /** Uploads every entry; on a failure removes the ones this call wrote that the row did not already hold. */
  async function uploadAll(
    entries: { key: string; mime: string; body: Buffer }[],
    folderKeys: string[],
    ctx: MediaContext,
    heldUrls: (string | null)[],
  ): Promise<{ status: number; body: object } | null> {
    const held = new Set(heldUrls.filter((u): u is string => !!u).map(mediaIdentity));
    const written: string[] = [];
    try {
      await ensureStorageFolders(folderKeys);
      for (const entry of entries) {
        await uploadStorageObject(entry.key, entry.mime, entry.body);
        written.push(entry.key);
      }
      return null;
    } catch (err: any) {
      const failedKey = entries[written.length]?.key ?? entries[0].key;
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'uploadStorageObject', key: failedKey });
      logger.error(
        { err, details, diagnostics: getStorageDiagnostics(), exerciseId: ctx.exercise.id },
        'Cloudflare R2 exercise gender media upload failed',
      );
      // An object the row already pointed at was overwritten in place and is the
      // best copy there is; one this call created is an orphan to remove.
      for (const key of written) {
        const url = buildStorageObjectUrl(key);
        if (url && !held.has(mediaIdentity(url))) await deleteObject(url, ctx);
      }
      return { status: 502, body: { error: `Failed to upload media: ${details.message}`, details } };
    }
  }

  function storageUnconfigured(res: Response): boolean {
    if (isStorageConfigured()) return false;
    const missingConfig = getMissingStorageConfigKeys();
    res.status(503).json({
      error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
      missingConfig,
    });
    return true;
  }

  function badGender(req: Request, res: Response): ExerciseGender | null {
    const gender = parseExerciseGender(req.params.gender);
    if (!gender) res.status(400).json({ error: 'gender must be "male" or "female"' });
    return gender;
  }

  function rejected(res: Response, problem: { message: string; rejection: string; file: string }) {
    res.status(problem.rejection === 'too_large' ? 413 : 400).json({
      error: problem.message,
      reason: problem.rejection,
      file: problem.file,
    });
  }

  const column = (gender: ExerciseGender, kind: 'image' | 'video') => EXERCISE_GENDER_MEDIA_COLUMNS[gender][kind];

  async function writeColumn(ctx: MediaContext, col: string, value: string | null, req: Request) {
    const where = scope === 'platform' ? 'id = ? AND gym_id IS NULL' : 'id = ? AND gym_id = ?';
    const params = scope === 'platform' ? [value, actorOf(req), ctx.exercise.id] : [value, actorOf(req), ctx.exercise.id, ctx.gymId];
    await db.query(
      `UPDATE exercises SET ${col} = ?, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE ${where}`,
      params,
    );
  }

  /** Both WebP files for a request's picture, or the response that says why not. */
  async function processPicture(res: Response, body: unknown, file: 'image' | 'frame') {
    const problem = validateGenderImageInput(body, file);
    if (problem) return rejected(res, problem);
    const processed = await processExerciseImage(body as Buffer);
    if ('rejection' in processed) {
      res.status(400).json({
        error: EXERCISE_IMAGE_REJECTION_MESSAGES[processed.rejection],
        reason: processed.rejection,
        file,
      });
      return null;
    }
    return processed;
  }

  router.post('/:id/image/:gender', guard, async (req, res, next) => {
    try {
      const gender = badGender(req, res);
      if (!gender) return;
      const original = decodeBase64File(req.body?.image);
      if (!original) {
        return res.status(400).json({ error: '`image` (the picture, base64-encoded) is required.' });
      }
      if (storageUnconfigured(res)) return;

      // The row, the gym and the storage prefix are judged before any CPU is spent
      // decoding a picture nobody may store.
      const ctx = await load(req, res, true, 'images');
      if (!ctx) return;
      const processed = await processPicture(res, original, 'image');
      if (!processed) return;
      const { exercise } = ctx;
      const col = column(gender, 'image');
      const previous = (exercise as any)[col] as string | null;

      const imageKey = scope === 'platform'
        ? buildBaseExerciseGenderImageKey(exercise.id, exercise.name, gender)
        : buildGymExerciseGenderImageKey(ctx.folderPrefix as string, exercise.id, exercise.name, gender);
      const imageUrl = buildStorageObjectUrl(imageKey);

      const failure = await uploadAll(
        [
          { key: imageKey, mime: EXERCISE_GENDER_IMAGE_MIME, body: processed.image },
          { key: thumbnailKeyFor(imageKey), mime: EXERCISE_GENDER_IMAGE_MIME, body: processed.thumbnail },
        ],
        scope === 'platform' ? baseExerciseGenderFolderKeys('image') : gymExerciseGenderFolderKeys(ctx.folderPrefix as string, 'image'),
        ctx,
        imageObjectUrls(previous),
      );
      if (failure) return res.status(failure.status).json(failure.body);

      await writeColumn(ctx, col, imageUrl, req);
      // The key is deterministic, so a replacement normally overwrites its own
      // objects; the sweep matters only for an exercise renamed since its last upload.
      await sweep(previous, 'image', [imageUrl, ...othersOf(exercise, col)], ctx);

      recordAudit(req, {
        action: 'update',
        entityType: 'exercise',
        entityId: exercise.id,
        previous: { [col]: previous },
        next: { [col]: imageUrl },
      });
      await respond(req, res, exercise.id, ctx.gymId);
    } catch (err) { next(err); }
  });

  router.delete('/:id/image/:gender', guard, async (req, res, next) => {
    try {
      const gender = badGender(req, res);
      if (!gender) return;
      const ctx = await load(req, res, false, 'images');
      if (!ctx) return;
      const col = column(gender, 'image');
      const previous = (ctx.exercise as any)[col] as string | null;

      await writeColumn(ctx, col, null, req);
      await sweep(previous, 'image', othersOf(ctx.exercise, col), ctx);

      recordAudit(req, {
        action: 'update',
        entityType: 'exercise',
        entityId: ctx.exercise.id,
        previous: { [col]: previous },
        next: { [col]: null },
      });
      await respond(req, res, ctx.exercise.id, ctx.gymId);
    } catch (err) { next(err); }
  });

  router.post('/:id/video/:gender', guard, async (req, res, next) => {
    try {
      const gender = badGender(req, res);
      if (!gender) return;
      const video = decodeBase64File(req.body?.video);
      const frame = decodeBase64File(req.body?.frame);
      if (!video || !frame) {
        return res.status(400).json({
          error: '`video` (the MP4) and `frame` (a picture captured from it) are required, base64-encoded.',
        });
      }
      const videoProblem = validateGenderVideo(video);
      if (videoProblem) return rejected(res, videoProblem);
      if (storageUnconfigured(res)) return;

      const ctx = await load(req, res, true, 'videos');
      if (!ctx) return;
      const processed = await processPicture(res, frame, 'frame');
      if (!processed) return;
      const { exercise } = ctx;
      const col = column(gender, 'video');
      const previous = (exercise as any)[col] as string | null;

      const videoKey = scope === 'platform'
        ? buildBaseExerciseGenderVideoKey(exercise.id, exercise.name, gender)
        : buildGymExerciseGenderVideoKey(ctx.folderPrefix as string, exercise.id, exercise.name, gender);
      const previewKey = videoPreviewKeyFor(videoKey);
      const videoUrl = buildStorageObjectUrl(videoKey);

      const failure = await uploadAll(
        [
          { key: videoKey, mime: EXERCISE_GENDER_VIDEO_MIME, body: video },
          { key: previewKey, mime: EXERCISE_GENDER_IMAGE_MIME, body: processed.image },
          { key: thumbnailKeyFor(previewKey), mime: EXERCISE_GENDER_IMAGE_MIME, body: processed.thumbnail },
        ],
        scope === 'platform' ? baseExerciseGenderFolderKeys('video') : gymExerciseGenderFolderKeys(ctx.folderPrefix as string, 'video'),
        ctx,
        videoObjectUrls(previous),
      );
      if (failure) return res.status(failure.status).json(failure.body);

      await writeColumn(ctx, col, videoUrl, req);
      await sweep(previous, 'video', [videoUrl, ...othersOf(exercise, col)], ctx);

      recordAudit(req, {
        action: 'update',
        entityType: 'exercise',
        entityId: exercise.id,
        previous: { [col]: previous },
        next: { [col]: videoUrl },
      });
      await respond(req, res, exercise.id, ctx.gymId);
    } catch (err) { next(err); }
  });

  router.delete('/:id/video/:gender', guard, async (req, res, next) => {
    try {
      const gender = badGender(req, res);
      if (!gender) return;
      const ctx = await load(req, res, false, 'videos');
      if (!ctx) return;
      const col = column(gender, 'video');
      const previous = (ctx.exercise as any)[col] as string | null;

      await writeColumn(ctx, col, null, req);
      await sweep(previous, 'video', othersOf(ctx.exercise, col), ctx);

      recordAudit(req, {
        action: 'update',
        entityType: 'exercise',
        entityId: ctx.exercise.id,
        previous: { [col]: previous },
        next: { [col]: null },
      });
      await respond(req, res, ctx.exercise.id, ctx.gymId);
    } catch (err) { next(err); }
  });

  return router;
}
