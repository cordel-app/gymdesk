import type { PaymentProvider } from '../../provider';
import type {
  CreatePaymentRequestParams,
  CreatePaymentRequestResult,
  WebhookPayload,
  ExecuteRecurringParams,
  ExecuteRecurringResult,
} from '../../types';
import { MoneiClient } from './client';
import { verifyAndParseWebhook } from './webhook';

export class MoneiProvider implements PaymentProvider {
  private readonly client: MoneiClient;
  private readonly webhookSecret: string;

  constructor(apiKey: string, webhookSecret: string) {
    this.client = new MoneiClient(apiKey);
    this.webhookSecret = webhookSecret;
  }

  async createPaymentRequest(params: CreatePaymentRequestParams): Promise<CreatePaymentRequestResult> {
    const payment = await this.client.createPayment({
      orderId: params.orderId,
      amount: params.amount,
      currency: params.currency,
      description: params.description,
      customer: { email: params.memberEmail },
      callbackUrl: params.notificationUrl,
      completeUrl: params.okUrl,
      cancelUrl: params.koUrl,
    });

    if (!payment.nextAction?.redirectUrl) {
      throw new Error(`Monei payment ${payment.id} has no redirectUrl`);
    }

    return {
      providerOrderId: payment.id,
      checkoutUrl: payment.nextAction.redirectUrl,
    };
  }

  async parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer
  ): Promise<WebhookPayload> {
    return verifyAndParseWebhook(headers, rawBody, this.webhookSecret);
  }

  async executeRecurring(params: ExecuteRecurringParams): Promise<ExecuteRecurringResult> {
    const payment = await this.client.createRecurringPayment({
      orderId: params.orderId,
      amount: params.amount,
      currency: params.currency,
      paymentToken: params.paymentToken,
      sequence: {
        type: 'RECURRING',
        id: params.sequenceId,
      },
    });

    const success = payment.status === 'SUCCEEDED';

    return {
      success,
      providerRef: payment.id,
      errorCode: success ? null : (payment.statusCode ?? null),
      errorMessage: success ? null : (payment.statusMessage ?? null),
    };
  }
}
