'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/Toast';

export interface GymOption {
  id: string;
  name: string;
  slug: string;
  role: 'admin' | 'coach' | 'staff';
}

interface GymContextValue {
  gyms: GymOption[];
  activeGymId: string | null;
  activeGym: GymOption | null;
  setActiveGymId: (id: string) => void;
  loading: boolean;
  isSuperadmin: boolean;
}

const GymContext = createContext<GymContextValue>({
  gyms: [],
  activeGymId: null,
  activeGym: null,
  setActiveGymId: () => {},
  loading: true,
  isSuperadmin: false,
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

  useEffect(() => {
    if (!isSignedIn || !user) return;

    async function loadGyms() {
      try {
        const token = await getToken();
        const endpoint = isSuperadmin ? '/api/proxy/platform/gyms' : '/api/proxy/gyms';
        const res = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('Failed to load gyms');
        const data = await res.json();

        // Platform endpoint returns gyms without role — add synthetic 'admin' for superadmin
        const gymsWithRole: GymOption[] = isSuperadmin
          ? data.map((g: Omit<GymOption, 'role'>) => ({ ...g, role: 'admin' as const }))
          : data;

        setGyms(gymsWithRole);

        const stored = typeof window !== 'undefined' ? localStorage.getItem('activeGymId') : null;
        const initial = stored && gymsWithRole.find((g) => g.id === stored) ? stored : gymsWithRole[0]?.id ?? null;
        setActiveGymIdState(initial);
      } catch (err: any) {
        toast(err.message ?? t('error_load_gyms'));
      } finally {
        setLoading(false);
      }
    }

    loadGyms();
  }, [isSignedIn, user?.id, isSuperadmin]);

  function setActiveGymId(id: string) {
    setActiveGymIdState(id);
    localStorage.setItem('activeGymId', id);
  }

  const activeGym = gyms.find((g) => g.id === activeGymId) ?? null;

  return (
    <GymContext.Provider value={{ gyms, activeGymId, activeGym, setActiveGymId, loading, isSuperadmin }}>
      {children}
    </GymContext.Provider>
  );
}

export function useGym() {
  return useContext(GymContext);
}
