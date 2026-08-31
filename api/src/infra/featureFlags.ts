import { Request, Response, NextFunction } from 'express';
import { db } from './db';

let _cache: Record<string, boolean> | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 30_000;

export async function getFeatureFlags(): Promise<Record<string, boolean>> {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  const { rows } = await db.query<{ feature_key: string; enabled: number }>(
    'SELECT feature_key, enabled FROM feature_flags',
  );
  const flags: Record<string, boolean> = {};
  for (const r of rows) flags[r.feature_key] = r.enabled === 1;
  _cache = flags;
  _cacheAt = now;
  return flags;
}

export function invalidateFeatureFlagsCache(): void {
  _cache = null;
}

/**
 * Express middleware that blocks access to a navigation feature when it is
 * disabled. Checks the given key AND every ancestor key (split on '.'), so
 * disabling 'nutrition' also blocks 'nutrition.nutrition_library'.
 *
 * Superadmins always bypass the check. If a key has no row in the DB the
 * feature defaults to enabled (safe fallback for features not yet seeded).
 */
export function requireFeatureEnabled(key: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.tenantCtx?.isSuperadmin) return next();
    try {
      const flags = await getFeatureFlags();
      const parts = key.split('.');
      for (let i = 1; i <= parts.length; i++) {
        const ancestor = parts.slice(0, i).join('.');
        if (ancestor in flags && !flags[ancestor]) {
          return res.status(403).json({ error: 'Feature not available.' });
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
