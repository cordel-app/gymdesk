import express, { Request, Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolvePlatformActor } from '../domain/auditActor';
import { apiRateLimitKey } from '../domain/apiRateLimit';
import { MEMBER_IMAGE_REJECTION_MESSAGES } from '../domain/memberImages';
import { processMuscleImage } from '../domain/muscleImageProcessing';
import {
  MUSCLE_IMAGE_COLUMNS,
  MUSCLE_IMAGE_MIME,
  MUSCLE_IMAGE_UPLOAD_RATE_LIMIT_WINDOW_MS,
  MuscleSex,
  buildMuscleImageKey,
  buildMuscleImageThumbnailKey,
  isPlatformOwnedMuscleImageUrl,
  muscleImageFolderKeys,
  muscleImageMaxBytes,
  muscleImageUploadRateLimitMax,
  parseMuscleSex,
  validateMuscleImagePair,
} from '../domain/muscleImages';
import { logger } from '../lib/logger';
import { muscleTranslationsExpr, parseMuscleTranslations, replaceMuscleTranslations, withMuscleTranslations } from '../domain/muscleTranslations';
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
 *  - Since #1412 a muscle has a male and a female image, each a WebP pair (1080
 *    master + 256 thumbnail) at
 *    `cordel/muscles/images/<name>-<sex>[-thumbnail].webp`. The sexes are
 *    uploaded, replaced and removed independently. The key follows the name, so a
 *    rename moves the objects: copy, re-point the row, then delete the old ones —
 *    a failed copy leaves the row on the old, still-valid URLs.
 */
export const platformMusclesRouter = Router();

function platformActor(req: { superadminName?: string | null }) {
  return resolvePlatformActor(req.superadminName);
}

/**
 * #1413 — the upload is the **one picture as picked**, a raw `image/*` body, and
 * the server makes the 1080 master and the 256 thumbnail from it
 * (`processMuscleImage()`), the Member photo's shape (#1449). It carries a budget
 * of its own, in front of the parser, keyed on the signed-in person: decoding is
 * the most expensive plain `POST` here.
 */
const muscleImageBodyParser = express.raw({
  type: (req) => (req.headers['content-type'] ?? '').startsWith('image/'),
  limit: muscleImageMaxBytes() + 64 * 1024,
});

const muscleImageUploadLimiter = rateLimit({
  windowMs: MUSCLE_IMAGE_UPLOAD_RATE_LIMIT_WINDOW_MS,
  limit: muscleImageUploadRateLimitMax(),
  keyGenerator: (req) => apiRateLimitKey(req.headers.authorization, ipKeyGenerator(req.ip ?? '')),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many image uploads. Please try again later.' }),
}) as unknown as express.RequestHandler;

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

export interface MuscleRow {
  id: number;
  slug: string;
  name: string;
  image_male_url: string | null;
  image_male_url_thumbnail: string | null;
  image_female_url: string | null;
  image_female_url_thumbnail: string | null;
}

function allImageUrls(m: MuscleRow): (string | null)[] {
  return [m.image_male_url, m.image_male_url_thumbnail, m.image_female_url, m.image_female_url_thumbnail];
}

const SELECT_MUSCLE = `
  SELECT m.*, ${muscleTranslationsExpr('m')},
    (SELECT COUNT(DISTINCT em.exercise_id) FROM exercise_muscle_catalogue em WHERE em.muscle_id = m.id) AS exercise_count
  FROM muscles m`;

function parseName(body: any): { value: string } | { error: string } {
  const raw = body?.name;
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'name is required' };
  const value = raw.trim();
  if (value.length > 120) return { error: 'name must be at most 120 characters' };
  return { value };
}

export async function loadMuscle(id: string): Promise<MuscleRow | null> {
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
    res.json(rows.map((r: any) => withMuscleTranslations(r)));
  } catch (err) { next(err); }
});

platformMusclesRouter.get('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(`${SELECT_MUSCLE} WHERE m.id = ?`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Muscle not found' });
    res.json(withMuscleTranslations(rows[0]));
  } catch (err) { next(err); }
});


/** What a muscle write answered: the row's id, or the HTTP refusal a route returns as is. */
export type MuscleWriteResult = { ok: true; id: number } | { ok: false; status: number; body: Record<string, unknown> };

type AuditRequest = Request & { superadminName?: string | null };

/**
 * Creates a muscle under `slug`. The routes pass the slug derived from the name;
 * #2952's import passes the slug its archive carries, so an exported muscle keeps
 * its identity in the database it is imported into.
 */
export async function createMuscle(
  req: AuditRequest,
  input: { slug: string; name: string; translations?: Record<string, string> },
): Promise<MuscleWriteResult> {
  const { slug, name, translations } = input;
  const dup = await db.query('SELECT id FROM muscles WHERE slug = ? OR LOWER(name) = LOWER(?) LIMIT 1', [slug, name]);
  if (dup.rows.length > 0) return { ok: false, status: 409, body: { error: 'A muscle with this name already exists' } };
  const actor = platformActor(req);
  const id = await db.transaction(async (tx) => {
    const result = await tx.query('INSERT INTO muscles (slug, name, created_by) VALUES (?, ?, ?)', [slug, name, actor]);
    const newId = (result as any).insertId;
    if (translations) await replaceMuscleTranslations(tx, newId, translations);
    return newId;
  });
  recordAudit(req, { action: 'create', entityType: 'muscle', entityId: id, next: { slug, name } });
  return { ok: true, id };
}

/**
 * Writes a muscle's name and (when given) translations. The slug never moves,
 * and since #3350 stage 4 the image keys follow the slug, so a rename moves no
 * image object.
 */
export async function updateMuscleContent(
  req: AuditRequest,
  muscle: MuscleRow,
  input: { name: string; translations?: Record<string, string> },
): Promise<MuscleWriteResult> {
  const { name, translations } = input;
  const dup = await db.query('SELECT id FROM muscles WHERE LOWER(name) = LOWER(?) AND id != ? LIMIT 1', [name, muscle.id]);
  if (dup.rows.length > 0) return { ok: false, status: 409, body: { error: 'A muscle with this name already exists' } };

  const actor = platformActor(req);
  await db.transaction(async (tx) => {
    await tx.query(
      'UPDATE muscles SET name = ?, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ?',
      [name, actor, muscle.id],
    );
    if (translations) await replaceMuscleTranslations(tx, muscle.id, translations);
  });
  recordAudit(req, {
    action: 'update', entityType: 'muscle', entityId: muscle.id,
    previous: { name: muscle.name }, next: { name },
  });
  return { ok: true, id: muscle.id };
}

/**
 * Processes one picture into the muscle's `sex` pair and points the row at it
 * (#1413). Nothing is uploaded and nothing is written on a refusal, so the image
 * the muscle already has stays exactly as it was.
 */
export async function storeMuscleImage(
  req: AuditRequest,
  muscle: MuscleRow,
  sex: MuscleSex,
  original: Buffer,
): Promise<MuscleWriteResult> {
  if (original.length === 0) return { ok: false, status: 400, body: { error: 'Request body is empty' } };
  const maxBytes = muscleImageMaxBytes();
  if (original.length > maxBytes) {
    return { ok: false, status: 413, body: { error: `Image exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB limit` } };
  }
  if (!isStorageConfigured()) {
    const missingConfig = getMissingStorageConfigKeys();
    return {
      ok: false,
      status: 503,
      body: {
        error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
        missingConfig,
      },
    };
  }
  const processed = await processMuscleImage(original);
  if ('rejection' in processed) {
    return { ok: false, status: 400, body: { error: MEMBER_IMAGE_REJECTION_MESSAGES[processed.rejection], reason: processed.rejection } };
  }
  const { image, thumbnail } = processed;
  const problem = validateMuscleImagePair(image, thumbnail);
  if (problem) {
    logger.error({ problem, muscleId: muscle.id }, 'Muscle image processing produced an invalid file');
    return { ok: false, status: 500, body: { error: 'The image could not be processed' } };
  }

  const cols = MUSCLE_IMAGE_COLUMNS[sex];
  const previous = [(muscle as any)[cols.image] as string | null, (muscle as any)[cols.thumbnail] as string | null];
  const imageKey = buildMuscleImageKey(muscle.slug, sex);
  const thumbnailKey = buildMuscleImageThumbnailKey(muscle.slug, sex);
  const imageUrl = buildStorageObjectUrl(imageKey);
  const thumbnailUrl = buildStorageObjectUrl(thumbnailKey);
  try {
    await ensureStorageFolders(muscleImageFolderKeys());
    await uploadStorageObject(imageKey, MUSCLE_IMAGE_MIME, image);
    await uploadStorageObject(thumbnailKey, MUSCLE_IMAGE_MIME, thumbnail);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key: imageKey });
    logger.error({ err, details, diagnostics: getStorageDiagnostics(), muscleId: muscle.id }, 'Cloudflare R2 muscle image upload failed');
    return { ok: false, status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  const actor = platformActor(req);
  await db.query(
    `UPDATE muscles SET ${cols.image} = ?, ${cols.thumbnail} = ?, modified_at = UTC_TIMESTAMP(),
            modified_by = ? WHERE id = ?`,
    [imageUrl, thumbnailUrl, actor, muscle.id],
  );
  await sweepMuscleObjects(previous, [imageUrl, thumbnailUrl]);
  recordAudit(req, {
    action: 'update', entityType: 'muscle', entityId: muscle.id,
    previous: { [cols.image]: previous[0] }, next: { [cols.image]: imageUrl },
  });
  return { ok: true, id: muscle.id };
}

/** One muscle as every read answers it. */
export async function readMuscle(id: number | string): Promise<any> {
  const { rows } = await db.query(`${SELECT_MUSCLE} WHERE m.id = ?`, [id]);
  return rows[0] ? withMuscleTranslations(rows[0]) : null;
}


platformMusclesRouter.post('/', requireSuperadmin, async (req, res, next) => {
  try {
    const parsed = parseName(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const tr = parseMuscleTranslations(req.body);
    if (tr.error) return res.status(400).json({ error: tr.error });
    const slug = slugFromMuscleName(parsed.value);
    if (!slug) return res.status(400).json({ error: 'name must contain letters or digits' });
    const result = await createMuscle(req, { slug, name: parsed.value, translations: tr.translations });
    if (!result.ok) return res.status(result.status).json(result.body);
    res.status(201).json(await readMuscle(result.id));
  } catch (err) { next(err); }
});

platformMusclesRouter.put('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const muscle = await loadMuscle(String(req.params.id));
    if (!muscle) return res.status(404).json({ error: 'Muscle not found' });
    const parsed = parseName(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const tr = parseMuscleTranslations(req.body);
    if (tr.error) return res.status(400).json({ error: tr.error });
    const result = await updateMuscleContent(req, muscle, { name: parsed.value, translations: tr.translations });
    if (!result.ok) return res.status(result.status).json(result.body);
    res.json(await readMuscle(muscle.id));
  } catch (err) { next(err); }
});

platformMusclesRouter.delete('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const muscle = await loadMuscle(String(req.params.id));
    if (!muscle) return res.status(404).json({ error: 'Muscle not found' });
    const used = await db.query<{ n: number }>(
      'SELECT COUNT(DISTINCT exercise_id) AS n FROM exercise_muscle_catalogue WHERE muscle_id = ?', [muscle.id],
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
    await sweepMuscleObjects(allImageUrls(muscle), []);
    recordAudit(req, {
      action: 'delete', entityType: 'muscle', entityId: muscle.id,
      previous: { slug: muscle.slug, name: muscle.name },
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

platformMusclesRouter.post('/:id/image/:sex', requireSuperadmin, muscleImageUploadLimiter, muscleImageBodyParser, async (req, res, next) => {
  try {
    const sex = parseMuscleSex(req.params.sex);
    if (!sex) return res.status(400).json({ error: 'sex must be "male" or "female"' });
    const mime = req.headers['content-type']?.split(';')[0]?.trim() ?? '';
    if (!mime.startsWith('image/')) {
      return res.status(415).json({ error: 'Unsupported content type. Send the picture as an image/* body' });
    }
    // `req.body` is whatever a parser left there, and a request can make that a
    // string or an array — both carry a `length`, so only a Buffer is image bytes.
    const raw: unknown = req.body;
    if (typeof raw === 'string' || Array.isArray(raw) || !Buffer.isBuffer(raw)) {
      return res.status(400).json({ error: 'Request body must be raw image bytes' });
    }
    const original: Buffer = raw;
    const muscle = await loadMuscle(String(req.params.id));
    if (!muscle) return res.status(404).json({ error: 'Muscle not found' });
    const result = await storeMuscleImage(req, muscle, sex, original);
    if (!result.ok) return res.status(result.status).json(result.body);
    res.json(await readMuscle(muscle.id));
  } catch (err) { next(err); }
});

platformMusclesRouter.delete('/:id/image/:sex', requireSuperadmin, async (req, res, next) => {
  try {
    const sex = parseMuscleSex(req.params.sex);
    if (!sex) return res.status(400).json({ error: 'sex must be "male" or "female"' });
    const muscle = await loadMuscle(String(req.params.id));
    if (!muscle) return res.status(404).json({ error: 'Muscle not found' });
    const cols = MUSCLE_IMAGE_COLUMNS[sex];
    const previous = [(muscle as any)[cols.image] as string | null, (muscle as any)[cols.thumbnail] as string | null];
    const actor = platformActor(req);
    await db.query(
      `UPDATE muscles SET ${cols.image} = NULL, ${cols.thumbnail} = NULL, modified_at = UTC_TIMESTAMP(),
              modified_by = ? WHERE id = ?`,
      [actor, muscle.id],
    );
    await sweepMuscleObjects(previous, []);
    recordAudit(req, {
      action: 'update', entityType: 'muscle', entityId: muscle.id,
      previous: { [cols.image]: previous[0] }, next: { [cols.image]: null },
    });
    const { rows } = await db.query(`${SELECT_MUSCLE} WHERE m.id = ?`, [muscle.id]);
    res.json(withMuscleTranslations(rows[0]));
  } catch (err) { next(err); }
});
