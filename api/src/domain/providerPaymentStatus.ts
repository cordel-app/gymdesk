/**
 * #1325 PR 2a — the provider's own payment status, kept verbatim.
 *
 * The internal four-value `payment_requests.status` (`pending`/`completed`/
 * `failed`/`expired`) collapses distinct provider outcomes: a transaction that
 * is `PENDING_PROCESSING` or `AUTHORIZED` is not a failure and not a success,
 * and a `REFUNDED` one is money received and then returned. The decisions on the
 * ticket ask that the original status be stored and handled explicitly, so the
 * new `payment_requests.provider_status` column carries it with **no CHECK** (an
 * unknown value must be storable) and this module is the one place that says
 * what each value means. A value this module does not know is `unknown`: it is
 * preserved, treated as unresolved, and never defaulted to FAILED.
 *
 * Pure: no database, no provider SDK.
 */

export const KNOWN_PROVIDER_STATUSES = [
  'SUCCEEDED', 'PAID_OUT', 'AUTHORIZED', 'PENDING', 'PENDING_PROCESSING',
  'FAILED', 'EXPIRED', 'CANCELED', 'REFUNDED', 'PARTIALLY_REFUNDED',
] as const;
export type KnownProviderStatus = (typeof KNOWN_PROVIDER_STATUSES)[number];

/** The pre-#1325 internal spelling of "still pending", if any was stored. */
const LEGACY_PENDING = new Set(['PROCESSING']);

/** Upper-cased and trimmed; `null` for an absent value, never an invented one. */
export function normaliseProviderStatus(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toUpperCase();
  return value === '' ? null : value;
}

export function isKnownProviderStatus(value: string | null): value is KnownProviderStatus {
  return value !== null && (KNOWN_PROVIDER_STATUSES as readonly string[]).includes(value);
}

export type ProviderStatusClass =
  | 'settled'      // money received and kept (or paid out)
  | 'returned'     // money received, then refunded in whole or part
  | 'in_flight'    // may still settle: pending / authorized / processing
  | 'unsuccessful' // definitively not paid: failed / expired / canceled
  | 'unknown';     // absent (an attempt whose outcome is unknown) or unrecognised

export function classifyProviderStatus(raw: string | null): ProviderStatusClass {
  const value = normaliseProviderStatus(raw);
  if (value === null) return 'unknown';
  switch (value) {
    case 'SUCCEEDED':
    case 'PAID_OUT':
      return 'settled';
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
      return 'returned';
    case 'PENDING':
    case 'PENDING_PROCESSING':
    case 'AUTHORIZED':
      return 'in_flight';
    case 'FAILED':
    case 'EXPIRED':
    case 'CANCELED':
      return 'unsuccessful';
    default:
      return LEGACY_PENDING.has(value) ? 'in_flight' : 'unknown';
  }
}
