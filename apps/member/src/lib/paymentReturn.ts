// What the hosted payment page's return means, decided in one place.
//
// Monei sends the payer back to the `completeUrl` (our PAYMENT_OK_URL, the
// success page) whatever the outcome, and appends the payment's own status to
// the query (`?status=FAILED&message=…`); only a payer who abandons the page is
// sent to the `cancelUrl`. The success page used to ignore that status and poll
// for a completed request that a failed payment never produces, so a declined
// card or a failed 3D Secure check sat on "Payment processing…" until the
// timeout. This module answers whether the return is a failure, and where the
// payer goes from there. It is pure: no React, no `t()`, no `window`.
//
// The provider's `message` is never shown: it arrives in the URL, so anyone
// could craft a link that puts their own sentence on our page. The error page
// says a localized line of its own instead.

/** Monei statuses that mean no money moved and none will. */
const FAILED_RETURN_STATUSES = new Set(['FAILED', 'CANCELED', 'CANCELLED', 'EXPIRED']);

/** True when the provider's return says the payment did not go through. A
 * missing, pending or successful status keeps the success page's poll, since
 * the webhook — never the redirect — is what settles a payment. */
export function isFailedPaymentReturn(status: string | null | undefined): boolean {
  if (!status) return false;
  return FAILED_RETURN_STATUSES.has(status.trim().toUpperCase());
}

/** The query flag the membership page reads to reopen the payment dialog. */
export const RETRY_PAYMENT_PARAM = 'pay';

/** Where a failed return lands: the error page, keeping the purpose so a card
 * replacement and a payment read their own wording. */
export function paymentErrorPath(locale: string, purpose: string | null | undefined): string {
  const query = new URLSearchParams({ reason: 'failed' });
  if (purpose) query.set('purpose', purpose);
  return `/${locale}/payment/error?${query.toString()}`;
}

/** Where "Try again" goes: back to My Products with the payment dialog open,
 * so the payer enters a card again on a new checkout (a link is single use). */
export function paymentRetryPath(locale: string): string {
  return `/${locale}/membership?${RETRY_PAYMENT_PARAM}=1`;
}

/** True when the membership page was opened to retry a payment. */
export function wantsPaymentRetry(search: string): boolean {
  return new URLSearchParams(search).get(RETRY_PAYMENT_PARAM) === '1';
}

/** The locale key of the error page's explanation. */
export function paymentErrorMessageKey(reason: string | null, purpose: string | null): string {
  if (reason !== 'failed') return 'payment_error.not_completed';
  return purpose === 'card_update' ? 'payment_error.card_failed' : 'payment_error.failed';
}

/**
 * #2087: the provider's payment id on a return URL (Monei appends it to
 * `completeUrl`; both spellings are read). It is only ever used to ask the API
 * to confirm with the provider — the page never settles anything from it.
 */
export function paymentIdFromReturn(params: { get(name: string): string | null }): string | null {
  const id = params.get('payment_id') ?? params.get('id');
  return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}
