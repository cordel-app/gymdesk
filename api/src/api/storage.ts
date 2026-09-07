import express, { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { requireFeatureEnabled } from '../infra/featureFlags';
import { isStorageConfigured, uploadGymImage } from '../infra/storage';

/**
 * #417 stage 2: generic per-gym image upload endpoint backed by Cloudflare R2.
 * One route per upload target so each carries its own module/feature guard —
 * a nutrition-image target (stage 3) will gate on NUTRITION instead of
 * TRAINING. Not directly tied to any single domain router (exercises,
 * nutrition meals, …) since the same upload flow serves all of them.
 */

export const storageRouter = Router();

const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const imageBodyParser = express.raw({
  type: (req) => (req.headers['content-type'] ?? '').startsWith('image/'),
  limit: '6mb',
});

async function handleImageUpload(req: express.Request, res: express.Response, folder: string) {
  const mime = req.headers['content-type']?.split(';')[0]?.trim();
  if (!mime || !ALLOWED_IMAGE_MIME_TYPES.includes(mime)) {
    return res.status(415).json({ error: `Unsupported image type. Allowed: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}` });
  }
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'Request body is empty' });
  if (body.length > IMAGE_MAX_BYTES) {
    return res.status(413).json({ error: `Image exceeds ${IMAGE_MAX_BYTES / (1024 * 1024)}MB limit` });
  }

  if (!isStorageConfigured()) {
    return res.status(503).json({ error: 'Cloudflare storage has not been configured for this deployment' });
  }

  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT storage_folder_prefix FROM gyms WHERE id = ? AND deleted_at IS NULL',
    [gymId],
  );
  const folderPrefix: string | null = rows[0]?.storage_folder_prefix ?? null;
  if (!folderPrefix) {
    return res.status(409).json({ error: 'Cloudflare storage has not been initialized for this gym, therefore images cannot be uploaded.' });
  }

  try {
    const url = await uploadGymImage(folderPrefix, folder, mime, body);
    res.status(201).json({ url });
  } catch (err: any) {
    res.status(502).json({ error: `Failed to upload image: ${err.message ?? 'unknown error'}` });
  }
}

storageRouter.post(
  '/uploads/exercise-image',
  requireModuleWrite('TRAINING'),
  requireFeatureEnabled('training.exercises'),
  imageBodyParser,
  (req, res, next) => { handleImageUpload(req, res, 'Exercises/Images').catch(next); },
);
