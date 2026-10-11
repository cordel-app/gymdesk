'use client';

import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { useAuth } from '@clerk/nextjs';

interface FeatureFlagsContextValue {
  flags: Record<string, boolean>;
  loading: boolean;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue>({
  flags: {},
  loading: true,
});

// Matches the backend's in-memory cache TTL (api/src/infra/featureFlags.ts)
// so a toggle in Cordel → Feature Flags reaches an already-open admin session
// without a full page reload (#439).
const POLL_INTERVAL_MS = 30_000;

function sameFlags(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  // `getToken` is a dependency only by identity. Held in a ref, a change
  // of its identity cannot relaunch the effect (an immediate fetch plus a new
  // interval each time), which is how one tab can spend the whole API budget.
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setFlags({});
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchFlags(isInitial: boolean) {
      try {
        const token = await getTokenRef.current();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch('/api/proxy/feature-flags', { headers });
        // a refused poll (429, 5xx) keeps the flags already known. Replacing
        // them with `{}` meant "everything enabled", so a rate-limited tab
        // silently switched every disabled feature back on.
        if (!res.ok) {
          if (!cancelled && isInitial) setFlags({});
          return;
        }
        const data = await res.json();
        // Same content keeps the same object: pages list `flags` in the dependency
        // lists of their load effects, so a new object every 30 s reloaded each of
        // them (the My Bookings list went back to "loading" on every poll).
        if (!cancelled) setFlags((prev) => (sameFlags(prev, data ?? {}) ? prev : (data ?? {})));
      } catch {
        if (!cancelled && isInitial) setFlags({});
      } finally {
        if (!cancelled && isInitial) setLoading(false);
      }
    }

    fetchFlags(true);
    const interval = setInterval(() => {
      // A background tab is not looking at a flag; it refreshes on return.
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchFlags(false);
    }, POLL_INTERVAL_MS);
    const onVisible = () => { if (!document.hidden) fetchFlags(false); };
    document.addEventListener('visibilitychange', onVisible);

    return () => { cancelled = true; clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); };
  }, [isLoaded, isSignedIn]);

  return (
    <FeatureFlagsContext.Provider value={{ flags, loading }}>
      {children}
    </FeatureFlagsContext.Provider>
  );
}

export function useFeatureFlags(): FeatureFlagsContextValue {
  return useContext(FeatureFlagsContext);
}
