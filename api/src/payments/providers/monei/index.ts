import type { PaymentProvider } from '../../provider';
import type {
  CreateCardVerificationParams,
  CreatePaymentRequestParams,
  CreatePaymentRequestResult,
  WebhookPayload,
  ExecuteRecurringParams,
  ExecuteRecurringResult,
  RefundPaymentParams,
  RefundPaymentResult,
} from '../../types';
import { MoneiClient } from './client';
import { chargePayload, verifyAndParseWebhook } from './webhook';

export class MoneiProvider implements PaymentProvider {
  private readonly client: MoneiClient;
  /** The keys a notification may be signed with: the API key signs a
   * payment's own callback, the webhook secret an account webhook. */
  private readonly signingKeys: string[];

  constructor(apiKey: string, webhookSecret: string, accountId?: string) {
    this.client = new MoneiClient(apiKey, accountId);
    this.signingKeys = [apiKey, webhookSecret];
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
      // Lets Monei return paymentToken + sequenceId on the first CIT webhook
      // so the nightly MIT run (#184) has a token to charge.
      generatePaymentToken: true,
    });

    if (!payment.id) {
      throw new Error('Monei createPayment returned no payment id');
    }

    return {
      providerOrderId: payment.id,
      checkoutUrl: payment.nextAction?.redirectUrl ?? '',
    };
  }

  /**
   * #788: MONEI's documented way to obtain a reusable token without charging —
   * `amount: 0` + `transactionType: 'VERIF'` + `generatePaymentToken: true`
   * (docs.monei.com/guides/save-payment-method). The verification still runs
   * the whole Card Input + `confirmPayment` flow on the hosted page, so the
   * `completed` webhook carries `paymentToken`/`sequenceId` exactly as a first
   * real payment does — which is what lets the webhook reuse one upsert for
   * both. Some acquirers answer a zero-amount verification with a small
   * authorisation they then void; that is the acquirer's behaviour, not a
   * second code path here, and it is on the go-to-production checklist to
   * confirm against the live account.
   */
  async createCardVerificationRequest(
    params: CreateCardVerificationParams,
  ): Promise<CreatePaymentRequestResult> {
    const payment = await this.client.createPayment({
      orderId: params.orderId,
      amount: 0,
      transactionType: 'VERIF',
      currency: params.currency,
      description: params.description,
      customer: { email: params.memberEmail },
      callbackUrl: params.notificationUrl,
      completeUrl: params.okUrl,
      cancelUrl: params.koUrl,
      generatePaymentToken: true,
    });

    if (!payment.id) {
      throw new Error('Monei createPayment (VERIF) returned no payment id');
    }

    return {
      providerOrderId: payment.id,
      checkoutUrl: payment.nextAction?.redirectUrl ?? '',
    };
  }

  async parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer
  ): Promise<WebhookPayload> {
    return verifyAndParseWebhook(headers, rawBody, this.signingKeys);
  }

  async getPaymentStatus(providerRef: string): Promise<WebhookPayload> {
    return chargePayload(await this.client.getPayment(providerRef));
  }

  /**
   * #2480: MONEI refunds a captured payment by its id, with the amount in
   * cents; the answer is the payment itself, whose status reads `REFUNDED` or
   * `PARTIALLY_REFUNDED` once the money is on its way back. The refund has no
   * id of its own, so the payment id is the reference kept for it.
   */
  async refundPayment(params: RefundPaymentParams): Promise<RefundPaymentResult> {
    const payment = await this.client.refundPayment(params.providerRef, {
      amount: params.amount,
      refundReason: 'requested_by_customer',
    });
    return {
      providerStatus: typeof payment.status === 'string' ? payment.status : null,
      providerRefundRef: payment.id ?? params.providerRef,
      errorCode: payment.statusCode ?? null,
      errorMessage: payment.statusMessage ?? null,
    };
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
      providerStatus: typeof payment.status === 'string' ? payment.status : null,
    };
  }
}
