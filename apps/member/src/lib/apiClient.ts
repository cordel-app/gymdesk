import { useCallback, useRef } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useLocale } from 'next-intl';
import { useApp } from '@/context/AppContext';

const IMPERSONATION_KEY = 'impersonation_session';

/**
 * `apiFetch` and `uploadFetch` are **referentially stable**: their identity
 * changes only when the tenant headers they send change (gym, center, locale).
 *
 * Pages hand `apiFetch` to hook dependency lists and to FullCalendar's `events`
 * source. A function recreated on every render made each of those re-run on every
 * render: the Calendar re-requested `/me/schedule` on any re-render (168 requests
 * in two seconds were seen against the API), and the Goals page re-ran its load
 * effect the same way. The token function is read through a ref for the same
 * reason — Clerk does not promise its identity.
 */
export function useApiClient() {
  const { getToken } = useAuth();
  const locale = useLocale();
  const { gymId, activeCenterId } = useApp();

  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const apiFetch = useCallback(async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = await getTokenRef.current();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (gymId) headers['x-gym-id'] = gymId;
    if (activeCenterId) headers['x-center-id'] = String(activeCenterId);
    // Tells the API which language to resolve DB-stored translated content in
    // (#643) — UI labels come from the locale files, data does not.
    if (locale) headers['x-locale'] = locale;

    // Forward impersonation header when a session is active
    try {
      const stored = typeof window !== 'undefined' ? sessionStorage.getItem(IMPERSONATION_KEY) : null;
      if (stored) {
        const session = JSON.parse(stored);
        if (session?.effectiveUserId) headers['x-impersonate-as'] = session.effectiveUserId;
      }
    } catch {}

    const res = await fetch(`/api/proxy${path}`, { ...options, headers });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // `code` and the rest of the body travel with the message (#1189 stage 4):
      // a refusal such as `professional_service_required` names what would
      // unlock the action, and a caller that wants it reads it off the error.
      throw Object.assign(new Error(body.error ?? `Request failed: ${res.status}`), {
        status: res.status,
        code: typeof body.code === 'string' ? body.code : undefined,
        body,
      });
    }

    if (res.status === 204) return undefined as T;
    return res.json();
  }, [gymId, activeCenterId, locale]);

  /**
   * #1375: a raw-bytes upload — the file's own `Content-Type`, the same tenant,
   * locale and impersonation headers as `apiFetch`, and never a JSON content
   * type. The admin's `uploadFetch` one app over; a hand-rolled `fetch` here
   * would reach the API with no gym and answer a bare 401 (#824's lesson).
   */
  const uploadFetch = useCallback(async function uploadFetch<T>(path: string, file: Blob): Promise<T> {
    const token = await getTokenRef.current();
    const headers: Record<string, string> = { 'Content-Type': file.type };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (gymId) headers['x-gym-id'] = gymId;
    if (activeCenterId) headers['x-center-id'] = String(activeCenterId);
    if (locale) headers['x-locale'] = locale;
    try {
      const stored = typeof window !== 'undefined' ? sessionStorage.getItem(IMPERSONATION_KEY) : null;
      if (stored) {
        const session = JSON.parse(stored);
        if (session?.effectiveUserId) headers['x-impersonate-as'] = session.effectiveUserId;
      }
    } catch {}

    const res = await fetch(`/api/proxy${path}`, { method: 'POST', headers, body: file });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(new Error(body.error ?? `Request failed: ${res.status}`), { status: res.status, body });
    }
    if (res.status === 204) return undefined as T;
    return res.json();
  }, [gymId, activeCenterId, locale]);

  return { apiFetch, uploadFetch };
}
