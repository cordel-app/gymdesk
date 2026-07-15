'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';

export interface MemberProfile {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  fare_name: string | null;
  fare_price: string | null;
  clerk_user_id: string;
}

export interface MemberCenter {
  id: number;
  name: string;
  is_default: boolean;
}

interface AppContextValue {
  gymId: string | null;
  member: MemberProfile | null;
  isLinked: boolean;
  loading: boolean;
  centers: MemberCenter[];
  activeCenterId: number | null;
  setActiveCenterId: (id: number) => void;
}

const AppContext = createContext<AppContextValue>({
  gymId: null,
  member: null,
  isLinked: false,
  loading: true,
  centers: [],
  activeCenterId: null,
  setActiveCenterId: () => {},
});

export function AppProvider({ children, gymId }: { children: ReactNode; gymId: string | null }) {
  const { getToken, isSignedIn } = useAuth();
  const { user } = useUser();

  const [member, setMember] = useState<MemberProfile | null>(null);
  const [isLinked, setIsLinked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [centers, setCenters] = useState<MemberCenter[]>([]);
  const [activeCenterId, setActiveCenterIdState] = useState<number | null>(null);

  useEffect(() => {
    if (!isSignedIn || !user || !gymId) {
      setLoading(false);
      return;
    }

    async function loadProfile() {
      try {
        const token = await getToken();
        const res = await fetch('/api/proxy/me/profile', {
          headers: {
            Authorization: `Bearer ${token}`,
            'x-gym-id': gymId!,
          },
        });
        if (res.ok) {
          setMember(await res.json());
          setIsLinked(true);

          // #59: only shown/used once the member has more than one center —
          // a single-center gym behaves exactly as before this feature existed.
          const centersRes = await fetch('/api/proxy/me/centers', {
            headers: { Authorization: `Bearer ${token}`, 'x-gym-id': gymId! },
          });
          if (centersRes.ok) {
            const data: MemberCenter[] = await centersRes.json();
            setCenters(data);
            const stored = typeof window !== 'undefined' ? localStorage.getItem(`activeCenterId:${gymId}`) : null;
            const storedId = stored ? Number(stored) : null;
            const fallback = data.find((c) => c.is_default)?.id ?? data[0]?.id ?? null;
            setActiveCenterIdState(storedId && data.find((c) => c.id === storedId) ? storedId : fallback);
          }
        }
        // 403/404 means not linked yet — redirect handled by link/page.tsx
      } finally {
        setLoading(false);
      }
    }

    loadProfile();
  }, [isSignedIn, user, gymId]);

  function setActiveCenterId(id: number) {
    setActiveCenterIdState(id);
    if (gymId) localStorage.setItem(`activeCenterId:${gymId}`, String(id));
  }

  return (
    <AppContext.Provider value={{ gymId, member, isLinked, loading, centers, activeCenterId, setActiveCenterId }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  return useContext(AppContext);
}
