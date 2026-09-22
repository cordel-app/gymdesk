import express, { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { requireFeatureEnabled } from '../infra/featureFlags';
import {
  describeStorageError,
  getMissingStorageConfigKeys,
  getStorageDiagnostics,
  isStorageConfigured,
  StorageOperationError,
  uploadGymImage,
} from '../infra/storage';
import { logger } from '../lib/logger';

/**
 * #417 stage 2/3: generic per-gym image upload endpoint backed by Cloudflare R2.
 * One route per upload target so each carries its own module/feature guard.
 * Not directly tied to any single domain router (exercises, nutrition meals,
 * …) since the same upload flow serves all of them.
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
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ error: 'Request body is empty' });
  }
  if (rawBody.byteLength === 0) return res.status(400).json({ error: 'Request body is empty' });
  if (rawBody.byteLength > IMAGE_MAX_BYTES) {
    return res.status(413).json({ error: `Image exceeds ${IMAGE_MAX_BYTES / (1024 * 1024)}MB limit` });
  }

  if (!isStorageConfigured()) {
    const missingConfig = getMissingStorageConfigKeys();
    return res.status(503).json({
      error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
      missingConfig,
    });
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
    const url = await uploadGymImage(folderPrefix, folder, mime, rawBody);
    res.status(201).json({ url });
  } catch (err: any) {
    // #542: same structured detail as the superadmin initialize route. The
    // deployment-config snapshot (getStorageDiagnostics()) is deliberately NOT
    // returned here — this route is gym-staff-facing, and the snapshot
    // describes platform infrastructure. It goes to the server log only.
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadGymImage' });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), gymId, folder },
      'Cloudflare R2 image upload failed',
    );
    res.status(502).json({ error: `Failed to upload image: ${details.message}`, details });
  }
}

storageRouter.post(
  '/uploads/exercise-image',
  requireModuleWrite('TRAINING'),
  requireFeatureEnabled('training.exercises'),
  imageBodyParser,
  (req, res, next) => { handleImageUpload(req, res, 'Exercises/Images').catch(next); },
);

storageRouter.post(
  '/uploads/nutrition-image',
  requireModuleWrite('NUTRITION'),
  requireFeatureEnabled('nutrition.nutrition_library'),
  imageBodyParser,
  (req, res, next) => { handleImageUpload(req, res, 'Nutrition/Images').catch(next); },
);
