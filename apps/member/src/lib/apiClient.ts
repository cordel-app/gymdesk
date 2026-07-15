import { useAuth } from '@clerk/nextjs';
import { useApp } from '@/context/AppContext';

export function useApiClient() {
  const { getToken } = useAuth();
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
