/**
 * #1459: how a payment attempt (`payment_requests` row) was made. One
 * declaration for the four values `chk_payment_requests_method` accepts
 * (migration 271), so a new method goes in **two** places: here and the CHECK.
 *
 * - `provider`      the online payment provider was called (checkout, retry, nightly run)
 * - `cash`          front-desk cash, recorded by staff
 * - `card_terminal` an external physical card terminal; recorded by staff after
 *                   the terminal approved it, never verified by Gymdesk
 * - `waive`         the obligation was waived; no money moved
 */
export const ATTEMPT_METHODS = ['provider', 'cash', 'card_terminal', 'waive'] as const;
export type AttemptMethod = (typeof ATTEMPT_METHODS)[number];

/** The two methods a staff member records by hand as money received. */
export const MANUAL_PAYMENT_METHODS = ['cash', 'card_terminal'] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

/** `undefined`/absent defaults to cash (the pre-#1459 body); anything else unknown is `null`. */
export function parseManualPaymentMethod(raw: unknown): ManualPaymentMethod | null {
  if (raw === undefined || raw === null || raw === '') return 'cash';
  return (MANUAL_PAYMENT_METHODS as readonly string[]).includes(String(raw)) ? (raw as ManualPaymentMethod) : null;
}
