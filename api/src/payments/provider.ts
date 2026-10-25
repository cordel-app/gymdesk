import type {
  CreateCardVerificationParams,
  CreatePaymentRequestParams,
  CreatePaymentRequestResult,
  WebhookPayload,
  ExecuteRecurringParams,
  ExecuteRecurringResult,
} from './types';

export interface PaymentProvider {
  createPaymentRequest(params: CreatePaymentRequestParams): Promise<CreatePaymentRequestResult>;
  /**
   * #788: tokenise a card without charging it. Returns the same shape as
   * `createPaymentRequest` — the hosted page renders whatever `providerOrderId`
   * names, verification or charge — but takes no amount.
   */
  createCardVerificationRequest(
    params: CreateCardVerificationParams
  ): Promise<CreatePaymentRequestResult>;
  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer
  ): Promise<WebhookPayload>;
  /**
   * #2087: ask the provider for a payment's current state. Returns the same
   * normalised shape `parseWebhook()` does, so one settle function serves the
   * webhook, the hosted page's confirmation and the cleanup reconciliation.
   */
  getPaymentStatus(providerRef: string): Promise<WebhookPayload>;
  executeRecurring(params: ExecuteRecurringParams): Promise<ExecuteRecurringResult>;
}
