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
  executeRecurring(params: ExecuteRecurringParams): Promise<ExecuteRecurringResult>;
  /**
   * #2087: reads a payment back from the provider by its own id (our
   * `provider_ref`), in the same shape `parseWebhook()` produces. It is what
   * the hosted page's confirmation and the cleanup settle from — the provider's
   * answer, never a status a browser sent. Throws when the provider cannot be
   * reached or does not know the id.
   */
  getPaymentStatus(providerRef: string): Promise<WebhookPayload>;
}
