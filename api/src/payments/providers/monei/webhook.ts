import crypto from 'crypto';
import type { WebhookPayload } from '../../types';
import type { MoneiWebhookBody } from './types';

const MONEI_STATUS_MAP: Record<string, WebhookPayload['status']> = {
  SUCCEEDED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired',
  PENDING: 'pending',
  PROCESSING: 'pending',
  AUTHORIZED: 'pending',
};

export function verifyAndParseWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  webhookSecret: string
): WebhookPayload {
  const signatureHeader = headers['monei-signature'];
  const rawSig = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

  if (!rawSig) {
    throw new Error('Missing MONEI-SIGNATURE header');
  }

  const parts = Object.fromEntries(
    rawSig.split(',').map((part) => {
      const idx = part.indexOf('=');
      return [part.slice(0, idx), part.slice(idx + 1)];
    })
  );

  const timestamp = parts['t'];
  const receivedSig = parts['v1'];

  if (!timestamp || !receivedSig) {
    throw new Error('Malformed MONEI-SIGNATURE header');
  }

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(signedPayload)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(receivedSig, 'hex');

  if (
    expectedBuf.length !== receivedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    throw new Error('Invalid webhook signature');
  }

  const body = JSON.parse(rawBody.toString('utf8')) as MoneiWebhookBody;

  // Only 'charge' events carry the payment_requests-relevant fields below.
  // Other object types (subscription/account/settlement/provider) aren't
  // subscribed to on this webhook, but ack them gracefully instead of
  // crashing on missing fields if MONEI ever sends one anyway.
  if (body.objectType !== 'charge') {
    // No provider_order will ever match '' — the router's existing
    // "no matching payment_request" branch acks this with 200.
    return {
      orderId: '',
      status: 'failed',
      providerRef: body.id,
      paymentToken: null,
      sequenceId: null,
      cardLast4: null,
      cardBrand: null,
      rawBody,
    };
  }

  const charge = body.object;
  const status = MONEI_STATUS_MAP[charge.status] ?? 'failed';

  return {
    orderId: charge.orderId,
    status,
    providerRef: charge.id,
    paymentToken: charge.paymentToken ?? null,
    sequenceId: charge.sequenceId ?? null,
    cardLast4: charge.paymentMethod?.card?.last4 ?? null,
    cardBrand: charge.paymentMethod?.card?.brand ?? null,
    rawBody,
  };
}
