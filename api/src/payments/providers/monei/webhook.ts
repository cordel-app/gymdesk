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

/**
 * Verifies and parses what MONEI POSTs to our notification URL. Two shapes
 * arrive there, signed two ways (docs.monei.com/guides/webhooks):
 *
 * - the **payment callback** — what every payment we create sends to its own
 *   `callbackUrl` — is the bare Payment object, signed with the API key;
 * - an **account webhook** (MONEI Connect partner, dashboard-configured) is an
 *   envelope `{ id, type, objectType, object }`, which is what this parser was
 *   written against.
 *
 * Until both were accepted the callback was refused or ignored: verified only
 * against MONEI_WEBHOOK_SECRET, and read only as an envelope, so a bare
 * Payment matched no request and was acked with nothing settled. A payment
 * therefore stayed `pending` whatever its outcome. `secrets` is every key the
 * signature may be made with; one must match, so nothing unsigned gets in.
 */
export function verifyAndParseWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  secrets: string | readonly string[]
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
  const receivedBuf = Buffer.from(receivedSig, 'hex');
  const candidates = (Array.isArray(secrets) ? secrets : [secrets]).filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  );
  const verified = candidates.some((key) => {
    const expectedBuf = Buffer.from(
      crypto.createHmac('sha256', key).update(signedPayload).digest('hex'),
      'hex',
    );
    return expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf);
  });

  if (!verified) {
    throw new Error('Invalid webhook signature');
  }

  const parsed = JSON.parse(rawBody.toString('utf8')) as MoneiWebhookBody | MoneiCallbackPayment;

  // The payment callback: the Payment object itself, no envelope.
  if (isBarePayment(parsed)) return chargePayload(parsed, rawBody);

  const body = parsed as MoneiWebhookBody;

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
      providerStatus: null,
    };
  }

  return chargePayload(body.object, rawBody);
}

type MoneiCallbackPayment = MoneiWebhookBody['object'];

/** A bare Payment object, as a payment's callbackUrl receives it. */
function isBarePayment(body: unknown): body is MoneiCallbackPayment {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return !('object' in b) && typeof b.id === 'string' && typeof b.status === 'string';
}

function chargePayload(charge: MoneiCallbackPayment, rawBody: Buffer): WebhookPayload {
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
    // Kept verbatim: the map above defaults an unrecognised status to `failed`,
    // which is exactly what must not be inferred from it (#1325).
    providerStatus: typeof charge.status === 'string' ? charge.status : null,
  };
}
