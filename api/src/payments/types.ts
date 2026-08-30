export type PaymentStatus = 'pending' | 'completed' | 'failed' | 'expired';

export interface CreatePaymentRequestParams {
  orderId: string;
  amount: number;
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
