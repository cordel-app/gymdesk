import express, { Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { actorSnapshot } from '../domain/nutritionLibrary';
import {
  EXERCISE_IMAGE_MASTER_MAX_BYTES,
  EXERCISE_IMAGE_MIME,
  EXERCISE_IMAGE_THUMBNAIL_MAX_BYTES,
  validateExerciseImagePair,
} from '../domain/exerciseImages';
import {
  buildMuscleImageKey,
  buildMuscleImageThumbnailKey,
  isPlatformOwnedMuscleImageUrl,
  muscleImageFolderKeys,
} from '../domain/muscleImages';
import { logger } from '../lib/logger';
import {
  StorageOperationError,
  buildStorageObjectUrl,
  copyStorageObject,
  deleteStorageObject,
  describeStorageError,
  ensureStorageFolders,
  getMissingStorageConfigKeys,
  getStorageDiagnostics,
  isStorageConfigured,
  storageKeyFromObjectUrl,
  uploadStorageObject,
} from '../infra/storage';

/**
 * #1368 stage 3 — Cordel → Muscles. The only writer of `muscles` rows and of
 * their image pair. A muscle is a global catalogue row (no `gym_id`), so every
 * route is `requireSuperadmin`.
 *
 *  - `slug` is the stable key `exercise_muscles` links resolve through (stage 2);
 *    it is derived from the first name and **never changes**, so a rename cannot
 *    break a link or an Admin label key.
 *  - Delete is a hard delete, refused with a 409 and the referencing count while
 *    any exercise link uses the muscle (ticket thread).
 *  - The image is the Base Exercise pair (2048 master + 512 thumbnail, validated
 *    from the bytes) at `cordel/muscles/images/<name>.png`. The key follows the
 *    name, so a rename moves the objects: copy, re-point the row, then delete the
 *    old ones — a failed copy leaves the row on the old, still-valid URLs.
 */
export const platformMusclesRouter = Router();

function platformActor(req: { superadminName?: string | null }) {
  return actorSnapshot({ name: req.superadminName, isSuperadmin: true });
}

export const PLATFORM_MUSCLE_IMAGE_UPLOAD_PATH = /^\/platform\/muscles\/[^/]+\/image\/?$/;

export const platformMuscleImageBodyParser = express.json({
  limit: Math.ceil((EXERCISE_IMAGE_MASTER_MAX_BYTES + EXERCISE_IMAGE_THUMBNAIL_MAX_BYTES) * 1.4),
});

function decodeBase64File(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const payload = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  const buffer = Buffer.from(payload, 'base64');
  return buffer.length > 0 ? buffer : null;
}

/** `Middle Back` → `middle_back`: the catalogue's slug shape. */
export function slugFromMuscleName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

interface MuscleRow {
  id: number;
  slug: string;
  name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

const SELECT_MUSCLE = `
  SELECT m.*,
    (SELECT COUNT(DISTINCT em.exercise_id) FROM exercise_muscles em WHERE em.muscle_id = m.id) AS exercise_count
  FROM muscles m`;

function parseName(body: any): { value: string } | { error: string } {
  const raw = body?.name;
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'name is required' };
  const value = raw.trim();
  if (value.length > 120) return { error: 'name must be at most 120 characters' };
  return { value };
}

async function loadMuscle(id: string): Promise<MuscleRow | null> {
  const { rows } = await db.query<MuscleRow>('SELECT * FROM muscles WHERE id = ?', [id]);
  return rows[0] ?? null;
}

/** Best-effort removal of objects a muscle stopped pointing at, after the row changed. */
async function sweepMuscleObjects(stale: (string | null)[], keep: (string | null)[]): Promise<void> {
  const kept = new Set(keep.filter((u): u is string => !!u).map((u) => storageKeyFromObjectUrl(u) ?? u));
  for (const url of stale) {
    if (!url || !isPlatformOwnedMuscleImageUrl(url)) continue;
    const key = storageKeyFromObjectUrl(url);
    if (!key || kept.has(key)) continue;
    try {
      await deleteStorageObject(key);
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'deleteStorageObject', key });
      logger.warn({ err, details }, 'Replaced muscle image left an orphaned object in Cloudflare R2');
    }
  }
}

platformMusclesRouter.get('/', requireSuperadmin, async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const where = q ? 'WHERE m.name LIKE ? OR m.slug LIKE ?' : '';
    const params = q ? [`%${q}%`, `%${q}%`] : [];
    const { rows } = await db.query(`${SELECT_MUSCLE} ${where} ORDER BY m.name ASC, m.id ASC`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

platformMusclesRouter.get('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(`${SELECT_MUSCLE} WHERE m.id = ?`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Muscle not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

platformMusclesRouter.post('/', requireSuperadmin, async (req, res, next) => {
  try {
    const parsed = parseName(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const slug = slugFromMuscleName(parsed.value);
    if (!slug) return res.status(400).json({ error: 'name must contain letters or digits' });
    const dup = await db.query('SELECT id FROM muscles WHERE slug = ? OR LOWER(name) = LOWER(?) LIMIT 1', [slug, parsed.value]);
    if (dup.rows.length > 0) return res.status(409).json({ error: 'A muscle with this name already exists' });

    const actor = platformActor(req);
    const result = await db.query(
      'INSERT INTO muscles (slug, name, created_by_name, created_by_type) VALUES (?, ?, ?, ?)',
      [slug, parsed.value, actor.name, actor.type],
    );
    const id = (result as any).insertId;
    recordAudit(req, { action: 'create', entityType: 'muscle', entityId: id, next: { slug, name: parsed.value } });
    const { rows } = await db.query(`${SELECT_MUSCLE} WHERE m.id = ?`, [id]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

platformMusclesRouter.put('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const muscle = await loadMuscle(String(req.params.id));
    if (!muscle) return res.status(404).json({ error: 'Muscle not found' });
    const parsed = parseName(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const name = parsed.value;

    const dup = await db.query('SELECT id FROM muscles WHERE LOWER(name) = LOWER(?) AND id != ? LIMIT 1', [name, muscle.id]);
    if (dup.rows.length > 0) return res.status(409).json({ error: 'A muscle with this name already exists' });

    let imageUrl = muscle.image_url;
    let thumbnailUrl = muscle.image_thumbnail_url;
    const moves: { from: string; to: string }[] = [];
    if (name !== muscle.name) {
      // The key follows the name: move whichever of the pair is ours to the new
      // key before the row is re-pointed. A failed copy aborts the rename with
      // the row untouched.
      const newImageKey = buildMuscleImageKey(name);
      const newThumbKey = buildMuscleImageThumbnailKey(name);
      const pairs: [string | null, string][] = [[muscle.image_url, newImageKey], [muscle.image_thumbnail_url, newThumbKey]];
      for (const [url, newKey] of pairs) {
        const oldKey = url && isPlatformOwnedMuscleImageUrl(url) ? storageKeyFromObjectUrl(url) : null;
        if (oldKey && oldKey !== newKey) moves.push({ from: oldKey, to: newKey });
      }
      try {
        if (moves.length) await ensureStorageFolders(muscleImageFolderKeys());
        for (const m of moves) await copyStorageObject(m.from, m.to);
      } catch (err: any) {
        const details = err instanceof StorageOperationError
          ? err.details
          : describeStorageError(err, { operation: 'copyStorageObject', key: moves[0]?.to });
        logger.error({ err, details, muscleId: muscle.id }, 'Cloudflare R2 muscle image move failed');
        return res.status(502).json({ error: `Failed to move image: ${details.message}`, details });
      }
      for (const m of moves) {
        if (m.to === newImageKey) imageUrl = buildStorageObjectUrl(newImageKey);
        if (m.to === newThumbKey) thumbnailUrl = buildStorageObjectUrl(newThumbKey);
      }
    }

    const actor = platformActor(req);
    await db.query(
      `UPDATE muscles SET name = ?, image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(),
              modified_by_name = ?, modified_by_type = ? WHERE id = ?`,
      [name, imageUrl, thumbnailUrl, actor.name, actor.type, muscle.id],
    );
    if (moves.length) await sweepMuscleObjects([muscle.image_url, muscle.image_thumbnail_url], [imageUrl, thumbnailUrl]);

    recordAudit(req, {
      action: 'update', entityType: 'muscle', entityId: muscle.id,
      previous: { name: muscle.name }, next: { name },
    });
    const { rows } = await db.query(`${SELECT_MUSCLE} WHERE m.id = ?`, [muscle.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

platformMusclesRouter.delete('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const muscle = await loadMuscle(String(req.params.id));
    if (!muscle) return res.status(404).json({ error: 'Muscle not found' });
    const used = await db.query<{ n: number }>(
      'SELECT COUNT(DISTINCT exercise_id) AS n FROM exercise_muscles WHERE muscle_id = ?', [muscle.id],
    );
    const exerciseCount = Number(used.rows[0]?.n ?? 0);
    if (exerciseCount > 0) {
      return res.status(409).json({
        error: `Muscle is used by ${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'} and cannot be deleted`,
        code: 'muscle_in_use',
        exercise_count: exerciseCount,
      });
    }
    await db.query('DELETE FROM muscles WHERE id = ?', [muscle.id]);
    await sweepMuscleObjects([muscle.image_url, muscle.image_thumbnail_url], []);
    recordAudit(req, {
      action: 'delete', entityType: 'muscle', entityId: muscle.id,
      previous: { slug: muscle.slug, name: muscle.name },
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

platformMusclesRouter.post('/:id/image', requireSuperadmin, async (req, res, next) => {
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
        error: problem.message, reason: problem.rejection, file: problem.kind,
      });
    }
    if (!isStorageConfigured()) {
      const missingConfig = getMissingStorageConfigKeys();
      return res.status(503).json({
        error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
        missingConfig,
      });
    }
    const muscle = await loadMuscle(String(req.params.id));
    if (!muscle) return res.status(404).json({ error: 'Muscle not found' });

    const imageKey = buildMuscleImageKey(muscle.name);
    const thumbnailKey = buildMuscleImageThumbnailKey(muscle.name);
    const imageUrl = buildStorageObjectUrl(imageKey);
    const thumbnailUrl = buildStorageObjectUrl(thumbnailKey);
    try {
      await ensureStorageFolders(muscleImageFolderKeys());
      await uploadStorageObject(imageKey, EXERCISE_IMAGE_MIME, image);
      await uploadStorageObject(thumbnailKey, EXERCISE_IMAGE_MIME, thumbnail);
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'uploadStorageObject', key: imageKey });
      logger.error({ err, details, diagnostics: getStorageDiagnostics(), muscleId: muscle.id }, 'Cloudflare R2 muscle image upload failed');
      return res.status(502).json({ error: `Failed to upload image: ${details.message}`, details });
    }

    const actor = platformActor(req);
    await db.query(
      `UPDATE muscles SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(),
              modified_by_name = ?, modified_by_type = ? WHERE id = ?`,
      [imageUrl, thumbnailUrl, actor.name, actor.type, muscle.id],
    );
    await sweepMuscleObjects([muscle.image_url, muscle.image_thumbnail_url], [imageUrl, thumbnailUrl]);
    recordAudit(req, {
      action: 'update', entityType: 'muscle', entityId: muscle.id,
      previous: { image_url: muscle.image_url }, next: { image_url: imageUrl },
    });
    const { rows } = await db.query(`${SELECT_MUSCLE} WHERE m.id = ?`, [muscle.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

platformMusclesRouter.delete('/:id/image', requireSuperadmin, async (req, res, next) => {
  try {
    const muscle = await loadMuscle(String(req.params.id));
    if (!muscle) return res.status(404).json({ error: 'Muscle not found' });
    const actor = platformActor(req);
    await db.query(
      `UPDATE muscles SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(),
              modified_by_name = ?, modified_by_type = ? WHERE id = ?`,
      [actor.name, actor.type, muscle.id],
    );
    await sweepMuscleObjects([muscle.image_url, muscle.image_thumbnail_url], []);
    recordAudit(req, {
      action: 'update', entityType: 'muscle', entityId: muscle.id,
      previous: { image_url: muscle.image_url }, next: { image_url: null },
    });
    const { rows } = await db.query(`${SELECT_MUSCLE} WHERE m.id = ?`, [muscle.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});
