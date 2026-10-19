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
