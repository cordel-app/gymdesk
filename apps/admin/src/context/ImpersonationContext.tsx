'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

const STORAGE_KEY = 'impersonation_session';

export interface ImpersonationSession {
  effectiveUserId: string;
  effectiveName: string;
  effectiveRole: string;
  gymId: string;
  gymIds: string[];
  authenticatorName: string;
  startedAt: number; // Unix ms
}

interface ImpersonationContextValue {
  session: ImpersonationSession | null;
  isImpersonating: boolean;
  /**
   * False until the provider has rehydrated from sessionStorage on mount — until
   * then `session: null` means "not read yet", not "not impersonating" (same flag
   * the Member app exposes, #415). Consumers that must not flash the superadmin's
   * own identity on a reload mid-impersonation check this first (#596).
   */
  ready: boolean;
  startImpersonation: (session: ImpersonationSession) => void;
  stopImpersonation: () => void;
}

const ImpersonationContext = createContext<ImpersonationContextValue>({
  session: null,
  isImpersonating: false,
  ready: false,
  startImpersonation: () => {},
  stopImpersonation: () => {},
});

/** Synchronous read of the persisted session; null on the server or when absent/corrupt. */
export function readStoredImpersonationSession(): ImpersonationSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export function ImpersonationProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ImpersonationSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSession(readStoredImpersonationSession());
    setReady(true);
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
      ready,
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
