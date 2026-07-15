'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useGym } from './GymContext';

export interface CenterOption {
  id: number;
  name: string;
  status: 'active' | 'inactive';
}

interface CenterContextValue {
  centers: CenterOption[];
  activeCenterId: number | null; // null = "All centers"
  setActiveCenterId: (id: number | null) => void;
  loading: boolean;
  refreshCenters: () => Promise<void>;
}

const CenterContext = createContext<CenterContextValue>({
  centers: [],
  activeCenterId: null,
  setActiveCenterId: () => {},
  loading: true,
  refreshCenters: async () => {},
});

export function CenterProvider({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  const { activeGymId } = useGym();

  const [centers, setCenters] = useState<CenterOption[]>([]);
  const [activeCenterId, setActiveCenterIdState] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const loadCenters = useCallback(async () => {
    if (!activeGymId) { setCenters([]); setLoading(false); return; }
    setLoading(true);
    try {
      const token = await getToken();
      const res = await fetch('/api/proxy/centers?status=active', {
        headers: { Authorization: `Bearer ${token}`, 'x-gym-id': activeGymId },
      });
      const data: CenterOption[] = res.ok ? await res.json() : [];
      setCenters(data);
      const stored = typeof window !== 'undefined' ? localStorage.getItem(`activeCenterId:${activeGymId}`) : null;
      const storedId = stored ? Number(stored) : null;
      setActiveCenterIdState(storedId && data.find((c) => c.id === storedId) ? storedId : null);
    } catch {
      setCenters([]);
    } finally {
      setLoading(false);
    }
  }, [activeGymId, getToken]);

  useEffect(() => { loadCenters(); }, [loadCenters]);

  function setActiveCenterId(id: number | null) {
    setActiveCenterIdState(id);
    if (activeGymId) {
      if (id) localStorage.setItem(`activeCenterId:${activeGymId}`, String(id));
      else localStorage.removeItem(`activeCenterId:${activeGymId}`);
    }
  }

  return (
    <CenterContext.Provider value={{ centers, activeCenterId, setActiveCenterId, loading, refreshCenters: loadCenters }}>
      {children}
    </CenterContext.Provider>
  );
}

export function useCenter() {
  return useContext(CenterContext);
}
