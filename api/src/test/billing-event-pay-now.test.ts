// #3442: Pay now on a Billing Event (Failed, Pending payment, Scheduled).
// Integration — the online provider is mocked: it cannot run here, and the
// mock proves the manual methods never call it.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request,
  ensureTestProductSet, legacyAssignmentQuery, legacyChildQuery,
} from './helpers';

const executeRecurring = vi.fn();
const createPaymentRequest = vi.fn();
vi.mock('../payments', () => ({
  getPaymentProvider: () => ({ executeRecurring, createPaymentRequest }),
}));

let gymId: string;
let otherGymId: string;

beforeAll(async () => {
  gymId = await createTestGym('BE PayNow Gym');
  otherGymId = await createTestGym('BE PayNow Other');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
});

beforeEach(() => {
  executeRecurring.mockReset();
  createPaymentRequest.mockReset();
  createPaymentRequest.mockImplementation(async () => ({ providerOrderId: `prov-${Math.random().toString(36).slice(2)}` }));
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const isoDay = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

type Kind = 'failed' | 'scheduled' | 'pending' | 'paid';

async function createEvent(kind: Kind, opts: { billingDate?: string; cartStatus?: string } = {}) {
  const { rows: ct } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  const { insertId: memberId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Pay Now', ?)`,
    [gymId, `pay-now-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`],
  );
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `PN-Plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`],
  );
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  const { insertId: membershipId } = await legacyAssignmentQuery(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', '2000-01-01', '40.00')`, [gymId, memberId, planId]);
  await legacyChildQuery(
    `INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)`,
    [gymId, membershipId, memberId]);
  const setId = await ensureTestProductSet(gymId, memberId, membershipId);

  let purchaseId: number | null = null;
  if (opts.cartStatus) {
    const { insertId } = await db.query(
      `INSERT INTO purchases (gym_id, owner_member_id, status, name, created_at, created_by)
       VALUES (?, ?, ?, 'Test cart', UTC_TIMESTAMP(), 'Test')`, [gymId, memberId, opts.cartStatus]);
    purchaseId = Number(insertId);
  }

  const eventType = kind === 'failed' ? 'failed_billing' : kind === 'scheduled' ? 'charge_created' : 'payment_recorded';
  const { insertId: billingEventId } = await db.query(
    `INSERT INTO billing_events
       (gym_id, product_set_id, member_id, event_type, amount, charge_type_id, source, billing_date, is_scheduled, purchase_id)
     VALUES (?, ?, ?, ?, '40.00', ?, 'system', ?, ?, ?)`,
    [gymId, setId, memberId, eventType, ct[0].id, opts.billingDate ?? isoDay(0), kind === 'scheduled' ? 1 : 0, purchaseId]);

  const txStatus = kind === 'failed' ? 'failed' : kind === 'pending' ? 'pending' : kind === 'paid' ? 'completed' : null;
  if (txStatus) {
    await db.query(
      `INSERT INTO payment_requests
         (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider, provider_order,
          source, method, created_at)
       VALUES (?, ?, '40.00', 'EUR', ?, ?, ?, ?, UUID(), ?, ?, UTC_TIMESTAMP())`,
      [gymId, memberId, ct[0].id, billingEventId, txStatus,
        kind === 'paid' ? 'manual' : 'monei', kind === 'paid' ? 'manual' : 'billing_run', kind === 'paid' ? 'cash' : 'provider']);
  }
  return { memberId, billingEventId: Number(billingEventId), setId };
}

const post = (id: number, body: object, gym = gymId) =>
  request.post(`/payments/billing-events/${id}/pay-now`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send(body);
const get = (id: number, gym = gymId) =>
  request.get(`/payments/billing-events/${id}/pay-now`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const attempts = async (id: number) =>
  (await db.query<any>('SELECT id, status, method, amount, billing_event_id FROM payment_requests WHERE billing_event_id = ? ORDER BY id', [id])).rows;
const event = async (id: number) =>
  (await db.query<any>('SELECT event_type, is_scheduled FROM billing_events WHERE id = ?', [id])).rows[0];
const eventCount = async (memberId: number) =>
  Number((await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE member_id = ?', [memberId])).rows[0].n);
const listRow = async (id: number, memberId: number) => {
  const res = await request.get(`/payments/billing-events?member_id=${memberId}&limit=50`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
  return (res.body.items as any[]).find((r) => r.id === id);
};

describe('eligibility', () => {
  it('is offered on Failed, Pending payment and Scheduled events, and not on a paid one', async () => {
    for (const kind of ['failed', 'pending', 'scheduled'] as const) {
      const f = await createEvent(kind, { billingDate: kind === 'scheduled' ? isoDay(10) : undefined });
      const row = await listRow(f.billingEventId, f.memberId);
      expect(row?.can_pay_now, kind).toBe(true);
      expect(row?.pay_now_block, kind).toBeNull();
    }
    const paid = await createEvent('paid');
    expect((await listRow(paid.billingEventId, paid.memberId))?.can_pay_now).toBe(false);
  });

  it('lists the catalogue methods, Members App, Cash and Card usable', async () => {
    const f = await createEvent('failed');
    const res = await get(f.billingEventId);
    expect(res.status).toBe(200);
    const byCode = Object.fromEntries((res.body.payment_methods as any[]).map((m) => [m.code, m.available]));
    expect(byCode).toMatchObject({ members_app: true, cash: true, card: true, monei: false });
  });

  it('a paid event can never be charged again by this action', async () => {
    const f = await createEvent('paid');
    expect((await post(f.billingEventId, { method: 'cash' })).status).toBe(409);
    expect((await post(f.billingEventId, { method: 'members_app' })).status).toBe(409);
    expect((await attempts(f.billingEventId))).toHaveLength(1);
    expect(createPaymentRequest).not.toHaveBeenCalled();
  });

  it('refuses an unsupported or unknown method', async () => {
    const f = await createEvent('failed');
    expect((await post(f.billingEventId, { method: 'monei' })).status).toBe(400);
    expect((await post(f.billingEventId, { method: 'nope' })).status).toBe(400);
    expect((await attempts(f.billingEventId))).toHaveLength(1);
  });

  it('is tenant-isolated and needs authentication', async () => {
    const f = await createEvent('failed');
    expect((await post(f.billingEventId, { method: 'cash' }, otherGymId)).status).toBe(404);
    expect((await get(f.billingEventId, otherGymId)).status).toBe(404);
    const unauth = await request.post(`/payments/billing-events/${f.billingEventId}/pay-now`).set('x-gym-id', gymId).send({ method: 'cash' });
    expect(unauth.status).toBe(401);
  });
});

describe('Cash / external card terminal', () => {
  it('settles a failed event on the same event, no provider call', async () => {
    const f = await createEvent('failed');
    const res = await post(f.billingEventId, { method: 'cash' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ outcome: 'paid', new_status: 'paid', method: 'cash', amount: '40.00' });
    expect((await attempts(f.billingEventId)).at(-1)).toMatchObject({ status: 'completed', method: 'cash', amount: '40.00' });
    expect(await eventCount(f.memberId)).toBe(1);
    expect(executeRecurring).not.toHaveBeenCalled();
    expect(createPaymentRequest).not.toHaveBeenCalled();
    expect((await listRow(f.billingEventId, f.memberId))?.can_pay_now).toBe(false);
  });

  it('settles a future Scheduled obligation early and takes it off the schedule', async () => {
    const f = await createEvent('scheduled', { billingDate: isoDay(12) });
    const res = await post(f.billingEventId, { method: 'card' });
    expect(res.status).toBe(201);
    expect((await attempts(f.billingEventId)).at(-1)).toMatchObject({ status: 'completed', method: 'card_terminal' });
    expect(await event(f.billingEventId)).toMatchObject({ is_scheduled: 0, event_type: 'recurring_payment' });
    expect(await eventCount(f.memberId)).toBe(1);
    // The nightly run, once the date comes, has nothing left to collect on it.
    const { executeDueScheduledEvents } = await import('../api/scheduled-event-execution');
    await executeDueScheduledEvents({ today: isoDay(13) });
    expect(executeRecurring).not.toHaveBeenCalled();
    expect((await attempts(f.billingEventId))).toHaveLength(1);
  });

  it('settles once under concurrent submissions', async () => {
    const f = await createEvent('failed');
    const results = await Promise.all([1, 2, 3].map(() => post(f.billingEventId, { method: 'cash' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await attempts(f.billingEventId)).filter((a: any) => a.status === 'completed')).toHaveLength(1);
  });

  it('refuses while a provider charge of the event is unresolved', async () => {
    const f = await createEvent('pending'); // the pending attempt was submitted to the provider (no page token)
    const res = await post(f.billingEventId, { method: 'cash' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('payment_unresolved');
    expect((await attempts(f.billingEventId)).some((a: any) => a.status === 'completed')).toBe(false);
  });
});

describe('Members App', () => {
  it('raises a checkout on the same event and reuses it instead of duplicating', async () => {
    const f = await createEvent('failed');
    const first = await post(f.billingEventId, { method: 'members_app' });
    expect(first.status).toBe(201);
    expect(first.body.outcome).toBe('checkout');
    expect(first.body.checkoutUrl).toContain('checkout?token=');
    const second = await post(f.billingEventId, { method: 'members_app' });
    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.payment_request_id).toBe(first.body.payment_request_id);
    expect(createPaymentRequest).toHaveBeenCalledTimes(1);
    const pending = (await attempts(f.billingEventId)).filter((a: any) => a.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].billing_event_id).toBe(f.billingEventId);
    expect(await eventCount(f.memberId)).toBe(1);
  });

  it('concurrent submissions leave one live link', async () => {
    const f = await createEvent('scheduled', { billingDate: isoDay(5) });
    await Promise.all([1, 2, 3].map(() => post(f.billingEventId, { method: 'members_app' })));
    expect((await attempts(f.billingEventId)).filter((a: any) => a.status === 'pending')).toHaveLength(1);
  });

  it('a link nobody opened does not block a cash settlement, and is closed by it', async () => {
    const f = await createEvent('failed');
    const link = await post(f.billingEventId, { method: 'members_app' });
    const cash = await post(f.billingEventId, { method: 'cash' });
    expect(cash.status).toBe(201);
    const rows = await attempts(f.billingEventId);
    expect(rows.find((a: any) => a.id === link.body.payment_request_id)?.status).toBe('expired');
    expect(rows.filter((a: any) => a.status === 'completed')).toHaveLength(1);
  });

  it('the webhook completion of a scheduled event takes it off the schedule', async () => {
    const f = await createEvent('scheduled', { billingDate: isoDay(8) });
    const link = await post(f.billingEventId, { method: 'members_app' });
    const { rows } = await db.query<any>('SELECT provider_order FROM payment_requests WHERE id = ?', [link.body.payment_request_id]);
    const { settlePaymentRequest } = await import('../api/payment-settlement');
    const log = { info: () => {}, warn: () => {}, error: () => {} } as any;
    await settlePaymentRequest({
      orderId: rows[0].provider_order, status: 'completed', providerRef: 'ref-1', providerStatus: 'SUCCEEDED',
      paymentToken: null, sequenceId: null, cardLast4: null, cardBrand: null,
    } as any, { via: 'webhook', log });
    expect(await event(f.billingEventId)).toMatchObject({ is_scheduled: 0, event_type: 'recurring_payment' });
    expect((await post(f.billingEventId, { method: 'cash' })).status).toBe(409);
  });
});

describe('cart cancelled or expired', () => {
  it('blocks a Pending payment event whose cart was cancelled, writing nothing', async () => {
    const f = await createEvent('pending', { cartStatus: 'cancelled' });
    const row = await listRow(f.billingEventId, f.memberId);
    expect(row).toMatchObject({ can_pay_now: true, pay_now_block: 'cart_cancelled' });
    expect((await get(f.billingEventId)).body.error).toBe('cart_cancelled');
    for (const method of ['cash', 'members_app']) {
      const res = await post(f.billingEventId, { method });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('cart_cancelled');
    }
    expect(await attempts(f.billingEventId)).toHaveLength(1);
    expect(createPaymentRequest).not.toHaveBeenCalled();
  });

  it('blocks a Pending payment event whose checkout expired', async () => {
    const f = await createEvent('pending', { cartStatus: 'pending_payment' });
    await db.query('UPDATE billing_events SET expired_at = UTC_TIMESTAMP() WHERE id = ?', [f.billingEventId]);
    expect((await listRow(f.billingEventId, f.memberId))?.pay_now_block).toBe('cart_expired');
    const res = await post(f.billingEventId, { method: 'card' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cart_expired');
    expect(await attempts(f.billingEventId)).toHaveLength(1);
  });
});
