// #3511 — a paid Billing Event gets its receipt number and its simplified
// invoice (paid representation) on every payment completion path, failures are
// logged and retried by the reconciliation, and nothing is issued twice.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const stored = new Map<string, Buffer>();
let failUploads = false;
vi.mock('../infra/private-storage', () => ({
  isPrivateStorageConfigured: () => true,
  putPrivateDocument: async (key: string, body: Buffer) => {
    if (failUploads) throw new Error('bucket unreachable');
    if (stored.has(key)) throw new Error('already exists');
    stored.set(key, body); return key;
  },
  getPrivateDocument: async (key: string) => ({ body: stored.get(key)!, contentType: 'application/pdf' }),
  privateObjectExists: async (key: string) => stored.has(key),
}));

import { db } from '../infra/db';
import { settlePaymentRequest } from '../api/payment-settlement';
import { ensurePaidEventDocuments, reconcilePaidEventDocuments } from '../api/paid-event-documents';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, ensureTestProductSet, legacyAssignmentQuery,
} from './helpers';

const warnings: object[] = [];
const log = { info: () => {}, warn: (o: object) => { warnings.push(o); }, error: () => {} } as any;
const auth = (g: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': g });

let gymId = ''; let memberId = 0; let setId = 0;

async function purchaseEvent(amount = '2.00', opts: { cancelled?: boolean; type?: string } = {}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, product_set_id, event_type, amount, source, cancelled_at)
     VALUES (?, ?, ?, ?, ?, 'provider', ?)`,
    [gymId, memberId, opts.type ? setId : null, opts.type ?? 'product_purchase', amount, opts.cancelled ? new Date() : null]);
  return Number(insertId);
}

async function attempt(eventId: number, status: string, amount = '2.00'): Promise<string> {
  const order = `DOC-${eventId}-${Math.random().toString(36).slice(2, 10)}`;
  await db.query(
    `INSERT INTO payment_requests (gym_id, member_id, amount, currency, billing_event_id, status, provider,
        provider_order, source, attempt, method, created_at, completed_at)
     VALUES (?, ?, ?, 'EUR', ?, ?, 'monei', ?, 'product_purchase', 1, 'provider', UTC_TIMESTAMP(), ?)`,
    [gymId, memberId, amount, eventId, status, order, status === 'completed' ? new Date() : null]);
  return order;
}

async function docs(eventId: number) {
  const { rows: ev } = await db.query<any>('SELECT receipt_number FROM billing_events WHERE id = ?', [eventId]);
  const { rows: inv } = await db.query<any>('SELECT * FROM invoices WHERE billing_event_id = ? ORDER BY id', [eventId]);
  return { receipt: ev[0]?.receipt_number ?? null, invoices: inv };
}

beforeAll(async () => {
  gymId = await createTestGym('PaidDocs Gym');
  await createTestMembership(gymId, 'admin');
  const m = await db.query(`INSERT INTO members (gym_id, name, email) VALUES (?, 'Paid Docs', ?)`,
    [gymId, `paiddocs-${Date.now()}@test.com`]);
  memberId = Number(m.insertId);
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `PaidDocs-Plan-${Date.now()}`]);
  const assignmentId = (await legacyAssignmentQuery(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', '2020-01-01', '20.00')`, [gymId, memberId, planId])).insertId;
  setId = await ensureTestProductSet(gymId, memberId, assignmentId);
});

afterAll(async () => {
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('a provider-confirmed product purchase (the reported Locker Rental)', () => {
  it('gets its receipt number and a paid simplified invoice when the payment settles', async () => {
    const id = await purchaseEvent();
    const order = await attempt(id, 'pending');
    const out = await settlePaymentRequest({
      orderId: order, status: 'completed', providerRef: `ref-${order}`, providerStatus: 'SUCCEEDED',
      paymentToken: null, sequenceId: null, cardLast4: null, cardBrand: null,
    } as any, { via: 'webhook', log });
    expect(out).toMatchObject({ kind: 'settled', status: 'completed' });
    const d = await docs(id);
    expect(d.receipt).toMatch(/^\d{4}-\d{4}$/);
    expect(d.invoices).toHaveLength(1);
    expect(d.invoices[0]).toMatchObject({ invoice_type: 'simplified', status: 'issued', payment_status: 'paid' });
    expect(d.invoices[0].simplified_paid_pdf_key).toBeTruthy();
  });
});

describe('a manual (cash) payment', () => {
  it('allocates the receipt number too, not only the invoice', async () => {
    const id = await purchaseEvent('20.00', { type: 'failed_billing' });
    const res = await request.post(`/payments/billing-events/${id}/manual-payment`).set(auth(gymId)).send({ method: 'cash' });
    expect(res.status).toBe(201);
    await vi.waitFor(async () => {
      const d = await docs(id);
      expect(d.receipt).toBeTruthy();
      expect(d.invoices[0]?.simplified_paid_pdf_key).toBeTruthy();
    });
  });
});

describe('ensurePaidEventDocuments', () => {
  it('is idempotent: a second call issues no second number or invoice', async () => {
    const id = await purchaseEvent('5.00');
    await attempt(id, 'completed', '5.00');
    const first = await ensurePaidEventDocuments(gymId, id, log);
    expect(first).toMatchObject({ receiptIssued: true, failed: false });
    const before = await docs(id);
    const again = await ensurePaidEventDocuments(gymId, id, log);
    expect(again).toMatchObject({ receiptIssued: false, representations: 0, failed: false });
    const after = await docs(id);
    expect(after.receipt).toBe(before.receipt);
    expect(after.invoices.map((i: any) => i.fiscal_number)).toEqual(before.invoices.map((i: any) => i.fiscal_number));
  });

  it('issues nothing for a pending, failed or cancelled event', async () => {
    const pending = await purchaseEvent(); await attempt(pending, 'pending');
    const failed = await purchaseEvent(); await attempt(failed, 'failed');
    const cancelled = await purchaseEvent('2.00', { cancelled: true }); await attempt(cancelled, 'completed');
    for (const id of [pending, failed, cancelled]) {
      await ensurePaidEventDocuments(gymId, id, log);
      const d = await docs(id);
      expect(d.receipt).toBeNull();
      expect(d.invoices).toHaveLength(0);
    }
  });

  it('a storage failure is logged, keeps the payment, and the reconciliation finishes it', async () => {
    const id = await purchaseEvent('7.00');
    await attempt(id, 'completed', '7.00');
    warnings.length = 0;
    failUploads = true;
    const out = await ensurePaidEventDocuments(gymId, id, log);
    failUploads = false;
    expect(out.failed).toBe(true);
    expect(warnings.some((w: any) => w.billingEventId === id)).toBe(true);
    const partial = await docs(id);
    expect(partial.receipt).toBeTruthy();
    expect(partial.invoices[0]?.simplified_paid_pdf_key ?? null).toBeNull();
    const { rows } = await db.query<any>('SELECT status FROM payment_requests WHERE billing_event_id = ?', [id]);
    expect(rows[0].status).toBe('completed');

    const r = await reconcilePaidEventDocuments({ since: null, log });
    expect(r.eventIds).toContain(id);
    const done = await docs(id);
    expect(done.receipt).toBe(partial.receipt);
    expect(done.invoices).toHaveLength(1);
    expect(done.invoices[0].simplified_paid_pdf_key).toBeTruthy();
  });
});

describe('reconcilePaidEventDocuments (nightly pass and historical backfill)', () => {
  it('finds a historical paid event with no documents, fills it once, then selects it no more', async () => {
    const id = await purchaseEvent('9.00');
    await attempt(id, 'completed', '9.00');
    const dry = await reconcilePaidEventDocuments({ since: null, log, dryRun: true });
    expect(dry.eventIds).toContain(id);
    expect((await docs(id)).receipt).toBeNull();

    await reconcilePaidEventDocuments({ since: null, log });
    const d = await docs(id);
    expect(d.receipt).toBeTruthy();
    expect(d.invoices).toHaveLength(1);

    const again = await reconcilePaidEventDocuments({ since: null, log, dryRun: true });
    expect(again.eventIds).not.toContain(id);
  });

  it('respects its window: an event paid before `since` is left to the backfill', async () => {
    const id = await purchaseEvent('3.00');
    await attempt(id, 'completed', '3.00');
    await db.query('UPDATE payment_requests SET completed_at = ? WHERE billing_event_id = ?', ['2020-01-01', id]);
    const r = await reconcilePaidEventDocuments({ since: '2026-01-01', log, dryRun: true });
    expect(r.eventIds).not.toContain(id);
  });
});
