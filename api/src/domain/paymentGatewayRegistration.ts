/**
 * #3512 — whether a member must be told, after signing in to the Members App,
 * to register with the platform's official payment gateway (MONEI).
 *
 * Pure: the I/O half is `api/src/api/me-payment-gateway.ts`. This module is
 * the one place the rule is decided, so the app only draws what it is told.
 *
 * The warning is owed when both hold:
 *   1. the member's Default Payment Method is **Automated**, and
 *   2. no MONEI token is stored for the member who pays.
 *
 * **The Default Payment Method is not stored yet.** #3497 adds it, and states
 * its default as Automated for every member with no explicit preference. Until
 * that column exists every member reads as Automated (`resolveDefaultPaymentMethod(null)`),
 * and #3497 only has to pass its stored value here — the rule does not move.
 *
 * **Only the member who pays is warned.** A Family's charges are taken from the
 * Family Owner's stored card (#2123 stage 2), so a member who is not the payer
 * has nothing to register; telling them to would point at a card nobody charges.
 * That is the existing `mayViewPayments()` answer (#2776), asked by the caller.
 */

export const AUTOMATED_PAYMENT_METHOD = 'automated';

/** The member's effective Default Payment Method: the stored one, else Automated (#3497's default). */
export function resolveDefaultPaymentMethod(stored: string | null | undefined): string {
  return typeof stored === 'string' && stored.trim() ? stored.trim() : AUTOMATED_PAYMENT_METHOD;
}

export interface GatewayRegistrationInput {
  /** The effective Default Payment Method (`resolveDefaultPaymentMethod()`). */
  defaultPaymentMethod: string;
  /** Whether a MONEI token is stored for this member (`payment_methods`, provider `monei`). */
  hasMoneiToken: boolean;
  /** Whether this member pays for themselves (the Family Owner, or a member with no family). */
  paysForSelf: boolean;
}

export function gatewayRegistrationRequired(input: GatewayRegistrationInput): boolean {
  return input.paysForSelf
    && input.defaultPaymentMethod === AUTOMATED_PAYMENT_METHOD
    && !input.hasMoneiToken;
}
