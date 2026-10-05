'use client';

import { useTranslations } from 'next-intl';
import { useGym } from '@/context/GymContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { AppModule, canAccessFeature, canWriteFeature } from '@/config/permissions';

/**
 * #613: the one place a page asks "may this user read / write this module?".
 *
 * - A superadmin acting as themselves can do everything.
 * - While impersonating, the impersonated user's role decides — `isSuperadmin`
 *   stays true during impersonation, so the old `isSuperadmin || canWriteModule(...)`
 *   pattern showed every edit control to a superadmin impersonating a read-only user.
 * - Read-only roles (R / R_ASSIGNED) get `canRead && !canWrite`: pages render their
 *   data with write controls disabled (`readOnlyTitle` as the tooltip). The API
 *   rejects their writes independently (`requireModuleWrite` / `requireRole`).
 */
/** Tooltip for a write control in a sub-component that only receives `canWrite`. */
export function useReadOnlyTitle(canWrite: boolean): string | undefined {
  const t = useTranslations('common');
  return canWrite ? undefined : t('read_only_hint');
}

/**
 * `featureKey` (#1070): the `feature_flags` key of the screen asking, when that
 * feature declares a permission override. It is optional and changes nothing for
 * a module with no override declared for the key — a page passes the same key it
 * is gated by in `app.ts`, so the control it renders and the route it calls read
 * one answer.
 */
export function useModuleAccess(module: AppModule, featureKey?: string) {
  const t = useTranslations('common');
  const { activeGym, isSuperadmin, loading } = useGym();
  const { isImpersonating } = useImpersonation();
  const actsAsSuperadmin = isSuperadmin && !isImpersonating;
  const role = activeGym?.role;
  const canRead = actsAsSuperadmin || (!!role && canAccessFeature(role, module, featureKey));
  const canWrite = actsAsSuperadmin || (!!role && canWriteFeature(role, module, featureKey));
  return {
    loading,
    canRead,
    canWrite,
    /** Gym admin (or a superadmin acting as themselves) — for admin-only actions inside a module. */
    isAdmin: actsAsSuperadmin || role === 'admin',
    /** Tooltip for a disabled write control; undefined when the user can write. */
    readOnlyTitle: canWrite ? undefined : t('read_only_hint'),
  };
}
