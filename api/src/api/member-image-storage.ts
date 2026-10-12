// The one place a Member's profile image is written to and cleared from
// Cloudflare R2 (#1374, shared with the Member's own routes since #1375).
//
// Two routers write the same column with the same key — the staff pair
// `POST`/`DELETE /members/:id/image` and the member's own
// `POST`/`DELETE /me/profile/image` — and #1375 §3 asks that they cannot
// disagree about what a valid photo is or where it goes. So the request
// judgement, the upload-then-write order, the clear and the sweep live here,
// and each router keeps only what is its own: who the Member is (a `:id`
// inside the tenant, or the caller resolved through `resolveMemberId()`), the
// guard in front, the shape it answers and the audit row.
//
// `domain/memberImages.ts` is still the one place the keys are built and the
// rules live, `domain/memberImageProcessing.ts` the one place the two WebP files
// are made (#1449); this module is the I/O around them.

import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { db } from '../infra/db';
import {
  MEMBER_IMAGE_REJECTION_MESSAGES,
  MEMBER_IMAGE_STORED_MIME,
  MEMBER_IMAGE_UPLOAD_RATE_LIMIT_WINDOW_MS,
  buildMemberImageKey,
  buildMemberImageThumbnailKey,
  isGymOwnedMemberImageUrl,
  memberImageFolderKeys,
  memberImageMaxBytes,
  memberImageUploadRateLimitMax,
} from '../domain/memberImages';
import { apiRateLimitKey } from '../domain/apiRateLimit';
import { type ProcessedMemberImage, processMemberImage } from '../domain/memberImageProcessing';
import {
  buildStorageObjectUrl,
  copyStorageObject,
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

/** The columns the image routes need of a member. */
export interface MemberImageRow {
  id: number;
  name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

/** The columns the routes select to build a {@link MemberImageRow}. */
export const MEMBER_IMAGE_COLUMNS = 'id, name, image_url, image_thumbnail_url';

/** An answer the route sends as-is: a status and a JSON body. */
export interface MemberImageRefusal {
  status: number;
  body: Record<string, unknown>;
}

export function isMemberImageRefusal(value: unknown): value is MemberImageRefusal {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
}

/**
 * Raw bytes rather than JSON-with-base64: the client sends the **one** picture
 * it picked, as it is (#1449), and the server makes both files from it.
 * `express.json()` only parses `application/json`, so no app-level parser has
 * to move for this. The ceiling is `MEMBER_IMAGE_MAX_MB`.
 */
export const memberImageBodyParser = express.raw({
  type: (req) => (req.headers['content-type'] ?? '').startsWith('image/'),
  limit: memberImageMaxBytes() + 64 * 1024,
});

/**
 * #1449 — a budget of its own for the two upload routes, in front of the body
 * parser so a flooded request is refused before a byte is buffered. Decoding and
 * encoding a picture is the most expensive thing a plain `POST` does here, so the
 * global per-person budget (#1395) is not tight enough for it. Keyed exactly like
 * that one — the signed-in person, never the address, which behind the two Next
 * proxies would be everybody (`apiRateLimitKey()`) — so one person spending it
 * locks nobody else out.
 */
const uploadLimiter = rateLimit({
  windowMs: MEMBER_IMAGE_UPLOAD_RATE_LIMIT_WINDOW_MS,
  limit: memberImageUploadRateLimitMax(),
  keyGenerator: (req) => apiRateLimitKey(req.headers.authorization, ipKeyGenerator(req.ip ?? '')),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many photo uploads. Please try again later.' }),
});

export const memberImageUploadRateLimit = uploadLimiter as unknown as express.RequestHandler;

/**
 * The two WebP files a request's picture becomes, or the refusal that says why
 * there are none: the content type's envelope, the body's shape, its size, the
 * decode and the format (`processMemberImage()`), and whether this deployment
 * has R2 at all. Nothing is uploaded and nothing is written on a refusal, so
 * the image already on the member stays exactly as it was.
 */
export async function parseMemberImageRequest(
  req: express.Request,
): Promise<ProcessedMemberImage | MemberImageRefusal> {
  const mime = req.headers['content-type']?.split(';')[0]?.trim() ?? '';
  if (!mime.startsWith('image/')) {
    return { status: 415, body: { error: 'Unsupported content type. Send the picture as an image/* body' } };
  }
  // `req.body` is whatever a parser left there, and a request can make that a
  // string or an array — both carry a `length` and numeric indices, so they
  // would flow into the size and decode checks as if they were bytes.
  const raw: unknown = req.body;
  if (typeof raw === 'string' || Array.isArray(raw) || !Buffer.isBuffer(raw)) {
    return { status: 400, body: { error: 'Request body must be raw image bytes' } };
  }
  const body: Buffer = raw;
  if (body.length === 0) return { status: 400, body: { error: 'Request body is empty' } };
  const maxBytes = memberImageMaxBytes();
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
  const processed = await processMemberImage(body);
  if ('rejection' in processed) {
    return {
      status: 400,
      body: { error: MEMBER_IMAGE_REJECTION_MESSAGES[processed.rejection], reason: processed.rejection },
    };
  }
  return processed;
}

/** The gym's own R2 folder prefix, or null for a gym whose bucket was never initialized. */
export async function gymStorageFolderPrefix(gymId: string): Promise<string | null> {
  const { rows } = await db.query<{ storage_folder_prefix: string | null }>(
    'SELECT storage_folder_prefix FROM gyms WHERE id = ? AND deleted_at IS NULL',
    [gymId],
  );
  return rows[0]?.storage_folder_prefix ?? null;
}

/** The 409 an upload answers for a gym whose bucket was never initialized. */
export const STORAGE_NOT_INITIALIZED: MemberImageRefusal = {
  status: 409,
  body: { error: 'Cloudflare storage has not been initialized for this gym, therefore images cannot be uploaded.' },
};

/**
 * Best-effort removal of the object a member has stopped pointing at, always
 * *after* the row has moved: a failure here leaves an orphan to sweep rather
 * than a member pointing at nothing. `isGymOwnedMemberImageUrl()` keeps another
 * gym's object, another feature's and an external URL out of this.
 *
 * No "is anything else still pointing at this?" check: nothing copies a
 * member's image reference, and the key carries the row's own id, so two
 * members cannot share an object by construction.
 */
export async function sweepReplacedMemberImage(
  folderPrefix: string | null,
  memberId: number | string,
  staleUrl: string | null,
  keepUrl: string | null,
): Promise<void> {
  if (!staleUrl || staleUrl === keepUrl) return;
  if (!isGymOwnedMemberImageUrl(staleUrl, folderPrefix)) return;
  const staleKey = storageKeyFromObjectUrl(staleUrl);
  if (!staleKey) return;
  const keepKey = keepUrl ? storageKeyFromObjectUrl(keepUrl) : null;
  if (keepKey && staleKey === keepKey) return;
  try {
    await deleteStorageObject(staleKey);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'deleteStorageObject', key: staleKey });
    logger.warn({ err, details, memberId }, 'Replaced member image left an orphaned object in Cloudflare R2');
  }
}

/**
 * Uploads the master and the thumbnail under the member's own keys and only
 * then points the row at **both**, in one `UPDATE`, sweeping the previous
 * objects when a key genuinely moved. Answers the two new URLs, or the 502 the
 * route sends when R2 refused either upload — in which case the row still
 * points at whatever it pointed at before.
 *
 * `modifiedBy` is the resolved actor text (#1182 stage 2), or null when the
 * actor cannot be named.
 */
export async function storeMemberImage(args: {
  gymId: string;
  folderPrefix: string;
  member: MemberImageRow;
  images: ProcessedMemberImage;
  modifiedBy: string | null;
}): Promise<{ image_url: string; image_thumbnail_url: string } | MemberImageRefusal> {
  const { gymId, folderPrefix, member, images, modifiedBy } = args;
  const key = buildMemberImageKey(folderPrefix, member.id, member.name);
  const thumbnailKey = buildMemberImageThumbnailKey(folderPrefix, member.id, member.name);
  const url = buildStorageObjectUrl(key) as string;
  const thumbnailUrl = buildStorageObjectUrl(thumbnailKey) as string;

  let failingKey = key;
  try {
    await ensureStorageFolders(memberImageFolderKeys(folderPrefix));
    await uploadStorageObject(key, MEMBER_IMAGE_STORED_MIME, images.image);
    failingKey = thumbnailKey;
    await uploadStorageObject(thumbnailKey, MEMBER_IMAGE_STORED_MIME, images.thumbnail);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key: failingKey });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), gymId, memberId: member.id },
      'Cloudflare R2 member image upload failed',
    );
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  await db.query(
    `UPDATE members SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [url, thumbnailUrl, modifiedBy, member.id, gymId],
  );

  // The keys are deterministic, so a replacement normally overwrites its own
  // objects and there is nothing to sweep. What this catches is a key that
  // genuinely moved: a rename whose copy failed, or an image that predates
  // this shape (a `.png`).
  await sweepReplacedMemberImage(folderPrefix, member.id, member.image_url, url);
  await sweepReplacedMemberImage(folderPrefix, member.id, member.image_thumbnail_url, thumbnailUrl);
  return { image_url: url, image_thumbnail_url: thumbnailUrl };
}

/**
 * Clears a member's image. Both references go and the gym's own objects are
 * deleted; an object that is not the gym's is left alone. No folder is needed
 * to clear a reference, so a gym with no bucket can still remove one.
 */
export async function clearMemberImage(args: {
  gymId: string;
  folderPrefix: string | null;
  member: MemberImageRow;
  modifiedBy: string | null;
}): Promise<void> {
  const { gymId, folderPrefix, member, modifiedBy } = args;
  await db.query(
    `UPDATE members SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [modifiedBy, member.id, gymId],
  );
  if (isStorageConfigured()) {
    await sweepReplacedMemberImage(folderPrefix, member.id, member.image_url, null);
    await sweepReplacedMemberImage(folderPrefix, member.id, member.image_thumbnail_url, null);
  }
}

/**
 * #1374 §5: after a rename, moves the member's image onto the keys the new name
 * builds — copy both objects to the new keys, point the row at them in one
 * `UPDATE`, and only then delete the old objects — and answers the new URLs, or
 * `null` when nothing moved.
 *
 * Every step is best-effort and logged: a copy that fails (of either object)
 * leaves the row on the old pair, which still renders (the objects are still
 * there), removes the copy that did succeed, and the next upload lands on the
 * new keys and sweeps the old ones. Only an object this gym owns under
 * `members/` is moved; a URL that is not ours is left exactly as stored.
 * Nothing here runs when the keys did not change (deterministic keys: the same
 * name builds the same keys).
 */
export async function migrateMemberImageOnRename(
  gymId: string,
  member: MemberImageRow,
): Promise<{ image_url: string; image_thumbnail_url: string | null } | null> {
  if (!member.image_url || !isStorageConfigured()) return null;
  const folderPrefix = await gymStorageFolderPrefix(gymId);
  if (!folderPrefix || !isGymOwnedMemberImageUrl(member.image_url, folderPrefix)) return null;

  const oldKey = storageKeyFromObjectUrl(member.image_url);
  const newKey = buildMemberImageKey(folderPrefix, member.id, member.name);
  const oldThumbKey = member.image_thumbnail_url && isGymOwnedMemberImageUrl(member.image_thumbnail_url, folderPrefix)
    ? storageKeyFromObjectUrl(member.image_thumbnail_url)
    : null;
  const newThumbKey = oldThumbKey ? buildMemberImageThumbnailKey(folderPrefix, member.id, member.name) : null;

  const moves: Array<[string, string]> = [];
  if (oldKey && oldKey !== newKey) moves.push([oldKey, newKey]);
  if (oldThumbKey && newThumbKey && oldThumbKey !== newThumbKey) moves.push([oldThumbKey, newThumbKey]);
  if (moves.length === 0) return null;

  const copied: string[] = [];
  for (const [from, to] of moves) {
    try {
      await copyStorageObject(from, to);
      copied.push(to);
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'copyStorageObject', key: to });
      logger.warn({ err, details, memberId: member.id }, 'Renamed member kept its image on the previous keys: copy failed');
      for (const key of copied) {
        try { await deleteStorageObject(key); } catch { /* an orphan to sweep, never a failure */ }
      }
      return null;
    }
  }

  const newUrl = oldKey && oldKey !== newKey ? (buildStorageObjectUrl(newKey) as string) : member.image_url;
  const newThumbUrl = newThumbKey && oldThumbKey !== newThumbKey
    ? (buildStorageObjectUrl(newThumbKey) as string)
    : member.image_thumbnail_url;
  await db.query(
    'UPDATE members SET image_url = ?, image_thumbnail_url = ? WHERE id = ? AND gym_id = ?',
    [newUrl, newThumbUrl, member.id, gymId],
  );
  await sweepReplacedMemberImage(folderPrefix, member.id, member.image_url, newUrl);
  await sweepReplacedMemberImage(folderPrefix, member.id, member.image_thumbnail_url, newThumbUrl);
  return { image_url: newUrl, image_thumbnail_url: newThumbUrl };
}
