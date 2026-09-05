'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';
import { useImpersonation } from '@/context/ImpersonationContext';

const ACTIVE_GYM_KEY = 'activeGymId';

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

export interface GymOption {
  id: string;
  name: string;
  theme: MemberGymTheme | null;
}

interface AppContextValue {
  gymId: string | null;
  gymName: string | null;
  gyms: GymOption[];
  switchGym: (id: string) => Promise<void>;
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
  gyms: [],
  switchGym: async () => {},
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

export function AppProvider({ children }: { children: ReactNode; gymId?: string | null }) {
  const { getToken, isSignedIn } = useAuth();
  const { user } = useUser();
  const { session: impersonationSession } = useImpersonation();
  const impersonateAs = impersonationSession?.effectiveUserId ?? null;
  const isSuperadmin = user?.publicMetadata?.platform_role === 'superadmin';

  const [gyms, setGyms] = useState<GymOption[]>([]);
  const [gymId, setGymId] = useState<string | null>(null);
  const [gymName, setGymName] = useState<string | null>(null);
  const [theme, setTheme] = useState<MemberGymTheme | null>(null);
  const [member, setMember] = useState<MemberProfile | null>(null);
  const [isLinked, setIsLinked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [centers, setCenters] = useState<MemberCenter[]>([]);
  const [activeCenterId, setActiveCenterIdState] = useState<number | null>(null);
  const [unreadNotifications, setUnreadNotifications] = useState(0);

  // Effective identity headers: carries the impersonated member/staff id (if any) to every /me/* call.
  const buildHeaders = useCallback((token: string, resolvedGymId: string) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'x-gym-id': resolvedGymId };
    if (impersonateAs) headers['x-impersonate-as'] = impersonateAs;
    return headers;
  }, [impersonateAs]);

  const loadCenters = useCallback(async (token: string, resolvedGymId: string) => {
    const centersRes = await fetch('/api/proxy/me/centers', {
      headers: buildHeaders(token, resolvedGymId),
    });
    if (!centersRes.ok) return;
    const data: MemberCenter[] = await centersRes.json();
    setCenters(data);
    const stored = typeof window !== 'undefined' ? localStorage.getItem(`activeCenterId:${resolvedGymId}`) : null;
    const storedId = stored ? Number(stored) : null;
    const fallback = data.find((c) => c.is_default)?.id ?? data[0]?.id ?? null;
    setActiveCenterIdState(storedId && data.find((c) => c.id === storedId) ? storedId : fallback);
  }, [buildHeaders]);

  const loadMemberData = useCallback(async (token: string, resolvedGymId: string) => {
    const res = await fetch('/api/proxy/me/profile', {
      headers: buildHeaders(token, resolvedGymId),
    });
    if (!res.ok) return false;
    setMember(await res.json());
    setIsLinked(true);

    await loadCenters(token, resolvedGymId);

    const notifRes = await fetch('/api/proxy/me/notifications/count', {
      headers: buildHeaders(token, resolvedGymId),
    });
    if (notifRes.ok) {
      const { unread } = await notifRes.json();
      setUnreadNotifications(unread ?? 0);
    }
    return true;
  }, [loadCenters, buildHeaders]);

  useEffect(() => {
    if (!isSignedIn || !user) {
      setLoading(false);
      return;
    }

    // Recompute the effective member context whenever impersonation starts, stops, or switches
    // target — otherwise Home stays permanently stuck on the previous identity's Loading state.
    let cancelled = false;
    setLoading(true);
    setIsLinked(false);

    async function loadAll() {
      try {
        const token = await getToken();
        if (!token) {
          setLoading(false);
          return;
        }

        const authHeaders: Record<string, string> = { Authorization: `Bearer ${token}` };
        if (impersonateAs) authHeaders['x-impersonate-as'] = impersonateAs;

        // #341: load all accessible gyms, sorted alphabetically
        const gymsRes = await fetch('/api/proxy/me/gyms', { headers: authHeaders });
        if (cancelled) return;
        if (!gymsRes.ok) {
          setLoading(false);
          return;
        }
        const gymList: GymOption[] = await gymsRes.json();
        if (cancelled) return;
        setGyms(gymList);

        if (gymList.length === 0) {
          setLoading(false);
          return;
        }

        // Pick the active gym: last saved choice (if still valid) or alphabetically first
        const savedId = typeof window !== 'undefined' ? localStorage.getItem(ACTIVE_GYM_KEY) : null;
        const defaultGym = gymList.find((g) => g.id === savedId) ?? gymList[0];

        setGymId(defaultGym.id);
        setGymName(defaultGym.name);
        setTheme(defaultGym.theme ?? null);

        await loadMemberData(token, defaultGym.id);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadAll();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, user?.id, impersonateAs]);

  const switchGym = useCallback(async (id: string) => {
    const gym = gyms.find((g) => g.id === id);
    if (!gym) return;

    setGymId(gym.id);
    setGymName(gym.name);
    setTheme(gym.theme ?? null);
    setCenters([]);
    setActiveCenterIdState(null);
    setMember(null);
    setIsLinked(false);

    if (typeof window !== 'undefined') localStorage.setItem(ACTIVE_GYM_KEY, id);

    const token = await getToken();
    if (token) await loadMemberData(token, id);
  }, [gyms, getToken, loadMemberData]);

  const fetchUnreadCount = useCallback(async () => {
    if (!gymId) return;
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch('/api/proxy/me/notifications/count', {
        headers: buildHeaders(token, gymId),
      });
      if (res.ok) {
        const { unread } = await res.json();
        setUnreadNotifications(unread ?? 0);
      }
    } catch {}
  }, [gymId, getToken, buildHeaders]);

  function setActiveCenterId(id: number) {
    setActiveCenterIdState(id);
    if (gymId) localStorage.setItem(`activeCenterId:${gymId}`, String(id));
  }

  return (
    <AppContext.Provider value={{ gymId, gymName, gyms, switchGym, member, isLinked, loading, centers, activeCenterId, setActiveCenterId, theme, isSuperadmin, unreadNotifications, refreshUnreadCount: fetchUnreadCount }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  return useContext(AppContext);
}
