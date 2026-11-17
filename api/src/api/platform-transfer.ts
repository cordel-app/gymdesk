import express, { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { apiRateLimitKey } from '../domain/apiRateLimit';
import {
  StorageOperationError,
  describeStorageError,
  getStorageObject,
  isStorageConfigured,
  storageKeyFromObjectUrl,
} from '../infra/storage';
import {
  TRANSFER_ENTITY_TYPES,
  TRANSFER_IMAGE_RATE_LIMIT_WINDOW_MS,
  TransferAction,
  isTransferableObjectKey,
  isValidMuscleSlug,
  muscleSexFromSlot,
  parseMuscleTransferRecord,
  transferImageRateLimitMax,
} from '../domain/entityTransfer';
import { muscleImageMaxBytes } from '../domain/muscleImages';
import { muscleTranslationsExpr, withMuscleTranslations } from '../domain/muscleTranslations';
import {
  MuscleRow,
  createMuscle,
  readMuscle,
  storeMuscleImage,
  updateMuscleContent,
} from './platform-muscles';
import { logger } from '../lib/logger';

/**
 * #2952 — Cordel → Export / Import, the API half (superadmin only). The Admin
 * builds and reads the ZIP itself, one entity at a time, so it can show progress
 * and keep going past a failed entity; these routes are what it calls:
 *
 *  - `GET /types` — the entity types that can be moved (the Admin's checkboxes).
 *  - `GET /<type>` — every entity of a type as an export record: `slug`, the
 *    entity's own content and the stored URL of each image.
 *  - `GET /object?url=` — the bytes of one exported image, read back through the
 *    API (a platform object only), so the archive carries the files themselves.
 *  - `POST /<type>` — one imported entity, upserted by `slug`: created through the
 *    entity's own creator when no row carries the slug, otherwise its content
 *    written through the entity's own updater. Relationships are never touched.
 *  - `POST /<type>/:slug/image/:slot` — one imported image, processed and stored
 *    by the entity's own image writer exactly as an editor upload is.
 */
export const platformTransferRouter = Router();

platformTransferRouter.get('/types', requireSuperadmin, (_req, res) => {
  res.json({ types: TRANSFER_ENTITY_TYPES });
});

platformTransferRouter.get('/object', requireSuperadmin, async (req, res, next) => {
  try {
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    const key = storageKeyFromObjectUrl(url);
    if (!isTransferableObjectKey(key)) return res.status(404).json({ error: 'Object not found' });
    if (!isStorageConfigured()) return res.status(503).json({ error: 'Cloudflare storage has not been configured for this deployment' });
    try {
      const object = await getStorageObject(key);
      res.setHeader('Content-Type', object.contentType ?? 'application/octet-stream');
      res.send(object.body);
    } catch (err: any) {
      const details = err instanceof StorageOperationError ? err.details : describeStorageError(err, { operation: 'getStorageObject', key });
      logger.warn({ err, details }, 'Export could not read a stored object');
      return res.status(502).json({ error: `Failed to read image: ${details.message}`, details });
    }
  } catch (err) { next(err); }
});

// ── Muscles ─────────────────────────────────────────────────────────────────

platformTransferRouter.get('/muscles', requireSuperadmin, async (_req, res, next) => {
  try {
    const { rows } = await db.query<any>(
      `SELECT m.*, ${muscleTranslationsExpr('m')} FROM muscles m ORDER BY m.slug ASC`,
    );
    res.json({
      type: 'muscles',
      entities: rows.map((raw: any) => {
        const m = withMuscleTranslations(raw);
        return {
          slug: m.slug,
          data: { name: m.name, translations: m.translations ?? {} },
          images: { male: m.image_male_url ?? null, female: m.image_female_url ?? null },
        };
      }),
    });
  } catch (err) { next(err); }
});

platformTransferRouter.post('/muscles', requireSuperadmin, async (req, res, next) => {
  try {
    const parsed = parseMuscleTransferRecord(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const { slug, name, translations } = parsed.record;
    const existing = await db.query<MuscleRow>('SELECT * FROM muscles WHERE slug = ?', [slug]);
    const muscle = existing.rows[0];
    let action: TransferAction;
    let result;
    if (muscle) {
      action = 'updated';
      result = await updateMuscleContent(req, muscle, { name, translations });
    } else {
      action = 'created';
      result = await createMuscle(req, { slug, name, translations });
    }
    if (!result.ok) return res.status(result.status).json(result.body);
    res.status(action === 'created' ? 201 : 200).json({ action, entity: await readMuscle(result.id) });
  } catch (err) { next(err); }
});

/**
 * The import uploads many images in one run, so it has a budget of its own,
 * keyed on the signed-in person exactly as every upload limiter is (#1395).
 * Each image is still decoded and re-encoded by the entity's own processor.
 */
const transferImageLimiter = rateLimit({
  windowMs: TRANSFER_IMAGE_RATE_LIMIT_WINDOW_MS,
  limit: transferImageRateLimitMax(),
  keyGenerator: (req) => apiRateLimitKey(req.headers.authorization, ipKeyGenerator(req.ip ?? '')),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many image uploads. Please try again later.' }),
}) as unknown as express.RequestHandler;

const transferImageBodyParser = express.raw({
  type: (req) => (req.headers['content-type'] ?? '').startsWith('image/'),
  limit: muscleImageMaxBytes() + 64 * 1024,
});

platformTransferRouter.post(
  '/muscles/:slug/image/:slot',
  requireSuperadmin,
  transferImageLimiter,
  transferImageBodyParser,
  async (req, res, next) => {
    try {
      const sex = muscleSexFromSlot(String(req.params.slot));
      if (!sex) return res.status(400).json({ error: 'slot must be "male" or "female"' });
      if (!isValidMuscleSlug(req.params.slug)) return res.status(404).json({ error: 'Muscle not found' });
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
      const { rows } = await db.query<MuscleRow>('SELECT * FROM muscles WHERE slug = ?', [req.params.slug]);
      if (!rows[0]) return res.status(404).json({ error: 'Muscle not found' });
      const result = await storeMuscleImage(req, rows[0], sex, original);
      if (!result.ok) return res.status(result.status).json(result.body);
      res.json({ entity: await readMuscle(result.id) });
    } catch (err) { next(err); }
  },
);
