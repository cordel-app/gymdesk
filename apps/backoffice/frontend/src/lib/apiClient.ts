import { useAuth } from '@clerk/nextjs';
import { useGym } from '@/context/GymContext';

export function useApiClient() {
  const { getToken } = useAuth();
  const { activeGymId } = useGym();

  async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = await getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (activeGymId) headers['x-gym-id'] = activeGymId;

    const res = await fetch(`/api/proxy${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Request failed: ${res.status}`);
    }

    if (res.status === 204) return undefined as T;
    return res.json();
  }

  return { apiFetch };
}
