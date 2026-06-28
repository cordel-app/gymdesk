'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useAuth } from '@clerk/nextjs';

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
}

const GymContext = createContext<GymContextValue>({
  gyms: [],
  activeGymId: null,
  activeGym: null,
  setActiveGymId: () => {},
  loading: true,
});

export function GymProvider({ children }: { children: ReactNode }) {
  const { getToken, isSignedIn } = useAuth();
  const [gyms, setGyms] = useState<GymOption[]>([]);
  const [activeGymId, setActiveGymIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isSignedIn) return;

    async function loadGyms() {
      try {
        const token = await getToken();
        const res = await fetch(`/api/proxy/gyms`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('Failed to load gyms');
        const data: GymOption[] = await res.json();
        setGyms(data);

        const stored = typeof window !== 'undefined' ? localStorage.getItem('activeGymId') : null;
        const initial = stored && data.find((g) => g.id === stored) ? stored : data[0]?.id ?? null;
        setActiveGymIdState(initial);
      } finally {
        setLoading(false);
      }
    }

    loadGyms();
  }, [isSignedIn, getToken]);

  function setActiveGymId(id: string) {
    setActiveGymIdState(id);
    localStorage.setItem('activeGymId', id);
  }

  const activeGym = gyms.find((g) => g.id === activeGymId) ?? null;

  return (
    <GymContext.Provider value={{ gyms, activeGymId, activeGym, setActiveGymId, loading }}>
      {children}
    </GymContext.Provider>
  );
}

export function useGym() {
  return useContext(GymContext);
}
