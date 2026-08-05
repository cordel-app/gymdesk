import { useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useGym } from '@/context/GymContext';
import { useCenter } from '@/context/CenterContext';
import { useImpersonation } from '@/context/ImpersonationContext';

export function useApiClient() {
  const { getToken } = useAuth();
  const { activeGymId } = useGym();
  const { activeCenterId } = useCenter();
  const { session: impersonationSession } = useImpersonation();

  // Memoized so callers can safely include apiFetch in useCallback/useEffect deps
  // without triggering re-runs on every render.
  const apiFetch = useCallback(
    async (path: string, options: RequestInit = {}): Promise<unknown> => {
      const token = await getToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string>),
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (activeGymId) headers['x-gym-id'] = activeGymId;
      if (activeCenterId) headers['x-center-id'] = String(activeCenterId);
      if (impersonationSession) headers['x-impersonate-as'] = impersonationSession.effectiveUserId;

      const res = await fetch(`/api/proxy${path}`, {
        ...options,
        headers,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // status + body let callers branch on specific responses (e.g. 409 conflicts)
        throw Object.assign(new Error(body.error ?? `Request failed: ${res.status}`), { status: res.status, body });
      }

      if (res.status === 204) return undefined;
      return res.json();
    },
    [getToken, activeGymId, activeCenterId, impersonationSession],
  ) as <T>(path: string, options?: RequestInit) => Promise<T>;

  return { apiFetch };
}
