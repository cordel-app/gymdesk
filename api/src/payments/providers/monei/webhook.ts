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

  const status = MONEI_STATUS_MAP[body.status] ?? 'failed';

  return {
    orderId: body.orderId,
    status,
    providerRef: body.id,
    paymentToken: body.paymentToken ?? null,
    sequenceId: body.sequenceId ?? null,
    cardLast4: body.paymentMethod?.card?.last4 ?? null,
    cardBrand: body.paymentMethod?.card?.brand ?? null,
    rawBody,
  };
}
