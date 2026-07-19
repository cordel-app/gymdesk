'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';

export interface MemberProfile {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  fare_name: string | null;
  clerk_user_id: string;
}

export interface MemberCenter {
  id: number;
  name: string;
  is_default: boolean;
}

export interface MemberGymTheme {
  id: string;
  name: string;
  status: string;
  has_logo: boolean;
  logo_updated_at: string | null;
  tokens: Record<string, any> | null;
}

interface AppContextValue {
  gymId: string | null;
  member: MemberProfile | null;
  isLinked: boolean;
  loading: boolean;
  centers: MemberCenter[];
  activeCenterId: number | null;
  setActiveCenterId: (id: number) => void;
  theme: MemberGymTheme | null;
}

const AppContext = createContext<AppContextValue>({
  gymId: null,
  member: null,
  isLinked: false,
  loading: true,
  centers: [],
  activeCenterId: null,
  setActiveCenterId: () => {},
  theme: null,
});

// gymId prop is kept for backward compat but is ignored — the provider
// resolves it via GET /me/gym so the layout doesn't need to know it.
export function AppProvider({ children }: { children: ReactNode; gymId?: string | null }) {
  const { getToken, isSignedIn } = useAuth();
  const { user } = useUser();

  const [gymId, setGymId] = useState<string | null>(null);
  const [theme, setTheme] = useState<MemberGymTheme | null>(null);
  const [member, setMember] = useState<MemberProfile | null>(null);
  const [isLinked, setIsLinked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [centers, setCenters] = useState<MemberCenter[]>([]);
  const [activeCenterId, setActiveCenterIdState] = useState<number | null>(null);

  useEffect(() => {
    if (!isSignedIn || !user) {
      setLoading(false);
      return;
    }

    async function loadAll() {
      try {
        const token = await getToken();

        // #68: resolve gym + theme without knowing gymId upfront.
        const gymRes = await fetch('/api/proxy/me/gym', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!gymRes.ok) {
          setLoading(false);
          return;
        }
        const gymData = await gymRes.json();
        const resolvedGymId: string = gymData.id;
        setGymId(resolvedGymId);
        setTheme(gymData.theme ?? null);

        const res = await fetch('/api/proxy/me/profile', {
          headers: {
            Authorization: `Bearer ${token}`,
            'x-gym-id': resolvedGymId,
          },
        });
        if (res.ok) {
          setMember(await res.json());
          setIsLinked(true);

          // #59: only shown/used once the member has more than one center —
          // a single-center gym behaves exactly as before this feature existed.
          const centersRes = await fetch('/api/proxy/me/centers', {
            headers: { Authorization: `Bearer ${token}`, 'x-gym-id': resolvedGymId },
          });
          if (centersRes.ok) {
            const data: MemberCenter[] = await centersRes.json();
            setCenters(data);
            const stored = typeof window !== 'undefined' ? localStorage.getItem(`activeCenterId:${resolvedGymId}`) : null;
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

    loadAll();
  }, [isSignedIn, user?.id]);

  function setActiveCenterId(id: number) {
    setActiveCenterIdState(id);
    if (gymId) localStorage.setItem(`activeCenterId:${gymId}`, String(id));
  }

  return (
    <AppContext.Provider value={{ gymId, member, isLinked, loading, centers, activeCenterId, setActiveCenterId, theme }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  return useContext(AppContext);
}
