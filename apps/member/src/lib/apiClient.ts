import { useAuth } from '@clerk/nextjs';
import { useLocale } from 'next-intl';
import { useApp } from '@/context/AppContext';

const IMPERSONATION_KEY = 'impersonation_session';

export function useApiClient() {
  const { getToken } = useAuth();
  const locale = useLocale();
  const { gymId, activeCenterId } = useApp();

  async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = await getToken();
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
      throw new Error(body.error ?? `Request failed: ${res.status}`);
    }

    if (res.status === 204) return undefined as T;
    return res.json();
  }

  return { apiFetch };
}
