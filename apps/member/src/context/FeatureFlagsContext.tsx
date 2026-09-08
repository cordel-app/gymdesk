'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
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
// so a toggle in Cordel → Feature Flags reaches an already-open member
// session without a full page reload (#438, #439).
const POLL_INTERVAL_MS = 30_000;

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setFlags({});
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchFlags(isInitial: boolean) {
      if (isInitial) setLoading(true);
      try {
        const token = await getToken();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch('/api/proxy/feature-flags', { headers });
        const data = res.ok ? await res.json() : {};
        if (!cancelled) setFlags(data ?? {});
      } catch {
        if (!cancelled && isInitial) setFlags({});
      } finally {
        if (!cancelled && isInitial) setLoading(false);
      }
    }

    fetchFlags(true);
    const interval = setInterval(() => fetchFlags(false), POLL_INTERVAL_MS);

    return () => { cancelled = true; clearInterval(interval); };
  }, [isLoaded, isSignedIn, getToken]);

  return (
    <FeatureFlagsContext.Provider value={{ flags, loading }}>
      {children}
    </FeatureFlagsContext.Provider>
  );
}

/**
 * Checks a member_web.* flag AND its 'member_web' ancestor, mirroring the
 * ancestor-cascade semantics of requireFeatureEnabled() on the backend.
 * A key with no row in the DB defaults to enabled (safe fallback), matching
 * the backend default.
 */
export function useFeatureFlags(): FeatureFlagsContextValue {
  return useContext(FeatureFlagsContext);
}

export function isFeatureEnabled(flags: Record<string, boolean>, key: string): boolean {
  const parts = key.split('.');
  for (let i = 1; i <= parts.length; i++) {
    const ancestor = parts.slice(0, i).join('.');
    if (ancestor in flags && !flags[ancestor]) return false;
  }
  return true;
}
