'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/Toast';
import { AppRole } from '@/config/permissions';

export interface GymTheme {
  id: string;
  name: string;
  status: string;
  has_logo: boolean;
  logo_updated_at: string | null;
  tokens: Record<string, any> | null;
}

export interface GymOption {
  id: string;
  name: string;
  slug: string;
  role: AppRole;
  theme: GymTheme | null;
}

interface GymContextValue {
  gyms: GymOption[];
  activeGymId: string | null;
  activeGym: GymOption | null;
  setActiveGymId: (id: string) => void;
  loading: boolean;
  isSuperadmin: boolean;
  refreshGyms: () => Promise<void>;
}

const GymContext = createContext<GymContextValue>({
  gyms: [],
  activeGymId: null,
  activeGym: null,
  setActiveGymId: () => {},
  loading: true,
  isSuperadmin: false,
  refreshGyms: async () => {},
});

export function GymProvider({ children }: { children: ReactNode }) {
  const { getToken, isSignedIn } = useAuth();
  const { user } = useUser();
  const { toast } = useToast();
  const t = useTranslations('common');
  const isSuperadmin = user?.publicMetadata?.platform_role === 'superadmin';

  const [gyms, setGyms] = useState<GymOption[]>([]);
  const [activeGymId, setActiveGymIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const linkAttempted = useRef(false);

  const loadGyms = useCallback(async () => {
    if (!isSignedIn || !user) return;
    try {
      const token = await getToken();
      const endpoint = isSuperadmin ? '/api/proxy/platform/gyms' : '/api/proxy/gyms';
      const fetchGyms = async () => {
        const res = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('Failed to load gyms');
        return res.json();
      };

      let data = await fetchGyms();

      // Freshly-invited team member: their gym_memberships row is still a
      // pending 'invited' placeholder, so they show zero gyms. Materialize it
      // from the Clerk invitation metadata (once), then reload.
      if (!isSuperadmin && Array.isArray(data) && data.length === 0 && !linkAttempted.current) {
        linkAttempted.current = true;
        try {
          await fetch('/api/proxy/gym-users/link', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
          data = await fetchGyms();
        } catch {
          // No pending invitation — leave gyms empty; home page routes to /no-gym.
        }
      }

      // Platform endpoint returns gyms without role — add synthetic 'admin' for superadmin
      const gymsWithRole: GymOption[] = isSuperadmin
        ? data.map((g: Omit<GymOption, 'role'>) => ({ ...g, role: 'admin' as const }))
        : data;

      setGyms(gymsWithRole);

      // Only pick an initial selection on the FIRST load; refreshGyms after an
      // edit shouldn't jump the user to a different gym.
      setActiveGymIdState((prev) => {
        if (prev && gymsWithRole.find((g) => g.id === prev)) return prev;
        const stored = typeof window !== 'undefined' ? localStorage.getItem('activeGymId') : null;
        return (stored && gymsWithRole.find((g) => g.id === stored) ? stored : gymsWithRole[0]?.id) ?? null;
      });
    } catch (err: any) {
      toast(err.message ?? t('error_load_gyms'));
    } finally {
      setLoading(false);
    }
  }, [isSignedIn, user?.id, isSuperadmin, getToken, toast, t]);

  useEffect(() => { loadGyms(); }, [loadGyms]);

  function setActiveGymId(id: string) {
    setActiveGymIdState(id);
    localStorage.setItem('activeGymId', id);
  }

  const rawActiveGym = gyms.find((g) => g.id === activeGymId) ?? null;

  // When a superadmin is impersonating, expose the effective user's role so
  // nav gating and UI permission checks reflect the impersonated user's access.
  const activeGym = rawActiveGym && typeof window !== 'undefined' ? (() => {
    try {
      const stored = sessionStorage.getItem('impersonation_session');
      if (stored) {
        const session = JSON.parse(stored);
        if (session?.gymId === rawActiveGym.id && session?.effectiveRole) {
          return { ...rawActiveGym, role: session.effectiveRole as GymOption['role'] };
        }
      }
    } catch {}
    return rawActiveGym;
  })() : rawActiveGym;

  return (
    <GymContext.Provider value={{ gyms, activeGymId, activeGym, setActiveGymId, loading, isSuperadmin, refreshGyms: loadGyms }}>
      {children}
    </GymContext.Provider>
  );
}

export function useGym() {
  return useContext(GymContext);
}
