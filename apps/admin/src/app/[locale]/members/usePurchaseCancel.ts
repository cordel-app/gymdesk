import { useEffect, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';

/** #1693 — records a purchase's cancellation day; the paid period is untouched. */
export function usePurchaseCancel(memberId: number, onChanged: () => void) {
  const { apiFetch } = useApiClient();
  return async function cancelPurchase(purchaseId: number, recurringProductId?: number): Promise<string | null> {
    try {
      // #1806 — a recurring line is ended by removing it from the member's Draft
      // ProductSet; Save & Pay (the existing review) commits it, so nothing is
      // billed or refunded here.
      if (recurringProductId != null) {
        const draft = await apiFetch<{ id: number }>('/product-sets/draft', {
          method: 'POST', body: JSON.stringify({ member_id: memberId }),
        });
        const detail = await apiFetch<{ configuration?: { services?: Array<{ id: number; productId: number; endsOn: string | null }> } }>(
          `/product-sets/${draft.id}`,
        );
        const line = (detail.configuration?.services ?? []).find((x) => x.productId === recurringProductId && x.endsOn == null);
        if (!line) return 'recurring_not_removable';
        await apiFetch(`/product-sets/${draft.id}/services/${line.id}`, { method: 'DELETE' });
        onChanged();
        return null;
      }
      await apiFetch(`/members/${memberId}/product-purchases/${purchaseId}/cancel`, { method: 'POST' });
      onChanged();
      return null;
    } catch (e: any) {
      return e?.message ?? String(e);
    }
  };
}

/**
 * #3508 — the end date the server would save if this recurring Product were cancelled now
 * (`GET …/recurring/:lineId/cancellation-preview`), fetched when the confirmation opens, as the
 * plan's Cancel does (#2481). `null` while loading, for a one-time Product, or when it cannot be read.
 */
export function useRecurringCancelEndsOn(memberId: number, item: { id: number; source?: string } | null): string | null {
  const { apiFetch } = useApiClient();
  const [endsOn, setEndsOn] = useState<string | null>(null);
  useEffect(() => {
    setEndsOn(null);
    if (!item || item.source !== 'recurring') return;
    let live = true;
    // A recurring row's `id` is the negative of its line id (#1661).
    apiFetch<{ ends_on: string | null }>(`/members/${memberId}/product-purchases/recurring/${Math.abs(item.id)}/cancellation-preview`)
      .then((r) => { if (live) setEndsOn(r.ends_on); }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId, item?.id, item?.source]);
  return endsOn;
}
