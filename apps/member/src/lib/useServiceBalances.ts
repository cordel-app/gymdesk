'use client';

// #2587 — the member's own Professional Service balances, read once per mount
// for the inline selector. `null` until read and when the read is refused
// (a gym with My Products off): the selector then offers every accepted
// service and the server's own validation decides.
import { useEffect, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import type { ServiceBalance } from '@/lib/serviceSelection';

export function useServiceBalances(enabled = true, refreshKey: unknown = 0): ServiceBalance[] | null {
  const { apiFetch } = useApiClient();
  const [balances, setBalances] = useState<ServiceBalance[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiFetch<{ items: ServiceBalance[] }>('/me/professional-services')
      .then((r) => { if (!cancelled) setBalances(r.items ?? []); })
      .catch(() => { if (!cancelled) setBalances(null); });
    return () => { cancelled = true; };
  }, [enabled, refreshKey]);
  return balances;
}
