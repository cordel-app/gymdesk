import type {
  CreatePaymentRequestParams,
  CreatePaymentRequestResult,
  WebhookPayload,
  ExecuteRecurringParams,
  ExecuteRecurringResult,
} from './types';

export interface PaymentProvider {
  createPaymentRequest(params: CreatePaymentRequestParams): Promise<CreatePaymentRequestResult>;
  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer
  ): Promise<WebhookPayload>;
  executeRecurring(params: ExecuteRecurringParams): Promise<ExecuteRecurringResult>;
}
