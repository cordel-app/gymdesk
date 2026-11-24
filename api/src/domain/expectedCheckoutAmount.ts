/**
 * #3312 stage 2 — stale-total protection at the Members App checkout.
 *
 * The Members App sends the amount it showed the member (`expected_amount`, euros) with Pay;
 * the server re-prices the cart under its lock and starts no payment when the two differ. The
 * client's number is never charged: it is only compared with the server's own figure, which is
 * what the checkout charges. This module is the one place the field is judged and the two
 * amounts are compared (in cents, so 10.1 and 10.10 are one amount).
 */

export type ExpectedAmountInput =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/** Absent (or `null`) is no expectation; anything else must be a finite, non-negative number. */
export function parseExpectedAmountInput(raw: unknown): ExpectedAmountInput {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    return { ok: false, error: 'expected_amount must be a non-negative number' };
  }
  return { ok: true, value: n };
}

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** The two amounts are the same charge. */
export function sameAmount(a: number, b: number): boolean {
  return toCents(a) === toCents(b);
}

/** True when the member saw an amount and it is not what the server would charge now. */
export function isStaleAmount(expected: number | null, current: number): boolean {
  return expected != null && !sameAmount(expected, current);
}

/** The refusal's body: the code the Members App recognises and the current amount. */
export function amountChangedBody(current: number) {
  return {
    error: 'amount_changed',
    amount: Math.round(current * 100) / 100,
    message: 'The cart changed since it was shown; review the new total and pay again.',
  };
}
