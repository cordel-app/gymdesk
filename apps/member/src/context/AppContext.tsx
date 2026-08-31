'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';

const IMPERSONATION_KEY = 'impersonation_session';

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
  gymName: string | null;
  member: MemberProfile | null;
  isLinked: boolean;
  loading: boolean;
  centers: MemberCenter[];
  activeCenterId: number | null;
  setActiveCenterId: (id: number) => void;
  theme: MemberGymTheme | null;
  isSuperadmin: boolean;
  unreadNotifications: number;
  refreshUnreadCount: () => void;
}

const AppContext = createContext<AppContextValue>({
  gymId: null,
  gymName: null,
  member: null,
  isLinked: false,
  loading: true,
  centers: [],
  activeCenterId: null,
  setActiveCenterId: () => {},
  theme: null,
  isSuperadmin: false,
  unreadNotifications: 0,
  refreshUnreadCount: () => {},
});

// gymId prop is kept for backward compat but is ignored — the provider
// resolves it via GET /me/gym so the layout doesn't need to know it.
export function AppProvider({ children }: { children: ReactNode; gymId?: string | null }) {
  const { getToken, isSignedIn } = useAuth();
  const { user } = useUser();
  const isSuperadmin = user?.publicMetadata?.platform_role === 'superadmin';

  const [gymId, setGymId] = useState<string | null>(null);
  const [gymName, setGymName] = useState<string | null>(null);
  const [theme, setTheme] = useState<MemberGymTheme | null>(null);
  const [member, setMember] = useState<MemberProfile | null>(null);
  const [isLinked, setIsLinked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [centers, setCenters] = useState<MemberCenter[]>([]);
  const [activeCenterId, setActiveCenterIdState] = useState<number | null>(null);
  const [unreadNotifications, setUnreadNotifications] = useState(0);

  useEffect(() => {
    if (!isSignedIn || !user) {
      setLoading(false);
      return;
    }

    async function loadAll() {
      try {
        const token = await getToken();

        // Read impersonation session so we can pass x-impersonate-as to GET /me/gym.
        let impersonateAs: string | null = null;
        try {
          const stored = typeof window !== 'undefined' ? sessionStorage.getItem(IMPERSONATION_KEY) : null;
          if (stored) {
            const session = JSON.parse(stored);
            impersonateAs = session?.effectiveUserId ?? null;
          }
        } catch {}

        const gymHeaders: Record<string, string> = { Authorization: `Bearer ${token}` };
        if (impersonateAs) gymHeaders['x-impersonate-as'] = impersonateAs;

        // #68: resolve gym + theme without knowing gymId upfront.
        const gymRes = await fetch('/api/proxy/me/gym', {
          headers: gymHeaders,
        });
        if (!gymRes.ok) {
          setLoading(false);
          return;
        }
        const gymData = await gymRes.json();
        const resolvedGymId: string = gymData.id;
        setGymId(resolvedGymId);
        setGymName(gymData.name ?? null);
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

          // Fetch unread notification count
          const notifRes = await fetch('/api/proxy/me/notifications/count', {
            headers: { Authorization: `Bearer ${token}`, 'x-gym-id': resolvedGymId },
          });
          if (notifRes.ok) {
            const { unread } = await notifRes.json();
            setUnreadNotifications(unread ?? 0);
          }
        }
        // 403/404 means not linked yet — redirect handled by link/page.tsx
      } finally {
        setLoading(false);
      }
    }

    loadAll();
  }, [isSignedIn, user?.id]);

  const fetchUnreadCount = useCallback(async () => {
    if (!gymId) return;
    try {
      const token = await getToken();
      const res = await fetch('/api/proxy/me/notifications/count', {
        headers: { Authorization: `Bearer ${token}`, 'x-gym-id': gymId },
      });
      if (res.ok) {
        const { unread } = await res.json();
        setUnreadNotifications(unread ?? 0);
      }
    } catch {}
  }, [gymId, getToken]);

  function setActiveCenterId(id: number) {
    setActiveCenterIdState(id);
    if (gymId) localStorage.setItem(`activeCenterId:${gymId}`, String(id));
  }

  return (
    <AppContext.Provider value={{ gymId, gymName, member, isLinked, loading, centers, activeCenterId, setActiveCenterId, theme, isSuperadmin, unreadNotifications, refreshUnreadCount: fetchUnreadCount }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  return useContext(AppContext);
}
