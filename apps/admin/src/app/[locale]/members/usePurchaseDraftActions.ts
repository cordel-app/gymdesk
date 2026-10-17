'use client';

// #1657 stage 2 — the two writes a saved one-time purchase draft allows: **Pay**
// (the server promotes it to the pending purchase and answers the payment link)
// and **Cancel** (a hard delete of that draft only). Everything is the server's
// to decide; this hook only calls the two routes and reports a failure.

import { useState } from 'react';
import { useApiClient } from '@/lib/apiClient';

export function usePurchaseDraftActions(memberId: number, onChanged: () => void, fallbackError: string) {
  const { apiFetch } = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = (id: number) => `/members/${memberId}/product-purchases/${id}`;

  async function run(fn: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      return true;
    } catch (err: any) {
      setError(err?.body?.message ?? fallbackError);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    error,
    pay: (id: number) => run(async () => {
      const res = await apiFetch<{ checkoutUrl?: string }>(`${path(id)}/pay`, { method: 'POST', body: '{}' });
      if (res.checkoutUrl) window.open(res.checkoutUrl, '_blank', 'noopener');
    }),
    discard: (id: number) => run(async () => {
      await apiFetch(path(id), { method: 'DELETE' });
    }),
  };
}
