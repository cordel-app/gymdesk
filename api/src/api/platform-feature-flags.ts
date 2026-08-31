/**
 * #292: Feature Flags management.
 *
 * platformFeatureFlagsRouter — superadmin-only CRUD, mounted at
 *   /platform/feature-flags.
 *
 * featureFlagsPublicRouter — read-only, any authenticated user, mounted at
 *   /feature-flags. Returns the full flag map so the frontend can filter the
 *   sidebar without a separate superadmin call.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireSuperadmin } from '../infra/tenantContext';
import { db } from '../infra/db';
import { invalidateFeatureFlagsCache } from '../infra/featureFlags';

export const platformFeatureFlagsRouter = Router();
export const featureFlagsPublicRouter = Router();

// ─── Superadmin: list all flags ───────────────────────────────────────────────

platformFeatureFlagsRouter.get(
  '/',
  requireSuperadmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await db.query<{ feature_key: string; enabled: number; updated_at: string; updated_by_name: string | null }>(
        'SELECT feature_key, enabled, updated_at, updated_by_name FROM feature_flags ORDER BY feature_key',
      );
      res.json(rows.map(r => ({ ...r, enabled: r.enabled === 1 })));
    } catch (err) { next(err); }
  },
);

// ─── Superadmin: toggle a flag ────────────────────────────────────────────────

platformFeatureFlagsRouter.put(
  '/:featureKey',
  requireSuperadmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const { featureKey } = req.params;
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    try {
      const { rows: existing } = await db.query<{ enabled: number }>(
        'SELECT enabled FROM feature_flags WHERE feature_key = ?',
        [featureKey],
      );
      if (!existing[0]) return res.status(404).json({ error: 'Feature flag not found' });

      const prev = existing[0].enabled === 1;
      const actorName = req.superadminName ?? null;

      await db.query(
        'UPDATE feature_flags SET enabled = ?, updated_at = UTC_TIMESTAMP(), updated_by_name = ? WHERE feature_key = ?',
        [enabled ? 1 : 0, actorName, featureKey],
      );

      invalidateFeatureFlagsCache();

      // Write platform-scoped audit row directly (no tenantCtx on platform routes).
      const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
        || req.ip || null;
      const ua = (req.headers['user-agent'] as string | undefined)?.slice(0, 500) ?? null;
      db.query(
        `INSERT INTO audit_logs
         (gym_id, actor_user_id, actor_name, action, entity_type, entity_id, entity_name,
          previous_values, new_values, source, ip, user_agent)
         VALUES (NULL, ?, ?, 'update', 'feature_flag', ?, ?, ?, ?, 'admin', ?, ?)`,
        [
          (req as any).auth?.userId ?? null,
          actorName,
          featureKey,
          featureKey,
          JSON.stringify({ enabled: prev }),
          JSON.stringify({ enabled }),
          ip,
          ua,
        ],
      ).catch((err: any) => console.error('feature_flag audit insert failed', err.message));

      res.json({ feature_key: featureKey, enabled });
    } catch (err) { next(err); }
  },
);

// ─── Public read: any authenticated user ─────────────────────────────────────

featureFlagsPublicRouter.get(
  '/',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await db.query<{ feature_key: string; enabled: number }>(
        'SELECT feature_key, enabled FROM feature_flags',
      );
      const flags: Record<string, boolean> = {};
      for (const r of rows) flags[r.feature_key] = r.enabled === 1;
      res.json(flags);
    } catch (err) { next(err); }
  },
);
