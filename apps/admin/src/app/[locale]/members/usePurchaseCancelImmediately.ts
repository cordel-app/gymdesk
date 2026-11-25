import { useApiClient } from '@/lib/apiClient';

/**
 * #3358 stage 2 — Cancel Immediately for a recurring Product line whose cancellation is already
 * committed: the API opens or reuses the member's In Cart Draft and ends the Draft's copy of the
 * line today, so the line reads `to_be_canceled_immediately` until Save & Pay. Nothing is billed
 * or refunded here, and the hook decides nothing: which rows offer the action is the API's
 * `can_cancel_immediately`.
 */
export function usePurchaseCancelImmediately(memberId: number, onChanged: () => void) {
  const { apiFetch } = useApiClient();
  return async function cancelImmediately(item: { id: number; source?: string }): Promise<string | null> {
    // A recurring row's `id` is the negative of its line id (#1661).
    if (item.source !== 'recurring') return 'not_cancelling_at_period_end';
    const lineId = Math.abs(item.id);
    try {
      await apiFetch(`/members/${memberId}/product-purchases/recurring/${lineId}/cancel-immediately`, { method: 'POST' });
      onChanged();
      return null;
    } catch (e: any) {
      return e?.message ?? String(e);
    }
  };
}
