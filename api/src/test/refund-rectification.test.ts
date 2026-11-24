// #3298 stage 3: a refund that leaves its payment fully refunded issues the
// rectifying invoice (R5 for a simplified, R1 for a complete invoice) of the
// event's standing invoice, linked to the refund; its Refund Receipt stays a
// separate record. A partial refund, an event with no invoice and an invoice
// already rectified issue none. Integration — the payment provider and the
// private bucket are mocked.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stored = new Map<string, Buffer>();
vi.mock('../infra/private-storage', () => ({
  isPrivateStorageConfigured: () => true,
  putPrivateDocument: async (key: string, body: Buffer) => {
    if (stored.has(key)) throw new Error('already exists');
    stored.set(key, body); return key;
  },
  getPrivateDocument: async (key: string) => ({ body: stored.get(key)!, contentType: 'application/pdf' }),
  privateObjectExists: async (key: string) => stored.has(key),
}));

const refundPayment = vi.fn();
vi.mock('../payments', () => ({
  getPaymentProvider: () => ({ refundPayment, executeRecurring: vi.fn(), createPaymentRequest: vi.fn() }),
}));

import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, ensureTestProductSet,
} from './helpers';

let gymId = '';
let ctId = 0;

beforeAll(async () => {
  gymId = await createTestGym('Refund Rectification Gym');
  await createTestMembership(gymId, 'admin');
  const { rows } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  ctId = rows[0].id;
});

afterAll(async () => { await cleanupTestGyms(); await db.end(); });
beforeEach(() => { refundPayment.mockReset(); });

const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

/** A Billing Event of 40.00 with one completed attempt. */
async function paidEvent(method: 'cash' | 'provider') {
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Rectification Member', `rx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`]);
  const psId = await ensureTestProductSet(gymId, memberId);
  const { insertId: billingEventId } = await db.query(
    `INSERT INTO billing_events (gym_id, product_set_id, member_id, event_type, amount, charge_type_id, source, attempt_count)
     VALUES (?, ?, ?, 'payment_recorded', '40.00', ?, 'system', 1)`,
    [gymId, psId, memberId, ctId]);
  await db.query(
    `INSERT INTO billing_event_lines (gym_id, billing_event_id, kind, item_name, quantity, amount)
     VALUES (?, ?, 'product', 'Membership fee', 1, '40.00')`, [gymId, billingEventId]);
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider, provider_order,
        provider_ref, source, attempt, method, payment_method_name, created_at, completed_at)
     VALUES (?, ?, '40.00', 'EUR', ?, ?, 'completed', ?, UUID(), ?, 'manual', 1, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [gymId, memberId, ctId, billingEventId, method === 'provider' ? 'monei' : 'manual',
      method === 'provider' ? 'pay_rx' : null, method, method === 'provider' ? 'Monei' : 'Cash']);
  return billingEventId as number;
}

const issue = (eventId: number, body: object) =>
  auth(request.post(`/payments/billing-events/${eventId}/invoices`)).send(body);
const refund = (eventId: number, body: object) =>
  auth(request.post(`/payments/billing-events/${eventId}/refund`)).send(body);
const invoicesOf = async (eventId: number) => (await db.query<any>(
  'SELECT * FROM invoices WHERE billing_event_id = ? ORDER BY id', [eventId])).rows;
const refundIds = async (eventId: number) => (await db.query<any>(
  `SELECT r.id FROM payment_requests r JOIN payment_requests o ON o.id = r.refund_of_payment_request_id
    WHERE o.billing_event_id = ? AND r.transaction_type = 'refund' ORDER BY r.id`, [eventId])).rows.map((r: any) => r.id);

describe('Rectifying invoice issued by a refund', () => {
  it('issues none for a partial refund, then rectifies the simplified invoice once the payment is fully refunded', async () => {
    const eventId = await paidEvent('cash');
    const original = await issue(eventId, { invoice_type: 'simplified' });
    expect(original.status).toBe(201);

    expect((await refund(eventId, { kind: 'adhoc', amount: '15.00' })).status).toBe(201);
    expect(await invoicesOf(eventId)).toHaveLength(1);

    expect((await refund(eventId, { kind: 'full' })).status).toBe(201);
    const invoices = await invoicesOf(eventId);
    expect(invoices).toHaveLength(2);
    const rect = invoices[1];
    const [, second] = await refundIds(eventId);
    expect(rect.related_invoice_id).toBe(original.body.id);
    expect(rect.invoice_type).toBe('simplified'); // R5 at VERI*FACTU
    expect(rect.refund_payment_request_id).toBe(second);
    expect(rect.fiscal_number).toMatch(/^R-\d{4}-\d{4}$/);
    // The financial proof is its own record, and the rectification names it.
    const { rows: [rr] } = await db.query<any>('SELECT receipt_number FROM refund_receipts WHERE payment_request_id = ?', [second]);
    expect(rect.rectification_reason).toBe(`Refund ${rr.receipt_number}`);
    // The original is never edited, and the read reports the link.
    expect(invoices[0].fiscal_number).toBe(original.body.fiscal_number);
    const list = await auth(request.get(`/payments/billing-events/${eventId}/invoices`));
    expect(list.body.invoices.find((i: any) => i.id === rect.id).refund_payment_request_id).toBe(second);
    expect((await auth(request.get(`/payments/invoices/${rect.id}/pdf`))).status).toBe(200);
  });

  it('issues none when the event has no invoice', async () => {
    const eventId = await paidEvent('cash');
    expect((await refund(eventId, { kind: 'full' })).status).toBe(201);
    expect(await invoicesOf(eventId)).toHaveLength(0);
    // The refund itself is still documented by its Refund Receipt.
    const { rows } = await db.query<any>('SELECT id FROM refund_receipts WHERE billing_event_id = ?', [eventId]);
    expect(rows).toHaveLength(1);
  });

  it('rectifies the complete invoice that replaced the simplified one', async () => {
    const eventId = await paidEvent('cash');
    const simplified = await issue(eventId, { invoice_type: 'simplified' });
    const full = await issue(eventId, {
      invoice_type: 'full', customer_name: 'Acme SL', customer_tax_id: 'B12345674', customer_address: 'Calle 1, Madrid',
    });
    expect(full.status).toBe(201);
    expect((await refund(eventId, { kind: 'full' })).status).toBe(201);
    const rect = (await invoicesOf(eventId)).find((i: any) => i.related_invoice_id != null);
    expect(rect.related_invoice_id).toBe(full.body.id);
    expect(rect.related_invoice_id).not.toBe(simplified.body.id);
    expect(rect.invoice_type).toBe('full'); // R1 at VERI*FACTU
  });

  it('does not rectify an invoice staff already rectified', async () => {
    const eventId = await paidEvent('cash');
    const original = await issue(eventId, { invoice_type: 'simplified' });
    expect((await auth(request.post(`/payments/invoices/${original.body.id}/rectify`)).send({ reason: 'manual' })).status).toBe(201);
    expect((await refund(eventId, { kind: 'full' })).status).toBe(201);
    expect(await invoicesOf(eventId)).toHaveLength(2);
  });

  it('issues it once the provider confirms the refund, and not while it is pending', async () => {
    refundPayment.mockResolvedValue({ providerStatus: 'REFUNDED', providerRefundRef: 'pay_rx', errorCode: null, errorMessage: null });
    const eventId = await paidEvent('provider');
    await issue(eventId, { invoice_type: 'simplified' });
    expect((await refund(eventId, { kind: 'full' })).status).toBe(201);
    const [refundId] = await refundIds(eventId);
    expect((await invoicesOf(eventId)).find((i: any) => i.related_invoice_id != null)?.refund_payment_request_id).toBe(refundId);

    refundPayment.mockReset();
    refundPayment.mockRejectedValue(new Error('fetch failed: timeout'));
    const pendingEvent = await paidEvent('provider');
    await issue(pendingEvent, { invoice_type: 'simplified' });
    expect((await refund(pendingEvent, { kind: 'full' })).status).toBe(502);
    expect(await invoicesOf(pendingEvent)).toHaveLength(1);
  });
});
