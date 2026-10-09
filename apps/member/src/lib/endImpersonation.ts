'use client';

import type { ImpersonationSession } from '@/context/ImpersonationContext';
import type { useApiClient } from './apiClient';

type ApiFetch = ReturnType<typeof useApiClient>['apiFetch'];

/**
 * The audit half of ending an impersonation: tells the API the session is over
 * and for how long it ran. Shared by the banner's *Stop Impersonating* and by
 * Log out, so a superadmin who logs out while impersonating leaves the same
 * audit row as one who stops first. A failure never blocks ending the session.
 */
export async function reportImpersonationStopped(
  apiFetch: ApiFetch,
  session: ImpersonationSession,
): Promise<void> {
  const durationSeconds = Math.round((Date.now() - session.startedAt) / 1000);
  try {
    await apiFetch('/platform/impersonation/stop', {
      method: 'POST',
      body: JSON.stringify({
        impersonated_user_id: session.effectiveUserId,
        impersonated_user_name: session.effectiveName,
        impersonated_role: session.effectiveRole,
        duration_seconds: durationSeconds,
      }),
    });
  } catch {
    // Audit failure must not block stopping the session
  }
}
