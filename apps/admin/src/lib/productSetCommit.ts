/**
 * #1325 PR 3b — committing a ProductSet Draft from a screen.
 *
 * The server decides what a commit means: a version that owes nothing is
 * activated; one that owes a payment answers `409 payment_required` to the
 * activation, and is then saved for payment (Pending Payment, with its initial
 * event and a checkout). The screen only follows that answer — it never
 * computes whether something is owed, and never sends a confirmation.
 */

export type ApiFetch = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

export const PAYMENT_REQUIRED = 'payment_required';

/** `null` when the version was activated; the checkout URL when a payment is awaited. */
export async function commitProductSetVersion(apiFetch: ApiFetch, id: number): Promise<string | null> {
  try {
    await apiFetch(`/product-sets/${id}/activate`, { method: 'POST', body: JSON.stringify({}) });
    return null;
  } catch (err: any) {
    if (err?.status === 409 && err?.body?.error === PAYMENT_REQUIRED) {
      const pay = await apiFetch<{ checkout_url: string | null }>(`/product-sets/${id}/save-and-pay`, {
        method: 'POST', body: JSON.stringify({}),
      });
      return pay.checkout_url ?? null;
    }
    throw err;
  }
}
