'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

const STORAGE_KEY = 'impersonation_session';

export interface ImpersonationSession {
  effectiveUserId: string;
  effectiveName: string;
  effectiveRole: string;
  gymId: string;
  authenticatorName: string;
  startedAt: number; // Unix ms
}

interface ImpersonationContextValue {
  session: ImpersonationSession | null;
  isImpersonating: boolean;
  startImpersonation: (session: ImpersonationSession) => void;
  stopImpersonation: () => void;
}

const ImpersonationContext = createContext<ImpersonationContextValue>({
  session: null,
  isImpersonating: false,
  startImpersonation: () => {},
  stopImpersonation: () => {},
});

export function ImpersonationProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ImpersonationSession | null>(null);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) setSession(JSON.parse(stored));
    } catch {}
  }, []);

  const startImpersonation = useCallback((s: ImpersonationSession) => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    setSession(s);
  }, []);

  const stopImpersonation = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setSession(null);
  }, []);

  return (
    <ImpersonationContext.Provider value={{
      session,
      isImpersonating: session !== null,
      startImpersonation,
      stopImpersonation,
    }}>
      {children}
    </ImpersonationContext.Provider>
  );
}

export function useImpersonation() {
  return useContext(ImpersonationContext);
}
