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

interface AppContextValue {
  gymId: string | null;
  member: MemberProfile | null;
  isLinked: boolean;
  loading: boolean;
}

const AppContext = createContext<AppContextValue>({
  gymId: null,
  member: null,
  isLinked: false,
  loading: true,
});

export function AppProvider({ children, gymId }: { children: ReactNode; gymId: string | null }) {
  const { getToken, isSignedIn } = useAuth();
  const { user } = useUser();

  const [member, setMember] = useState<MemberProfile | null>(null);
  const [isLinked, setIsLinked] = useState(false);
  const [loading, setLoading] = useState(true);

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
        }
        // 403/404 means not linked yet — redirect handled by link/page.tsx
      } finally {
        setLoading(false);
      }
    }

    loadProfile();
  }, [isSignedIn, user, gymId]);

  return (
    <AppContext.Provider value={{ gymId, member, isLinked, loading }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  return useContext(AppContext);
}
