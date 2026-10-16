import { useApiClient } from '@/lib/apiClient';

/** #1693 — records a purchase's cancellation day; the paid period is untouched. */
export function usePurchaseCancel(memberId: number, onChanged: () => void) {
  const { apiFetch } = useApiClient();
  return async function cancelPurchase(purchaseId: number): Promise<string | null> {
    try {
      await apiFetch(`/members/${memberId}/product-purchases/${purchaseId}/cancel`, { method: 'POST' });
      onChanged();
      return null;
    } catch (e: any) {
      return e?.message ?? String(e);
    }
  };
}
