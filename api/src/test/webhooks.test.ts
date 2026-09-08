import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, request } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /webhooks/payment', () => {
  it('returns 200 so Monei can preflight the URL when registering the webhook', async () => {
    const res = await request.get('/webhooks/payment');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('POST /webhooks/payment', () => {
  it('returns 400 when the Monei signature header is missing', async () => {
    const res = await request.post('/webhooks/payment').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid signature' });
  });
});
