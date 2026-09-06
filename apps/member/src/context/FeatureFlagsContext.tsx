'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface FeatureFlagsContextValue {
  flags: Record<string, boolean>;
  loading: boolean;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue>({
  flags: {},
  loading: true,
});

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/proxy/feature-flags')
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => setFlags(data ?? {}))
      .catch(() => setFlags({}))
      .finally(() => setLoading(false));
  }, []);

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
