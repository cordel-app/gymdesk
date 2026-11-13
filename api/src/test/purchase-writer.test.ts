// #2126 stage 5b — a bought one-time Product is written by one writer (`api/purchase-writer.ts`)
// into its Product snapshot from the writer's own values. Every step of a purchase's life (staff Save
// as draft, Cancel of the draft, Pay of a draft, the webhook completing it, staff Cancel of a completed
// one) moves the snapshot, links it to the purchase's Billing Event and freezes its Promotions under it.
// A Sessions package lands in `product_session_snapshots`, anything else in `product_oneoff_snapshots`.
// Since stage 5d-6 the legacy record and its Promotion table are dropped (migration 415). Only the provider's
// `createPaymentRequest` is stubbed.

import crypto from 'crypto';
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

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER, proratedToNextFirst } from './helpers';
import { TEST_PURCHASES } from './productSnapshotReads';

const SECRET = 'test-2126-5b-webhook';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const day = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = day(0);

const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Writer Member', `pw-${uniq()}@test.com`]);
  return insertId;
}

async function product(opts: {
  name: string; amount?: string; frequency?: string | null; enrollment?: 'public' | 'staff_only';
  status?: 'active' | 'inactive'; type?: string;
}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency,
        amount, tax_behavior)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'EUR', ?, 'inclusive')`,
    [gymId, opts.name, opts.type ?? 'fee', opts.frequency ?? 'once', opts.status ?? 'active',
      opts.enrollment ?? 'public', opts.amount ?? '100.00']);
  return insertId;
}

async function promotion(opts: { name: string; stackable?: 0 | 1; newMembersOnly?: 0 | 1 }): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions
       (gym_id, name, starts_at, ends_at, lifecycle_status, applies_to, stackable,
        only_applicable_for_new_members, free_months, paid_months, bonus_months)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 'product', ?, ?, 0, 6, 0)`,
    [gymId, opts.name, opts.stackable ?? 1, opts.newMembersOnly ?? 0]);
  return insertId;
}

async function grant(promotionId: number, productId: number, category: 'session' | 'oneoff' | 'periodical', action = 'percentage_discount', value: number | null = 50) {
  await db.query(
    `INSERT INTO promotion_${category} (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`)
     VALUES (?, ?, ?, 1, ?, ?)`, [gymId, promotionId, productId, action, value]);
}

function webhook(payload: unknown) {
  const raw = JSON.stringify(payload);
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return request.post('/webhooks/payment').set({ 'monei-signature': `t=${t},v1=${v1}` })
    .set('Content-Type', 'application/json').send(raw);
}

async function pay(paymentRequestId: number) {
  const { rows } = await db.query<any>('SELECT provider_order FROM payment_requests WHERE id = ?', [paymentRequestId]);
  const id = crypto.randomBytes(12).toString('hex');
  return webhook({
    id: `evt_${id}`, type: 'charge.succeeded', objectId: id, objectType: 'charge',
    object: { id, orderId: rows[0].provider_order, status: 'SUCCEEDED' },
  });
}

const base = (memberId: number) => `/members/${memberId}/product-purchases`;

const SNAPSHOT_TABLE = { sessions: 'product_session_snapshots', fee: 'product_oneoff_snapshots' } as const;
const SET_JUNCTION = { sessions: 'product_set_session_snapshots', fee: 'product_set_oneoff_snapshots' } as const;
const SNAPSHOT_COL = { sessions: 'product_session_snapshot_id', fee: 'product_oneoff_snapshot_id' } as const;
const EVENT_JUNCTION = {
  sessions: ['billing_event_session_snapshots', 'product_session_snapshot_id'],
  fee: ['billing_event_oneoff_snapshots', 'product_oneoff_snapshot_id'],
} as const;

/** The purchase's snapshot, and whether a row for it sits in the other snapshot table. */
async function pair(purchaseId: number, type: 'sessions' | 'fee') {
  const cols = `status, member_id, product_id, list_price, direct_discount_percent, direct_discount_amount,
    tax_rate_percent, validity_days, DATE_FORMAT(valid_until, '%Y-%m-%d') AS valid_until,
    DATE_FORMAT(cancelled_on, '%Y-%m-%d') AS cancelled_on, purchased_at, assigned_member_id, product_name,
    product_type, units, currency, created_by, modified_by`;
  const { rows: snap } = await db.query<any>(
    `SELECT ${cols}, unit_price AS amount, id AS snapshot_id, member_product_id,
            (SELECT COUNT(*) FROM ${SET_JUNCTION[type]} sj WHERE sj.${SNAPSHOT_COL[type]} = s.id) AS set_links
       FROM ${SNAPSHOT_TABLE[type]} s WHERE source_id = ?`, [purchaseId]);
  const other = type === 'sessions' ? SNAPSHOT_TABLE.fee : SNAPSHOT_TABLE.sessions;
  const { rows: stray } = await db.query<any>(`SELECT id FROM ${other} WHERE source_id = ?`, [purchaseId]);
  return { snapshot: snap[0] ?? null, stray: stray.length };
}

/** The purchase is its snapshot alone: no row in the other snapshot table, no Product Set. */
function expectWritten(p: Awaited<ReturnType<typeof pair>>) {
  expect(p.snapshot).not.toBeNull();
  expect(p.stray).toBe(0);
  expect(Number(p.snapshot.set_links)).toBe(0);
}

async function promotionCounts(purchaseId: number, type: 'sessions' | 'fee') {
  const parent = type === 'sessions' ? 'product_session_snapshot_id' : 'product_oneoff_snapshot_id';
  const { rows: snap } = await db.query<any>(
    `SELECT COUNT(*) n FROM product_promotion_snapshots pp
       JOIN ${SNAPSHOT_TABLE[type]} s ON s.id = pp.${parent}
      WHERE s.source_id = ? AND pp.source_purchase_promotion_id = pp.id`, [purchaseId]);
  return { snapshot: Number(snap[0].n) };
}

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Purchase Writer Gym');
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

describe('one writer for a one-time purchase (#2126 stage 5b)', () => {
  for (const type of ['fee', 'sessions'] as const) {
    it(`writes the ${SNAPSHOT_TABLE[type]} row, through draft, pay, completion and cancel`, async () => {
      const m = await member();
      const p = await product({ name: `Writer ${type} ${uniq()}`, amount: '80.00', type });
      const promo = await promotion({ name: `Writer promo ${uniq()}` });
      await grant(promo, p, type === 'sessions' ? 'session' : 'oneoff', 'percentage_discount', 50);

      // Save as draft: no payment, no event, Promotions frozen under the snapshot.
      const saved = await auth(request.post(base(m))).send({ product_id: p, promotion_ids: [promo], direct_discount_percent: 10, draft: true });
      expect(saved.status).toBe(201);
      const draftId = Number(saved.body.purchaseId);
      expectWritten(await pair(draftId, type));
      expect((await pair(draftId, type)).snapshot.status).toBe('draft');
      expect(await promotionCounts(draftId, type)).toEqual({ snapshot: 1 });

      // Pay the draft: the draft goes, the pending purchase is written with its event link.
      const paid = await auth(request.post(`${base(m)}/${draftId}/pay`)).send({});
      expect(paid.status).toBe(201);
      const purchaseId = Number(paid.body.purchaseId);
      const gone = await pair(draftId, type);
      expect(gone.snapshot).toBeNull();
      const pending = await pair(purchaseId, type);
      expectWritten(pending);
      expect(pending.snapshot.status).toBe('pending_payment');
      expect(pending.snapshot.member_product_id).toBe(purchaseId);
      expect(await promotionCounts(purchaseId, type)).toEqual({ snapshot: 1 });

      const { rows: req } = await db.query<any>(
        `SELECT pr.id, pr.billing_event_id FROM payment_requests pr
           JOIN ${TEST_PURCHASES} mp ON mp.payment_request_id = pr.id WHERE mp.id = ?`, [purchaseId]);
      const [junction, col] = EVENT_JUNCTION[type];
      const { rows: link } = await db.query<any>(
        `SELECT billing_event_id FROM ${junction} WHERE ${col} = ?`, [pending.snapshot.snapshot_id]);
      expect(link).toEqual([{ billing_event_id: req[0].billing_event_id }]);

      // The webhook completes it, once.
      expect((await pay(req[0].id)).status).toBe(200);
      const active = await pair(purchaseId, type);
      expectWritten(active);
      expect(active.snapshot.status).toBe('active');
      expect(active.snapshot.purchased_at).not.toBeNull();

      // Staff Cancel stamps the day; a repeat changes nothing.
      const cancel = await auth(request.post(`${base(m)}/${purchaseId}/cancel`)).send({});
      expect(cancel.status).toBe(200);
      const cancelled = await pair(purchaseId, type);
      expectWritten(cancelled);
      expect(cancelled.snapshot.cancelled_on).toBe(cancel.body.cancelled_on);
      const again = await auth(request.post(`${base(m)}/${purchaseId}/cancel`)).send({});
      expect(again.status).toBe(200);
      expectWritten(await pair(purchaseId, type));
    });
  }

  it('deletes a draft, its Promotions with it', async () => {
    const m = await member();
    const p = await product({ name: `Writer del ${uniq()}`, amount: '30.00' });
    const promo = await promotion({ name: `Writer del promo ${uniq()}` });
    await grant(promo, p, 'oneoff', 'percentage_discount', 50);
    const saved = await auth(request.post(base(m))).send({ product_id: p, promotion_ids: [promo], draft: true });
    const draftId = Number(saved.body.purchaseId);
    const del = await auth(request.delete(`${base(m)}/${draftId}`));
    expect(del.status).toBe(200);
    const gone = await pair(draftId, 'fee');
    expect(gone.snapshot).toBeNull();
    expect(await promotionCounts(draftId, 'fee')).toEqual({ snapshot: 0 });
  });

  it('takes every purchase id from the one allocator, unique across both snapshot tables (#2126 stage 5d-3)', async () => {
    const m = await member();
    const top = async () => Number((await db.query<any>(
      `SELECT GREATEST(
          COALESCE((SELECT MAX(source_id) FROM product_session_snapshots), 0),
          COALESCE((SELECT MAX(source_id) FROM product_oneoff_snapshots), 0)) AS top`)).rows[0].top);
    const before = await top();
    const draft = async (type: 'fee' | 'sessions') => {
      const p = await product({ name: `Writer id ${type} ${uniq()}`, amount: '20.00', type });
      const res = await auth(request.post(base(m))).send({ product_id: p, draft: true });
      expect(res.status).toBe(201);
      return Number(res.body.purchaseId);
    };
    const fee = await draft('fee');
    const sessions = await draft('sessions');
    expect(fee).toBeGreaterThan(before);
    expect(sessions).toBeGreaterThan(fee);

    // Each id is registered once, for the gym, and the snapshot carries it.
    const { rows } = await db.query<any>('SELECT id, gym_id FROM product_purchase_ids WHERE id IN (?, ?) ORDER BY id', [fee, sessions]);
    expect(rows).toEqual([{ id: fee, gym_id: gymId }, { id: sessions, gym_id: gymId }]);
    expectWritten(await pair(fee, 'fee'));
    expectWritten(await pair(sessions, 'sessions'));

    // A discarded draft's id is never handed out again.
    expect((await auth(request.delete(`${base(m)}/${sessions}`))).status).toBe(200);
    const next = await draft('sessions');
    expect(next).toBeGreaterThan(sessions);
  });

  it('takes a purchase Promotion id from its snapshot (#2126 stage 5d-4)', async () => {
    const m = await member();
    const top = async () => Number((await db.query<any>(
      'SELECT COALESCE(MAX(id), 0) AS top FROM product_promotion_snapshots')).rows[0].top);
    const before = await top();
    // Move the snapshot's sequence ahead, so the ids below are visibly the snapshot's own.
    await db.query(`ALTER TABLE product_promotion_snapshots AUTO_INCREMENT = ${before + 50}`);
    const ids: number[] = [];
    for (const type of ['fee', 'sessions'] as const) {
      const p = await product({ name: `Writer promo id ${type} ${uniq()}`, amount: '60.00', type });
      const promo = await promotion({ name: `Writer promo id ${uniq()}` });
      await grant(promo, p, type === 'sessions' ? 'session' : 'oneoff', 'percentage_discount', 50);
      const saved = await auth(request.post(base(m))).send({ product_id: p, promotion_ids: [promo], draft: true });
      expect(saved.status).toBe(201);
      const purchaseId = Number(saved.body.purchaseId);
      const parent = type === 'sessions' ? 'product_session_snapshot_id' : 'product_oneoff_snapshot_id';
      const { rows } = await db.query<any>(
        `SELECT pp.id, pp.source_purchase_promotion_id
           FROM product_promotion_snapshots pp
           JOIN ${SNAPSHOT_TABLE[type]} s ON s.id = pp.${parent}
          WHERE s.source_id = ?`, [purchaseId]);
      expect(rows).toHaveLength(1);
      const id = Number(rows[0].id);
      expect(Number(rows[0].source_purchase_promotion_id)).toBe(id);
      expect(id).toBeGreaterThan(before);
      ids.push(id);

      // The purchase list reports the application under that id.
      const list = await auth(request.get(`/members/${m}/products`));
      expect(list.status).toBe(200);
      const item = (list.body.items as any[]).find((i) => Number(i.id) === purchaseId);
      expect(item.promotions.map((a: any) => Number(a.id))).toEqual([id]);
    }
    expect(ids[1]).toBeGreaterThan(ids[0]);
  });

  it("cannot cancel another member's purchase (the snapshot lock is scoped to the member)", async () => {
    const owner = await member();
    const other = await member();
    const p = await product({ name: `Writer scope ${uniq()}`, amount: '30.00' });
    const saved = await auth(request.post(base(owner))).send({ product_id: p, draft: true });
    const draftId = Number(saved.body.purchaseId);
    expect((await auth(request.delete(`${base(other)}/${draftId}`))).status).toBe(404);
    expect((await pair(draftId, 'fee')).snapshot).not.toBeNull();
  });
});
