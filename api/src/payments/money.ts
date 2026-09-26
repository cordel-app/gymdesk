/**
 * Amounts cross the PaymentProvider boundary in the currency's **minor unit**
 * (cents for EUR), because that is what Monei's `/payments` takes. Everything
 * on our side of the boundary — `user_memberships.membership_fee_price`,
 * `billing_events.amount`, `payment_requests.amount`, what
 * `resolveMembershipFee()` and `priceMembershipFeeOn()` return — is a decimal
 * number of euros. Every caller of `createPaymentRequest()` and
 * `executeRecurring()` converts through this helper, so a customer-initiated
 * 45.99 € and the merchant-initiated renewal of that same fee send the same
 * `4599` to the provider. The nightly run and the staff Retry used to pass
 * `45.99` as-is, which Monei reads as forty-five cents.
 */
export function toMinorUnits(amount: number | string): number {
  const value = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (!Number.isFinite(value)) {
    throw new Error(`toMinorUnits: amount is not a finite number (${String(amount)})`);
  }
  // Round to whole cents; the +Number.EPSILON guard keeps 1.005 → 101 instead
  // of the 100 that binary floating point would otherwise produce.
  return Math.round((value + Number.EPSILON) * 100);
}
