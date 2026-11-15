'use client';

// #2856 — `⋮ → Delete` on a line of the member's open Draft Product Set: the one
// write it makes. The server removes the line from that Draft (a line the Draft
// added is hard-deleted with its snapshot; a line the Active version also links
// is only unlinked from the Draft) and never touches a committed version. This
// hook only calls the route and reports a failure.

import { useState } from 'react';
import { useApiClient } from '@/lib/apiClient';

export function useDraftLineDelete(memberId: number, onChanged: () => void, messages: { expired: string; failed: string }) {
  const { apiFetch } = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(lineId: number): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/members/${memberId}/product-purchases/recurring/${lineId}`, { method: 'DELETE' });
      return true;
    } catch (err: any) {
      setError(err?.body?.error === 'draft_expired' ? messages.expired : messages.failed);
      return false;
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return { busy, error, clearError: () => setError(null), remove };
}
