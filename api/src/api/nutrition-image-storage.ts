// The one place a Nutrition Library food's image is read, converted and written
// to Cloudflare R2 (#1562), shared by the gym route and the platform (Base) one.
//
// A food's image is a server-made pair of WebP files — the 1080 × 1080 master at
// `<root>/nutrition/<food_id>-<name>.webp` and its 256 × 256 thumbnail beside it
// — made from the one picture the client sends, by the same function Base
// Exercises use (`processExerciseImage()`: contained, never stretched or
// cropped). Only the master's URL is stored in `nutrition_library_items.image_url`;
// the thumbnail's is derived from it.
//
// Both routers keep what is their own (who may write, which rows, the answer's
// shape, the audit row); the request judgement, the upload-then-write order and
// the sweep live here so the two cannot disagree.

import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { apiRateLimitKey } from '../domain/apiRateLimit';
import {
  EXERCISE_IMAGE_REJECTION_MESSAGES,
  EXERCISE_GENDER_IMAGE_MIME,
  EXERCISE_MEDIA_UPLOAD_RATE_LIMIT_WINDOW_MS,
  exerciseImageMaxBytes,
  exerciseMediaUploadRateLimitMax,
} from '../domain/exerciseGenderMedia';
import { type ProcessedExerciseImage, processExerciseImage } from '../domain/exerciseImageProcessing';
import { nutritionThumbnailKeyFor } from '../domain/baseNutritionImages';
import {
  deleteStorageObject,
  describeStorageError,
  ensureStorageFolders,
  getMissingStorageConfigKeys,
  getStorageDiagnostics,
  isStorageConfigured,
  StorageOperationError,
  storageKeyFromObjectUrl,
  uploadStorageObject,
} from '../infra/storage';
import { logger } from '../lib/logger';

export interface NutritionImageRefusal {
  status: number;
  body: Record<string, unknown>;
}

export function isNutritionImageRefusal(value: unknown): value is NutritionImageRefusal {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
}

/** Raw bytes, ceiling `EXERCISE_IMAGE_MAX_MB` — the same picture budget as an exercise's. */
export const nutritionImageBodyParser = express.raw({
  type: (req) => (req.headers['content-type'] ?? '').startsWith('image/'),
  limit: exerciseImageMaxBytes() + 64 * 1024,
});

const uploadLimiter = rateLimit({
  windowMs: EXERCISE_MEDIA_UPLOAD_RATE_LIMIT_WINDOW_MS,
  limit: exerciseMediaUploadRateLimitMax(),
  keyGenerator: (req) => apiRateLimitKey(req.headers.authorization, ipKeyGenerator(req.ip ?? '')),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many image uploads. Please try again later.' }),
});

/** In front of the body parser, so a flooded request is refused before a byte is buffered. */
export const nutritionImageUploadRateLimit = uploadLimiter as unknown as express.RequestHandler;

/**
 * The two WebP files a request's picture becomes, or the refusal saying why
 * there are none. Nothing is uploaded on a refusal, so the food's current image
 * stays exactly as it was. The input is judged from its decoded bytes, never the
 * `Content-Type` header or the file name.
 */
export async function parseNutritionImageRequest(
  req: express.Request,
): Promise<ProcessedExerciseImage | NutritionImageRefusal> {
  const mime = req.headers['content-type']?.split(';')[0]?.trim() ?? '';
  if (!mime.startsWith('image/')) {
    return { status: 415, body: { error: 'Unsupported content type. Send the picture as an image/* body' } };
  }
  // `req.body` is whatever a parser left there; a string or an array would flow
  // into the size and decode checks as if it were bytes.
  const raw: unknown = req.body;
  if (typeof raw === 'string' || Array.isArray(raw) || !Buffer.isBuffer(raw)) {
    return { status: 400, body: { error: 'Request body must be raw image bytes' } };
  }
  const body: Buffer = raw;
  if (body.length === 0) return { status: 400, body: { error: 'Request body is empty' } };
  const maxBytes = exerciseImageMaxBytes();
  if (body.length > maxBytes) {
    return { status: 413, body: { error: `Image exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB limit` } };
  }
  if (!isStorageConfigured()) {
    const missingConfig = getMissingStorageConfigKeys();
    return {
      status: 503,
      body: {
        error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
        missingConfig,
      },
    };
  }
  const processed = await processExerciseImage(body);
  if ('rejection' in processed) {
    return {
      status: 400,
      body: { error: EXERCISE_IMAGE_REJECTION_MESSAGES[processed.rejection], reason: processed.rejection },
    };
  }
  return processed;
}

/**
 * Uploads the master and its thumbnail. The route writes the row only after
 * this returns, so a failure of either file is never a successful replacement.
 * On failure the files this call newly created are removed — but a master
 * written over the key the row already points at is left alone, since it *is*
 * the food's current image and deleting it would destroy what a failed
 * replacement must preserve. Returns a refusal to send, or null on success.
 */
export async function storeNutritionImagePair(opts: {
  key: string;
  processed: ProcessedExerciseImage;
  folderKeys: string[];
  currentUrl: string | null;
  logContext: Record<string, unknown>;
}): Promise<NutritionImageRefusal | null> {
  const { key, processed, folderKeys, currentUrl, logContext } = opts;
  const thumbKey = nutritionThumbnailKeyFor(key);
  const currentKey = currentUrl ? storageKeyFromObjectUrl(currentUrl) : null;
  const written: string[] = [];
  let step = key;
  try {
    await ensureStorageFolders(folderKeys);
    await uploadStorageObject(key, EXERCISE_GENDER_IMAGE_MIME, processed.image);
    if (key !== currentKey) written.push(key);
    step = thumbKey;
    await uploadStorageObject(thumbKey, EXERCISE_GENDER_IMAGE_MIME, processed.thumbnail);
    return null;
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key: step });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), ...logContext },
      'Cloudflare R2 nutrition image upload failed',
    );
    for (const orphan of written) {
      await deleteStorageObject(orphan).catch(() => undefined);
    }
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }
}

/**
 * Best-effort removal of the objects a replacement stopped pointing at, after
 * the row moved: the old master and its thumbnail when the key changed (a
 * rename, or an image from before #1562 under a `.png`/other-extension key).
 * `owns` is the ownership test — only an object the gym (or the platform) owns
 * is ever deleted (#719 §19).
 */
export async function sweepReplacedNutritionImage(
  staleUrl: string | null,
  newKey: string,
  owns: (key: string) => boolean,
  logContext: Record<string, unknown>,
): Promise<void> {
  const staleKey = staleUrl ? storageKeyFromObjectUrl(staleUrl) : null;
  if (!staleKey || staleKey === newKey || !owns(staleKey)) return;
  const candidates = [staleKey];
  if (staleKey.endsWith('.webp')) candidates.push(nutritionThumbnailKeyFor(staleKey));
  for (const k of candidates) {
    try {
      await deleteStorageObject(k);
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'deleteStorageObject', key: k });
      logger.warn({ err, details, ...logContext }, 'Replaced nutrition image left an orphaned object in Cloudflare R2');
    }
  }
}
