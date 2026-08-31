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

export function useFeatureFlags(): FeatureFlagsContextValue {
  return useContext(FeatureFlagsContext);
}
