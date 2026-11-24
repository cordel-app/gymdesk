/**
 * #3273 — which payment attempt of a purchase's Billing Event a person reads as "how and when this
 * checkout was paid", and the status that attempt reports. Pure: the loader
 * (`api/src/api/member-purchases.ts`) hands it the event's own attempts (`payment_requests` with
 * `billing_event_id` = the event and `transaction_type = 'payment'`), and nothing here reads the Member's current payment method.
 *
 * The rules are the issue's §5:
 *   - a successful attempt wins, even after failed ones — its method and its `completed_at` are the
 *     purchase's payment details (the latest one, should there be more than one);
 *   - with no successful attempt, the latest attempt's method and status are shown and there is no
 *     payment date (never a fabricated one);
 *   - the status is the provider's own, normalized (`normalizePaymentStatus()`, #3289/#3352): a
 *     refund changes the Billing Event's `status`, never this one, and an attempt with no provider
 *     status (cash, card terminal, waiver) reads `null`, never the request's internal status.
 */
import { normalizePaymentStatus } from './providerPaymentStatus';

export interface PurchaseAttempt {
  id: number;
  status: string;
  provider_status: string | null;
  method: string | null;
  payment_method_name: string | null;
  payment_method_code: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
}

export interface PurchasePayment {
  /** The attempt the details come from; null when the event has none yet. */
  attempt_id: number | null;
  payment_method_name: string | null;
  payment_method_code: string | null;
  /** `method` of the attempt (`provider`, `cash`, `card_terminal`, `waive`). */
  method: string | null;
  payment_status: string | null;
  /** The successful attempt's `completed_at`; null unless an attempt succeeded. */
  paid_at: string | null;
  attempt_count: number;
}

const ts = (v: Date | string): number => (v instanceof Date ? v.getTime() : new Date(v).getTime());

/** Latest first: by creation instant, then id. */
function latest(attempts: readonly PurchaseAttempt[]): PurchaseAttempt | null {
  let best: PurchaseAttempt | null = null;
  for (const a of attempts) {
    if (!best || ts(a.created_at) > ts(best.created_at)
      || (ts(a.created_at) === ts(best.created_at) && a.id > best.id)) best = a;
  }
  return best;
}

/** The attempt §5 shows: the latest successful one, else the latest one. */
export function relevantAttempt(attempts: readonly PurchaseAttempt[]): PurchaseAttempt | null {
  return latest(attempts.filter((a) => a.status === 'completed')) ?? latest(attempts);
}

/** #3352: the payment's own reading; a refund never moves it (it is the Billing Event's status). */
export function purchasePayment(attempts: readonly PurchaseAttempt[]): PurchasePayment {
  const a = relevantAttempt(attempts);
  if (!a) {
    return {
      attempt_id: null, payment_method_name: null, payment_method_code: null, method: null,
      payment_status: null, paid_at: null, attempt_count: 0,
    };
  }
  const succeeded = a.status === 'completed';
  // #3289: the provider's own status alone; no fallback to the request's internal state.
  const status: string | null = normalizePaymentStatus(a.provider_status);
  const paidAt = succeeded && a.completed_at != null ? new Date(a.completed_at).toISOString() : null;
  return {
    attempt_id: a.id,
    payment_method_name: a.payment_method_name ?? null,
    payment_method_code: a.payment_method_code ?? null,
    method: a.method ?? null,
    payment_status: status,
    paid_at: paidAt,
    attempt_count: attempts.length,
  };
}
