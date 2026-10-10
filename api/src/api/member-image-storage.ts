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
// `domain/memberImages.ts` is still the one place the key is built and the
// bytes are judged; this module is the I/O around it.

import express from 'express';
import { db } from '../infra/db';
import {
  MEMBER_IMAGE_MAX_BYTES,
  MEMBER_IMAGE_MIME,
  MEMBER_IMAGE_REJECTION_MESSAGES,
  buildMemberImageKey,
  isGymOwnedMemberImageUrl,
  memberImageFolderKeys,
  validateMemberImage,
} from '../domain/memberImages';
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

/** The three columns the image routes need of a member. */
export interface MemberImageRow {
  id: number;
  name: string;
  image_url: string | null;
}

/** An answer the route sends as-is: a status and a JSON body. */
export interface MemberImageRefusal {
  status: number;
  body: Record<string, unknown>;
}

export function isMemberImageRefusal(value: unknown): value is MemberImageRefusal {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
}

/**
 * Raw bytes rather than JSON-with-base64: one file, so there is no pair to keep
 * atomic, and this is the shape `POST /personal-goals/:id/image` takes.
 * `express.json()` only parses `application/json`, so no app-level parser has
 * to move for this.
 */
export const memberImageBodyParser = express.raw({
  type: (req) => (req.headers['content-type'] ?? '').startsWith('image/'),
  limit: MEMBER_IMAGE_MAX_BYTES + 64 * 1024,
});

/**
 * The bytes an upload request carries, or the refusal that says why there are
 * none: the content type, the body's shape, its size, the PNG signature and the
 * dimensions (`validateMemberImage()`), and whether this deployment has R2 at
 * all. Nothing is uploaded and nothing is written on a refusal, so the image
 * already on the member stays exactly as it was.
 */
export function parseMemberImageRequest(req: express.Request): Buffer | MemberImageRefusal {
  const mime = req.headers['content-type']?.split(';')[0]?.trim();
  if (mime !== MEMBER_IMAGE_MIME) {
    return { status: 415, body: { error: `Unsupported image type. Allowed: ${MEMBER_IMAGE_MIME}` } };
  }
  // `req.body` is whatever a parser left there, and a request can make that a
  // string or an array — both carry a `length` and numeric indices, so they
  // would flow into the size and signature checks as if they were bytes.
  const raw: unknown = req.body;
  if (typeof raw === 'string' || Array.isArray(raw) || !Buffer.isBuffer(raw)) {
    return { status: 400, body: { error: 'Request body must be raw image bytes' } };
  }
  const body: Buffer = raw;
  if (body.length === 0) return { status: 400, body: { error: 'Request body is empty' } };
  if (body.length > MEMBER_IMAGE_MAX_BYTES) {
    return { status: 413, body: { error: `Image exceeds ${MEMBER_IMAGE_MAX_BYTES / (1024 * 1024)} MB limit` } };
  }
  const rejection = validateMemberImage(body);
  if (rejection) {
    return { status: 400, body: { error: MEMBER_IMAGE_REJECTION_MESSAGES[rejection], reason: rejection } };
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
  return body;
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
 * Uploads `body` under the member's own key and only then points the row at
 * it, sweeping the previous object when the key genuinely moved. Answers the
 * new URL, or the 502 the route sends when R2 refused the upload — in which
 * case the row still points at whatever it pointed at before.
 *
 * `modifiedBy` is the acting login's `gym_memberships.id`, or null when the
 * caller has none to stamp.
 */
export async function storeMemberImage(args: {
  gymId: string;
  folderPrefix: string;
  member: MemberImageRow;
  body: Buffer;
  modifiedBy: number | null;
}): Promise<string | MemberImageRefusal> {
  const { gymId, folderPrefix, member, body, modifiedBy } = args;
  const key = buildMemberImageKey(folderPrefix, member.id, member.name);
  const url = buildStorageObjectUrl(key) as string;

  try {
    await ensureStorageFolders(memberImageFolderKeys(folderPrefix));
    await uploadStorageObject(key, MEMBER_IMAGE_MIME, body);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), gymId, memberId: member.id },
      'Cloudflare R2 member image upload failed',
    );
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  await db.query(
    `UPDATE members SET image_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [url, modifiedBy, member.id, gymId],
  );

  // The key is deterministic, so a replacement normally overwrites its own
  // object and there is nothing to sweep. What this catches is a key that
  // genuinely moved: a rename whose copy failed, or an image that predates
  // this shape.
  await sweepReplacedMemberImage(folderPrefix, member.id, member.image_url, url);
  return url;
}

/**
 * Clears a member's image. The reference goes and the gym's own object is
 * deleted; an object that is not the gym's is left alone. No folder is needed
 * to clear a reference, so a gym with no bucket can still remove one.
 */
export async function clearMemberImage(args: {
  gymId: string;
  folderPrefix: string | null;
  member: MemberImageRow;
  modifiedBy: number | null;
}): Promise<void> {
  const { gymId, folderPrefix, member, modifiedBy } = args;
  await db.query(
    `UPDATE members SET image_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [modifiedBy, member.id, gymId],
  );
  if (isStorageConfigured()) {
    await sweepReplacedMemberImage(folderPrefix, member.id, member.image_url, null);
  }
}

/**
 * #1374 §5: after a rename, moves the member's image onto the key the new name
 * builds — copy to the new key, point the row at it, and only then delete the
 * old object — and answers the new URL, or `null` when nothing moved.
 *
 * Every step is best-effort and logged: a copy that fails leaves the row on the
 * old URL, which still renders (the object is still there), and the next upload
 * lands on the new key and sweeps the old one. Only an object this gym owns
 * under `members/` is moved; a URL that is not ours is left exactly as stored.
 * Nothing here runs when the key did not change (deterministic key: the same
 * name builds the same key).
 */
export async function migrateMemberImageOnRename(
  gymId: string,
  member: MemberImageRow,
): Promise<string | null> {
  if (!member.image_url || !isStorageConfigured()) return null;
  const folderPrefix = await gymStorageFolderPrefix(gymId);
  if (!folderPrefix || !isGymOwnedMemberImageUrl(member.image_url, folderPrefix)) return null;
  const oldKey = storageKeyFromObjectUrl(member.image_url);
  const newKey = buildMemberImageKey(folderPrefix, member.id, member.name);
  if (!oldKey || oldKey === newKey) return null;
  const newUrl = buildStorageObjectUrl(newKey) as string;
  try {
    await copyStorageObject(oldKey, newKey);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'copyStorageObject', key: newKey });
    logger.warn({ err, details, memberId: member.id }, 'Renamed member kept its image on the previous key: copy failed');
    return null;
  }
  await db.query('UPDATE members SET image_url = ? WHERE id = ? AND gym_id = ?', [newUrl, member.id, gymId]);
  await sweepReplacedMemberImage(folderPrefix, member.id, member.image_url, newUrl);
  return newUrl;
}
