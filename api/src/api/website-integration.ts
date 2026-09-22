import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { generateWebsiteApiKey } from '../infra/website-api-key';

/**
 * #599: manages the per-gym API key the gym's website uses to call
 * POST /public/gyms/:gymRef/registrations. The plaintext key is returned exactly
 * once, by POST /key; only a scrypt digest is stored, so GET can never leak it.
 */
export const websiteIntegrationRouter = Router();

// The API's own public origin. API_PUBLIC_URL wins; otherwise it is derived
// from PAYMENT_NOTIFICATION_URL, which already points at this API in every
// deployed environment. Null when neither is set — the UI then shows the path.
function apiPublicOrigin(): string | null {
  const explicit = process.env.API_PUBLIC_URL?.replace(/\/+$/, '');
  if (explicit) return explicit;
  try {
    return new URL(process.env.PAYMENT_NOTIFICATION_URL ?? '').origin;
  } catch {
    return null;
  }
}

async function loadStatus(gymId: string) {
  const { rows } = await db.query<{
    id: string; slug: string; website_api_key_prefix: string | null; website_api_key_created_at: Date | null;
  }>(
    'SELECT id, slug, website_api_key_prefix, website_api_key_created_at FROM gyms WHERE id = ?',
    [gymId],
  );
  const gym = rows[0];
  // #645: `{gymId}-{gym-name}`. The id is what the API resolves; the name is
  // there to keep the URL readable, and is encoded because a slug set by hand
  // is not guaranteed to be URL-safe.
  const gymRef = `${gym.id}-${encodeURIComponent(gym.slug)}`;
  const endpointPath = `/public/gyms/${gymRef}/registrations`;
  const origin = apiPublicOrigin();
  return {
    configured: !!gym.website_api_key_prefix,
    key_prefix: gym.website_api_key_prefix,
    created_at: gym.website_api_key_created_at,
    slug: gym.slug,
    gym_ref: gymRef,
    endpoint_path: endpointPath,
    endpoint_url: origin ? `${origin}${endpointPath}` : null,
  };
}

websiteIntegrationRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    res.json(await loadStatus(gymId));
  } catch (err) {
    next(err);
  }
});

// POST /key — generate, or rotate: the previous key stops working immediately.
websiteIntegrationRouter.post('/key', requireModuleWrite('SYSTEM'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const before = await loadStatus(gymId);
    const { key, hash, prefix } = await generateWebsiteApiKey();
    await db.query(
      `UPDATE gyms SET website_api_key_hash = ?, website_api_key_prefix = ?, website_api_key_created_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [hash, prefix, gymId],
    );
    recordAudit(req, {
      action: before.configured ? 'rotate' : 'create',
      entityType: 'website_api_key',
      entityId: gymId,
      previous: before.configured ? { key_prefix: before.key_prefix } : undefined,
      next: { key_prefix: prefix },
    });
    res.status(201).json({ ...(await loadStatus(gymId)), key });
  } catch (err) {
    next(err);
  }
});

websiteIntegrationRouter.delete('/key', requireModuleWrite('SYSTEM'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const before = await loadStatus(gymId);
    if (!before.configured) return res.status(404).json({ error: 'No website API key to revoke.' });
    await db.query(
      `UPDATE gyms SET website_api_key_hash = NULL, website_api_key_prefix = NULL, website_api_key_created_at = NULL
       WHERE id = ?`,
      [gymId],
    );
    recordAudit(req, {
      action: 'revoke',
      entityType: 'website_api_key',
      entityId: gymId,
      previous: { key_prefix: before.key_prefix },
    });
    res.json(await loadStatus(gymId));
  } catch (err) {
    next(err);
  }
});
