import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyAndParseWebhook } from '../payments/providers/monei/webhook';

afterEach(() => {
  delete process.env.PAYMENT_PROVIDER;
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
});

describe('getPaymentProvider()', () => {
  // The factory caches its provider at module level: reset the module registry
  // so each test reads the env vars afresh.
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns a MoneiProvider when PAYMENT_PROVIDER=monei', async () => {
    process.env.PAYMENT_PROVIDER = 'monei';
    process.env.MONEI_API_KEY = 'test-key';
    process.env.MONEI_WEBHOOK_SECRET = 'test-secret';

    const { getPaymentProvider } = await import('../payments/index');
    const { MoneiProvider } = await import('../payments/providers/monei');
    expect(getPaymentProvider()).toBeInstanceOf(MoneiProvider);
  });

  it('throws a descriptive error for unknown provider', async () => {
    process.env.PAYMENT_PROVIDER = 'stripe';
    process.env.MONEI_API_KEY = 'test-key';
    process.env.MONEI_WEBHOOK_SECRET = 'test-secret';

    const { getPaymentProvider } = await import('../payments/index');
    expect(() => getPaymentProvider()).toThrow('Unknown payment provider: "stripe"');
  });
});

describe('verifyAndParseWebhook()', () => {
  const secret = 'test-webhook-secret';

  function buildSignedHeaders(body: Buffer, timestamp = '1700000000'): Record<string, string> {
    const signedPayload = `${timestamp}.${body.toString('utf8')}`;
    const sig = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    return { 'monei-signature': `t=${timestamp},v1=${sig}` };
  }

  const validBody: Record<string, unknown> = {
    id: 'evt_abc123',
    type: 'charge.succeeded',
    objectType: 'charge',
    objectId: 'pay_abc123',
    accountId: 'acc_merchant1',
    livemode: false,
    createdAt: 1700000000,
    object: {
      id: 'pay_abc123',
      orderId: 'ord-001',
      status: 'SUCCEEDED',
      paymentToken: 'tok_xyz',
      sequenceId: 'seq_001',
      paymentMethod: { card: { last4: '4242', brand: 'VISA' } },
    },
  };

  it('parses a valid webhook payload', () => {
    const raw = Buffer.from(JSON.stringify(validBody));
    const headers = buildSignedHeaders(raw);

    const payload = verifyAndParseWebhook(headers, raw, secret);

    expect(payload.orderId).toBe('ord-001');
    expect(payload.status).toBe('completed');
    expect(payload.providerRef).toBe('pay_abc123');
    expect(payload.paymentToken).toBe('tok_xyz');
    expect(payload.sequenceId).toBe('seq_001');
    expect(payload.cardLast4).toBe('4242');
    expect(payload.cardBrand).toBe('VISA');
  });

  it('throws immediately on tampered signature — no payload fields accessed', () => {
    const raw = Buffer.from(JSON.stringify(validBody));
    const headers = { 'monei-signature': 't=1700000000,v1=deadbeef00000000000000000000000000000000000000000000000000000000' };

    expect(() => verifyAndParseWebhook(headers, raw, secret)).toThrow('Invalid webhook signature');
  });

  it('throws when MONEI-SIGNATURE header is absent', () => {
    const raw = Buffer.from(JSON.stringify(validBody));
    expect(() => verifyAndParseWebhook({}, raw, secret)).toThrow('Missing MONEI-SIGNATURE header');
  });

  it('throws when signature header is malformed', () => {
    const raw = Buffer.from(JSON.stringify(validBody));
    expect(() => verifyAndParseWebhook({ 'monei-signature': 'garbage' }, raw, secret)).toThrow(
      'Malformed MONEI-SIGNATURE header'
    );
  });

  it('maps MONEI status codes to PaymentStatus', () => {
    const statuses: Record<string, string> = {
      SUCCEEDED: 'completed',
      FAILED: 'failed',
      EXPIRED: 'expired',
      PENDING: 'pending',
      PROCESSING: 'pending',
    };

    for (const [moneiStatus, expected] of Object.entries(statuses)) {
      const body = {
        ...validBody,
        object: { ...(validBody.object as object), status: moneiStatus },
      };
      const raw = Buffer.from(JSON.stringify(body));
      const headers = buildSignedHeaders(raw);
      const payload = verifyAndParseWebhook(headers, raw, secret);
      expect(payload.status).toBe(expected);
    }
  });

  it('returns null for optional fields absent from payload', () => {
    const sparse = {
      ...validBody,
      object: { id: 'pay_no_token', orderId: 'ord-002', status: 'FAILED' },
    };
    const raw = Buffer.from(JSON.stringify(sparse));
    const headers = buildSignedHeaders(raw);

    const payload = verifyAndParseWebhook(headers, raw, secret);

    expect(payload.paymentToken).toBeNull();
    expect(payload.sequenceId).toBeNull();
    expect(payload.cardLast4).toBeNull();
    expect(payload.cardBrand).toBeNull();
  });

  it('ignores non-charge object types instead of throwing on missing fields', () => {
    const accountEvent = {
      ...validBody,
      type: 'account.updated',
      objectType: 'account',
      object: { id: 'acc_merchant1', status: 'active' },
    };
    const raw = Buffer.from(JSON.stringify(accountEvent));
    const headers = buildSignedHeaders(raw);

    const payload = verifyAndParseWebhook(headers, raw, secret);

    expect(payload.orderId).toBe('');
  });
});

// A payment's own callbackUrl receives the bare Payment object, signed with the
// API key (docs.monei.com/guides/webhooks). The parser read only the account
// webhook's envelope and verified only with MONEI_WEBHOOK_SECRET, so on dev a
// Monei test payment — approved or failed — left its request `pending`.
describe('verifyAndParseWebhook() — the payment callback', () => {
  const apiKey = 'pk_test_api_key';
  const webhookSecret = 'whsec_other';

  function sign(body: Buffer, key: string, timestamp = '1700000000'): Record<string, string> {
    const sig = crypto.createHmac('sha256', key).update(`${timestamp}.${body.toString('utf8')}`).digest('hex');
    return { 'monei-signature': `t=${timestamp},v1=${sig}` };
  }

  const barePayment = {
    id: 'pay_cb_1',
    orderId: 'ord-cb-1',
    status: 'SUCCEEDED',
    amount: 100,
    currency: 'EUR',
    paymentToken: 'tok_cb',
    sequenceId: 'seq_cb',
    paymentMethod: { card: { last4: '4406', brand: 'visa' } },
  };

  it('settles a bare Payment signed with the API key', () => {
    const raw = Buffer.from(JSON.stringify(barePayment));
    const payload = verifyAndParseWebhook(sign(raw, apiKey), raw, [apiKey, webhookSecret]);
    expect(payload.orderId).toBe('ord-cb-1');
    expect(payload.status).toBe('completed');
    expect(payload.providerRef).toBe('pay_cb_1');
    expect(payload.paymentToken).toBe('tok_cb');
    expect(payload.providerStatus).toBe('SUCCEEDED');
  });

  it('reads a failed 3D Secure callback as failed', () => {
    const raw = Buffer.from(JSON.stringify({ ...barePayment, status: 'FAILED', paymentToken: undefined }));
    const payload = verifyAndParseWebhook(sign(raw, apiKey), raw, [apiKey, webhookSecret]);
    expect(payload.orderId).toBe('ord-cb-1');
    expect(payload.status).toBe('failed');
  });

  it('still accepts an account webhook signed with the webhook secret', () => {
    const envelope = { id: 'evt_1', type: 'charge.succeeded', objectType: 'charge', object: barePayment };
    const raw = Buffer.from(JSON.stringify(envelope));
    const payload = verifyAndParseWebhook(sign(raw, webhookSecret), raw, [apiKey, webhookSecret]);
    expect(payload.orderId).toBe('ord-cb-1');
    expect(payload.status).toBe('completed');
  });

  it('refuses a callback signed with any other key', () => {
    const raw = Buffer.from(JSON.stringify(barePayment));
    expect(() => verifyAndParseWebhook(sign(raw, 'someone-else'), raw, [apiKey, webhookSecret])).toThrow(
      'Invalid webhook signature',
    );
  });

  it('refuses everything when no key is configured', () => {
    const raw = Buffer.from(JSON.stringify(barePayment));
    expect(() => verifyAndParseWebhook(sign(raw, ''), raw, ['', ''])).toThrow('Invalid webhook signature');
  });
});

describe('MoneiProvider.getPaymentStatus() (#2087)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the payment back with the API key and maps it as a callback would be', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'pay_123', orderId: 'order-1', status: 'SUCCEEDED', amount: 3000, currency: 'EUR',
      paymentToken: 'tok_1', sequenceId: 'seq_1', paymentMethod: { card: { last4: '4242', brand: 'visa' } },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { MoneiProvider } = await import('../payments/providers/monei');

    const payload = await new MoneiProvider('api-key', 'secret', 'acc_9').getPaymentStatus('pay_123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.monei.com/v1/payments/pay_123');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ Authorization: 'api-key', 'MONEI-Account-ID': 'acc_9' });
    expect(payload).toMatchObject({
      orderId: 'order-1', status: 'completed', providerRef: 'pay_123', providerStatus: 'SUCCEEDED',
      paymentToken: 'tok_1', sequenceId: 'seq_1', cardLast4: '4242', cardBrand: 'visa',
    });
  });

  it('keeps an unrecognised status verbatim beside the internal mapping', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'pay_1', orderId: 'o', status: 'PENDING_PROCESSING' }))));
    const { MoneiProvider } = await import('../payments/providers/monei');
    const payload = await new MoneiProvider('k', 's').getPaymentStatus('pay_1');
    expect(payload.providerStatus).toBe('PENDING_PROCESSING');
  });

  it('throws when MONEI answers an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const { MoneiProvider } = await import('../payments/providers/monei');
    await expect(new MoneiProvider('k', 's').getPaymentStatus('pay_x')).rejects.toThrow(/404/);
  });
});
