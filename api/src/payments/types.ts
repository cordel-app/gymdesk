export type PaymentStatus = 'pending' | 'completed' | 'failed' | 'expired';

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
  rawBody: Buffer;
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
}

export interface PaymentMethodToken {
  paymentToken: string;
  sequenceId: string;
  cardLast4: string | null;
  cardBrand: string | null;
}
