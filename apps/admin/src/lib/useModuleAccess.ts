'use client';

import { useTranslations } from 'next-intl';
import { useGym } from '@/context/GymContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { AppModule, canAccessModule, canWriteModule } from '@/config/permissions';

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
export function useModuleAccess(module: AppModule) {
  const t = useTranslations('common');
  const { activeGym, isSuperadmin, loading } = useGym();
  const { isImpersonating } = useImpersonation();
  const actsAsSuperadmin = isSuperadmin && !isImpersonating;
  const role = activeGym?.role;
  const canRead = actsAsSuperadmin || (!!role && canAccessModule(role, module));
  const canWrite = actsAsSuperadmin || (!!role && canWriteModule(role, module));
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
