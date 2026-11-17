// #2935: a Refund Receipt is issued for every completed refund, never for a
// pending or failed one, in its own numbering series, without touching the
// original receipt. Integration — only the payment provider is mocked.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, ensureTestProductSet,
} from './helpers';

const refundPayment = vi.fn();
vi.mock('../payments', () => ({
  getPaymentProvider: () => ({ refundPayment, executeRecurring: vi.fn(), createPaymentRequest: vi.fn() }),
}));

let gymId: string;
let otherGymId: string;
let ctId: number;

beforeAll(async () => {
  gymId = await createTestGym('Refund Receipt Gym');
  otherGymId = await createTestGym('Refund Receipt Other');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  const { rows } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  ctId = rows[0].id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

beforeEach(() => { refundPayment.mockReset(); });

/** A Billing Event of 40.00 with one completed attempt and a receipt number. */
async function paidEvent(method: 'cash' | 'provider') {
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Refund Receipt Member', `rr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`]);
  const psId = await ensureTestProductSet(gymId, memberId);
  const { insertId: billingEventId } = await db.query(
    `INSERT INTO billing_events (gym_id, product_set_id, member_id, event_type, amount, charge_type_id, source,
                                 attempt_count, receipt_number, receipt_issued_at)
     VALUES (?, ?, ?, 'payment_recorded', '40.00', ?, 'system', 1, ?, UTC_TIMESTAMP())`,
    [gymId, psId, memberId, ctId, `2026-${Math.floor(Math.random() * 9000) + 1000}`]);
  await db.query(
    `INSERT INTO billing_event_lines (gym_id, billing_event_id, kind, item_name, quantity, amount)
     VALUES (?, ?, 'product', 'Membership fee', 1, '40.00')`, [gymId, billingEventId]);
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider, provider_order,
        provider_ref, source, attempt, method, payment_method_name, created_at, completed_at)
     VALUES (?, ?, '40.00', 'EUR', ?, ?, 'completed', ?, UUID(), ?, 'manual', 1, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [gymId, memberId, ctId, billingEventId, method === 'provider' ? 'monei' : 'manual',
      method === 'provider' ? 'pay_rr' : null, method, method === 'provider' ? 'Monei' : 'Cash']);
  return { memberId, billingEventId };
}

const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const refund = (id: number, body: object) =>
  auth(request.post(`/payments/billing-events/${id}/refund`)).send(body);
const receiptsOf = async (billingEventId: number) => (await db.query<any>(
  'SELECT * FROM refund_receipts WHERE billing_event_id = ? ORDER BY id', [billingEventId])).rows;

describe('Refund Receipt issuance', () => {
  it('issues one receipt per completed partial refund, in its own series, and keeps the original receipt', async () => {
    const e = await paidEvent('cash');
    const { rows: [before] } = await db.query<any>(
      'SELECT receipt_number, receipt_issued_at FROM billing_events WHERE id = ?', [e.billingEventId]);

    expect((await refund(e.billingEventId, { kind: 'adhoc', amount: '15.00' })).status).toBe(201);
    expect((await refund(e.billingEventId, { kind: 'adhoc', amount: '5.00' })).status).toBe(201);

    const receipts = await receiptsOf(e.billingEventId);
    expect(receipts).toHaveLength(2);
    expect(receipts[0].receipt_number).toMatch(/^R-\d{4}-\d{4}$/);
    expect(receipts[0].receipt_number).not.toBe(receipts[1].receipt_number);
    const [a, b] = receipts.map((r: any) => Number(r.receipt_number.slice(-4)));
    expect(b).toBe(a + 1);
    // Each documents its own refund transaction and names the original attempt.
    expect(new Set(receipts.map((r: any) => r.payment_request_id)).size).toBe(2);
    const { rows: [orig] } = await db.query<any>(
      "SELECT id FROM payment_requests WHERE billing_event_id = ? AND transaction_type = 'payment'", [e.billingEventId]);
    expect(receipts.every((r: any) => r.original_payment_request_id === orig.id)).toBe(true);

    const { rows: [after] } = await db.query<any>(
      'SELECT receipt_number, receipt_issued_at FROM billing_events WHERE id = ?', [e.billingEventId]);
    expect(after).toEqual(before);
    const { rows: invoices } = await db.query<any>('SELECT id FROM invoices WHERE billing_event_id = ?', [e.billingEventId]);
    expect(invoices).toHaveLength(0);

    // Listed on the event and on each refund transaction.
    const list = await auth(request.get(`/payments/billing-events?member_id=${e.memberId}`));
    const row = list.body.items.find((r: any) => r.id === e.billingEventId);
    expect(row.refund_receipts.map((r: any) => r.receipt_number)).toEqual(receipts.map((r: any) => r.receipt_number));
    const txs = await auth(request.get(`/payments/billing-events/${e.billingEventId}/transactions`));
    const refundTxs = txs.body.items.filter((t: any) => t.transaction_type === 'refund');
    expect(refundTxs.map((t: any) => t.refund_receipt_number).sort()).toEqual(receipts.map((r: any) => r.receipt_number).sort());
  });

  it('issues a receipt once the provider confirms the refund', async () => {
    refundPayment.mockResolvedValue({ providerStatus: 'REFUNDED', providerRefundRef: 'pay_rr', errorCode: null, errorMessage: null });
    const e = await paidEvent('provider');
    expect((await refund(e.billingEventId, { kind: 'full' })).status).toBe(201);
    expect(await receiptsOf(e.billingEventId)).toHaveLength(1);
  });

  it('issues none for a pending or a failed refund', async () => {
    refundPayment.mockRejectedValue(new Error('fetch failed: timeout'));
    const pending = await paidEvent('provider');
    expect((await refund(pending.billingEventId, { kind: 'full' })).status).toBe(502);
    expect(await receiptsOf(pending.billingEventId)).toHaveLength(0);

    refundPayment.mockReset();
    refundPayment.mockResolvedValue({ providerStatus: 'SUCCEEDED', providerRefundRef: 'pay_rr', errorCode: 'E1', errorMessage: 'not refundable' });
    const failed = await paidEvent('provider');
    expect((await refund(failed.billingEventId, { kind: 'full' })).status).toBe(502);
    expect(await receiptsOf(failed.billingEventId)).toHaveLength(0);
  });
});

describe('Refund Receipt PDF', () => {
  it('serves the PDF to the gym and 404s for another gym', async () => {
    const e = await paidEvent('cash');
    expect((await refund(e.billingEventId, { kind: 'full' })).status).toBe(201);
    const [rr] = await receiptsOf(e.billingEventId);

    const res = await auth(request.get(`/payments/refund-receipts/${rr.id}`))
      .buffer(true).parse((r: any, cb: any) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    expect((await auth(request.get(`/payments/refund-receipts/${rr.id}`), otherGymId)).status).toBe(404);
    expect((await request.get(`/payments/refund-receipts/${rr.id}`).set('x-gym-id', gymId)).status).toBe(401);
  });
});
