import { useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useLocale } from 'next-intl';
import { useGym } from '@/context/GymContext';
import { useCenter } from '@/context/CenterContext';
import { useImpersonation } from '@/context/ImpersonationContext';

/**
 * The sentence to show for a failed `apiFetch`.
 *
 * `apiFetch` puts `body.error` in `err.message`, which is the whole answer for
 * a route that replies with a sentence there. A route that replies with a
 * machine *code* instead — `active_plan_exists` (#956), `unused_value_impacted`
 * (#511) — carries its sentence in `body.message`, and showing the code would
 * put `active_plan_exists` in front of a gym owner. Prefer the sentence when
 * there is one; `undefined` means the caller's own generic fallback.
 */
export function apiErrorMessage(err: any): string | undefined {
  const message = err?.body?.message;
  if (typeof message === 'string' && message.trim() !== '') return message;
  return typeof err?.message === 'string' ? err.message : undefined;
}

/**
 * #1052: options for `apiFetch`, plus the one way a screen addresses a gym
 * other than the selected one.
 *
 * `gymId` names the gym a *tenant-scoped* route should run against, overriding
 * the selected gym for that one request. It exists for a **Cordel** screen that
 * administers a named gym — Cordel → Gyms → [Gym] → Website Integration — where
 * the row, not the gym selector, says whose configuration is on screen. The
 * permission is still the server's: `tenantContext` grants a superadmin admin
 * access to any gym it is handed, and refuses anyone else without a
 * `gym_memberships` row for it, so passing an id here can never widen what the
 * caller may do.
 *
 * Pass it rather than spelling `x-gym-id` in a page: the header is assembled
 * here once (#824's reason), and a page that set it by hand would be overwritten
 * by the selected gym a line later.
 */
export interface ApiFetchOptions extends RequestInit {
  gymId?: string;
}

export function useApiClient() {
  const { getToken } = useAuth();
  const locale = useLocale();
  const { activeGymId } = useGym();
  const { activeCenterId } = useCenter();
  const { session: impersonationSession } = useImpersonation();

  // Memoized so callers can safely include apiFetch in useCallback/useEffect deps
  // without triggering re-runs on every render.
  const apiFetch = useCallback(
    async (path: string, options: ApiFetchOptions = {}): Promise<unknown> => {
      const token = await getToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string>),
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      // #1052: the request's own gym wins over the selected one, so a Cordel
      // screen can read and write a named gym's tenant-scoped configuration.
      const gymId = options.gymId ?? activeGymId;
      if (gymId) headers['x-gym-id'] = gymId;
      if (activeCenterId) headers['x-center-id'] = String(activeCenterId);
      if (impersonationSession) headers['x-impersonate-as'] = impersonationSession.effectiveUserId;
      // Tells the API which language to resolve DB-stored translated content in
      // (#643) — UI labels come from the locale files, data does not.
      if (locale) headers['x-locale'] = locale;

      const { gymId: _gymId, ...init } = options;
      const res = await fetch(`/api/proxy${path}`, {
        ...init,
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
  ) as <T>(path: string, options?: ApiFetchOptions) => Promise<T>;

  /**
   * #824: the same request, for an endpoint that takes raw image bytes rather
   * than JSON.
   *
   * It exists because the theme logo and Members background uploads used to
   * call `fetch('/api/proxy/…')` by hand with only the bearer token, and the
   * proxy forwards `x-gym-id` but cannot invent it: every tenant-scoped upload
   * therefore reached `tenantContext` with no gym and came back as a bare
   * `401 Unauthorized`, with nothing in it to say why. Assembling the headers
   * in one place is what stops the next binary upload from repeating it.
   *
   * The `Content-Type` is the file's own — it is what the API validates the
   * bytes against and what the object is stored with — and the error carries
   * the parsed body, so a caller can render the `stage`, `path` and `details`
   * the storage routes return.
   */
  const uploadFetch = useCallback(
    async (path: string, file: Blob): Promise<unknown> => {
      const token = await getToken();
      const headers: Record<string, string> = { 'Content-Type': file.type };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (activeGymId) headers['x-gym-id'] = activeGymId;
      if (activeCenterId) headers['x-center-id'] = String(activeCenterId);
      if (impersonationSession) headers['x-impersonate-as'] = impersonationSession.effectiveUserId;
      if (locale) headers['x-locale'] = locale;

      const res = await fetch(`/api/proxy${path}`, { method: 'POST', headers, body: file });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw Object.assign(new Error(body.error ?? `Request failed: ${res.status}`), { status: res.status, body });
      }
      if (res.status === 204) return undefined;
      return res.json().catch(() => undefined);
    },
    [getToken, activeGymId, activeCenterId, impersonationSession, locale],
  );

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

  return { apiFetch, pdfFetch, uploadFetch };
}
