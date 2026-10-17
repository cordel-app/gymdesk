// #1657 stage 2 — a one-time Product staff Save as a `draft` purchase, Pay (promote
// to the pending purchase) and Cancel (hard delete).
//
// Integration against the real stack; only the provider's `createPaymentRequest`
// is stubbed.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';

vi.mock('../payments', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../payments')>();
  return {
    ...mod,
    getPaymentProvider: () => {
      const real = mod.getPaymentProvider();
      return Object.assign(Object.create(real), {
        createPaymentRequest: async (p: { orderId: string }) => ({
          providerOrderId: `monei-${p.orderId}`, checkoutUrl: 'https://pay.test/x',
        }),
      });
    },
  };
});

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const base = (memberId: number) => `/members/${memberId}/product-purchases`;

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Draft Member', `dr-${uniq()}@test.com`]);
  return insertId;
}

async function product(name: string, amount = '40.00'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'once', 'active', 'public', 0, 'EUR', ?, 'inclusive')`,
    [gymId, name, amount]);
  return insertId;
}

async function statusOf(id: number): Promise<string | null> {
  const { rows } = await db.query<any>('SELECT status FROM member_products_oneoff_snapshot WHERE id = ?', [id]);
  return rows[0]?.status ?? null;
}

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-webhook-secret';
  gymId = await createTestGym('Purchase Draft Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('Save persists a draft without paying', () => {
  it('writes a draft row with no payment request and no Billing Event', async () => {
    const m = await member();
    const p = await product('Locker draft');
    const res = await auth(request.post(base(m))).send({ product_id: p, draft: true });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('one_time_draft');
    expect(await statusOf(res.body.purchaseId)).toBe('draft');

    const { rows } = await db.query<any>('SELECT payment_request_id FROM member_products_oneoff_snapshot WHERE id = ?', [res.body.purchaseId]);
    expect(rows[0].payment_request_id).toBeNull();
    const events = await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ?', [gymId, m]);
    expect(Number(events.rows[0].n)).toBe(0);

    const list = await auth(request.get(`/members/${m}/products`));
    expect(list.body.items.find((i: any) => i.id === res.body.purchaseId)?.status).toBe('draft');
  });

  it('keeps one draft per Product and stops offering it again', async () => {
    const m = await member();
    const p = await product('Locker once');
    expect((await auth(request.post(base(m))).send({ product_id: p, draft: true })).status).toBe(201);
    const again = await auth(request.post(base(m))).send({ product_id: p, draft: true });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('draft_exists');
    const cat = await auth(request.get(`${base(m)}/catalogue`));
    expect(cat.body.items.map((i: any) => i.id)).not.toContain(p);
  });

  it('is invisible to the member’s own catalogue state', async () => {
    const m = await member();
    const p = await product('Staff only draft');
    const res = await auth(request.post(base(m))).send({ product_id: p, draft: true });
    const { rows } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM member_products_oneoff_snapshot WHERE id = ? AND status IN ('pending_payment','active')`, [res.body.purchaseId]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('requires auth and tenant scope', async () => {
    const m = await member();
    const p = await product('Scoped');
    expect((await request.post(base(m)).send({ product_id: p, draft: true })).status).toBe(401);
    const other = await createTestGym('Purchase Draft Other Gym');
    const res = await request.post(base(m)).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', other).send({ product_id: p, draft: true });
    expect([403, 404]).toContain(res.status);
  });
});

describe('Pay promotes the draft to the pending purchase', () => {
  it('replaces the draft with one pending purchase and a payment link', async () => {
    const m = await member();
    const p = await product('Pay me');
    const saved = await auth(request.post(base(m))).send({ product_id: p, draft: true });
    const paid = await auth(request.post(`${base(m)}/${saved.body.purchaseId}/pay`)).send({});
    expect(paid.status).toBe(201);
    expect(paid.body.checkoutUrl).toBeTruthy();
    expect(await statusOf(saved.body.purchaseId)).toBeNull();
    expect(await statusOf(paid.body.purchaseId)).toBe('pending_payment');
    const { rows } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM member_products_oneoff_snapshot WHERE member_id = ? AND product_id = ?`, [m, p]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('404s for a non-draft or another member’s purchase', async () => {
    const m = await member();
    const other = await member();
    const p = await product('Not yours');
    const saved = await auth(request.post(base(m))).send({ product_id: p, draft: true });
    expect((await auth(request.post(`${base(other)}/${saved.body.purchaseId}/pay`)).send({})).status).toBe(404);
    const paid = await auth(request.post(`${base(m)}/${saved.body.purchaseId}/pay`)).send({});
    expect((await auth(request.post(`${base(m)}/${paid.body.purchaseId}/pay`)).send({})).status).toBe(404);
  });
});

describe('Cancel hard-deletes only the draft', () => {
  it('removes the draft and nothing else', async () => {
    const m = await member();
    const keep = await product('Keep draft');
    const drop = await product('Drop draft');
    const a = await auth(request.post(base(m))).send({ product_id: keep, draft: true });
    const b = await auth(request.post(base(m))).send({ product_id: drop, draft: true });
    const del = await auth(request.delete(`${base(m)}/${b.body.purchaseId}`));
    expect(del.status).toBe(200);
    expect(await statusOf(b.body.purchaseId)).toBeNull();
    expect(await statusOf(a.body.purchaseId)).toBe('draft');
  });

  it('refuses to delete a pending or active purchase', async () => {
    const m = await member();
    const p = await product('Pending stays');
    const saved = await auth(request.post(base(m))).send({ product_id: p, draft: true });
    const paid = await auth(request.post(`${base(m)}/${saved.body.purchaseId}/pay`)).send({});
    const del = await auth(request.delete(`${base(m)}/${paid.body.purchaseId}`));
    expect(del.status).toBe(404);
    expect(await statusOf(paid.body.purchaseId)).toBe('pending_payment');
  });
});
