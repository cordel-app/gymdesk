/**
 * #2451: which catalogue payment method (`base_payment_methods.code`) a payment
 * attempt (`payment_requests.method` + `source`) was made with. Pure; the SQL
 * half is `api/src/api/payment-attempt.ts`.
 *
 * - cash          -> `cash`
 * - card_terminal -> `card` (an external card terminal)
 * - provider      -> `members_app` when the member raised it (source `customer`
 *                    / `product_purchase`), otherwise `monei`
 * - waive         -> none: no money moved, so there is no method to snapshot
 * Stored card details are never consulted.
 */
export type PaymentMethodCode =
  | 'members_app' | 'cash' | 'google_pay' | 'apple_pay' | 'card' | 'paypal' | 'bizum' | 'monei';

export function paymentMethodCodeFor(method: string | null | undefined, source: string | null | undefined): PaymentMethodCode | null {
  switch (method) {
    case 'cash': return 'cash';
    case 'card_terminal': return 'card';
    case 'provider': return source === 'customer' || source === 'product_purchase' ? 'members_app' : 'monei';
    default: return null;
  }
}
