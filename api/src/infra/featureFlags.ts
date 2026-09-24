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
 * Is a feature available? Checks the given key AND every ancestor key (split on
 * '.'), so disabling 'nutrition' also blocks 'nutrition.nutrition_library'.
 * A key with no row defaults to enabled (features not yet seeded).
 *
 * Flags are platform-wide, not per-gym — there is no `gym_id` on
 * `feature_flags`. Extracted from `requireFeatureEnabled` for callers with no
 * request to guard: #647 stage 4's nightly job has to honour the same
 * 'organization.professional_services' flag the slot endpoints are mounted
 * behind, or turning the feature off would stop the UI while a scheduler kept
 * quietly creating bookings.
 */
export async function isFeatureEnabled(key: string): Promise<boolean> {
  const flags = await getFeatureFlags();
  const parts = key.split('.');
  for (let i = 1; i <= parts.length; i++) {
    const ancestor = parts.slice(0, i).join('.');
    if (ancestor in flags && !flags[ancestor]) return false;
  }
  return true;
}

/**
 * #635 stage 12 — the switch for the corrected Membership Fee pricing.
 *
 * With it **off** (how migration 186 seeds it), `computeFinalPrice` and the
 * nightly run behave exactly as they did before stage 12: the fee a Promotion
 * discounted stays discounted for as long as the application stands. With it
 * **on**, both resolve the fee for the cycle being priced through
 * `resolveMembershipFee`, so a Promotion's Membership Fee Benefit ends with the
 * Promotion's own Free/Paid/Bonus timeline — which can *raise* what a member
 * whose promotional months already elapsed is charged. The thread asked for that
 * impact to be surfaced before it moves money, so it ships switchable and off:
 * `GET /user-memberships/membership-fee-drift` (and the run's own `drift`
 * counter) report every assignment it would reprice.
 *
 * Every read-only surface — the Billing Simulation, the Billing Events
 * projection, My Membership — resolves dates through the same rule regardless of
 * this flag: showing the agreed timeline correctly charges nobody.
 */
export const DATE_AWARE_MEMBERSHIP_FEE_FLAG = 'billing.date_aware_membership_fee';

/** Is the corrected (date-aware) Membership Fee pricing live for real billing? */
export function isDateAwareMembershipFeeEnabled(): Promise<boolean> {
  return isFeatureEnabled(DATE_AWARE_MEMBERSHIP_FEE_FLAG);
}

/**
 * Express middleware that blocks access to a navigation feature when it is
 * disabled. Checks the given key AND every ancestor key (split on '.'), so
 * disabling 'nutrition' also blocks 'nutrition.nutrition_library'.
 *
 * Superadmins bypass the check only in their native capacity. While
 * impersonating (`tenantCtx.impersonatedUserId` set), the check applies
 * against the impersonated user's scope like it would for anyone else (#439)
 * — `tenantCtx.isSuperadmin` stays `true` under impersonation for other
 * permission checks, so impersonation must be excluded here explicitly.
 * If a key has no row in the DB the feature defaults to enabled (safe
 * fallback for features not yet seeded).
 */
export function requireFeatureEnabled(key: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.tenantCtx?.isSuperadmin && !req.tenantCtx?.impersonatedUserId) return next();
    try {
      if (!(await isFeatureEnabled(key))) {
        return res.status(403).json({ error: 'Feature not available.' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
