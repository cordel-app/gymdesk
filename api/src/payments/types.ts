export type PaymentStatus = 'pending' | 'completed' | 'failed' | 'expired' | 'cancelled';

export interface CreatePaymentRequestParams {
  orderId: string;
  /** Minor units of `currency` (cents for EUR) — see `toMinorUnits()` in ./money.ts. */
  amount: number;
  currency: string;
  description: string;
  memberEmail: string;
  okUrl: string;
  koUrl: string;
  notificationUrl: string;
}

/**
 * #788: a card verification — MONEI's `transactionType: 'VERIF'` with
 * `amount: 0` (docs.monei.com/guides/save-payment-method). It exists to obtain
 * a reusable `paymentToken` for a member whose card changed, so it deliberately
 * carries **no amount**: a caller cannot charge through this path even by
 * mistake, and an adapter cannot be handed a euro figure to convert.
 */
export interface CreateCardVerificationParams {
  orderId: string;
  currency: string;
  description: string;
  memberEmail: string;
  okUrl: string;
  koUrl: string;
  notificationUrl: string;
}

export interface CreatePaymentRequestResult {
  providerOrderId: string;
  checkoutUrl: string;
}

export interface WebhookPayload {
  orderId: string;
  status: PaymentStatus;
  providerRef: string;
  paymentToken: string | null;
  sequenceId: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  /** The signed bytes of a webhook; absent for a payment read back with `getPaymentStatus()` (#2087). */
  rawBody?: Buffer;
  /**
   * The provider's own status, verbatim (#1325). `status` above is the internal
   * four-value mapping and collapses distinct outcomes — an unrecognised or
   * `PENDING_PROCESSING` / `CANCELED` / `REFUNDED` status reads as `failed`
   * there — so anything that must tell them apart reads this one. Optional so a
   * provider adapter that has not been taught it stays valid.
   */
  providerStatus?: string | null;
}

export interface ExecuteRecurringParams {
  orderId: string;
  /** Minor units of `currency` (cents for EUR) — see `toMinorUnits()` in ./money.ts. */
  amount: number;
  currency: string;
  paymentToken: string;
  sequenceId: string;
}

export interface ExecuteRecurringResult {
  success: boolean;
  providerRef: string;
  errorCode: string | null;
  errorMessage: string | null;
  /** The provider's own status, verbatim (#1325); see `WebhookPayload.providerStatus`. */
  providerStatus?: string | null;
}

export interface PaymentMethodToken {
  paymentToken: string;
  sequenceId: string;
  cardLast4: string | null;
  cardBrand: string | null;
}

/** #2480: a refund of a payment the provider already collected. */
export interface RefundPaymentParams {
  /** The provider's own id of the original payment (`payment_requests.provider_ref`). */
  providerRef: string;
  /** Minor units (cents), as every amount crossing this boundary. */
  amount: number;
}

/** What the provider says has been refunded of one payment so far (#2480 follow-up). */
export interface RefundedAmountResult {
  /** The provider's raw status of the original payment (e.g. `REFUNDED`). */
  providerStatus: string | null;
  /**
   * Minor units refunded of that payment in total, across every refund taken
   * on it. `null` when the provider's answer does not say, which is an
   * unknown, never zero.
   */
  refundedAmount: number | null;
}

export interface RefundPaymentResult {
  /** The provider's raw status after the refund (e.g. `REFUNDED`, `PARTIALLY_REFUNDED`). */
  providerStatus: string | null;
  /** The provider's reference for the refund operation. */
  providerRefundRef: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}
