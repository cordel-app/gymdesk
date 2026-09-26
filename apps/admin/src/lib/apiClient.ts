import { useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useLocale } from 'next-intl';
import { useGym } from '@/context/GymContext';
import { useCenter } from '@/context/CenterContext';
import { useImpersonation } from '@/context/ImpersonationContext';

export function useApiClient() {
  const { getToken } = useAuth();
  const locale = useLocale();
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
      // Tells the API which language to resolve DB-stored translated content in
      // (#643) — UI labels come from the locale files, data does not.
      if (locale) headers['x-locale'] = locale;

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
    [getToken, activeGymId, activeCenterId, impersonationSession, locale],
  ) as <T>(path: string, options?: RequestInit) => Promise<T>;

  /**
   * #787: the same request, for an endpoint that answers a PDF rather than
   * JSON. Receipts are the only such endpoint today, and two screens now offer
   * them (the member's Payments modal and Billing Events), so the headers —
   * bearer token, gym, center, impersonation, locale — live here once instead
   * of being re-assembled per screen.
   */
  const pdfFetch = useCallback(
    async (path: string, method: 'GET' | 'POST' = 'GET'): Promise<Blob> => {
      const token = await getToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (activeGymId) headers['x-gym-id'] = activeGymId;
      if (activeCenterId) headers['x-center-id'] = String(activeCenterId);
      if (impersonationSession) headers['x-impersonate-as'] = impersonationSession.effectiveUserId;
      if (locale) headers['x-locale'] = locale;

      const res = await fetch(`/api/proxy${path}`, { method, headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw Object.assign(new Error(body.error ?? `Request failed: ${res.status}`), { status: res.status, body });
      }
      return res.blob();
    },
    [getToken, activeGymId, activeCenterId, impersonationSession, locale],
  );

  return { apiFetch, pdfFetch };
}
