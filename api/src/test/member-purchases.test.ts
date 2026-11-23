// #3273 — the Member card's Purchases tab: `GET /payments/purchases?member_id=`.
// Integration against real MySQL. Purchases, snapshots, Billing Events and attempts are seeded
// directly (the action under test is the read); every relationship is the explicit `purchase_id`
// one of #3251, so a row that is not linked to a purchase must never appear under it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymA: string;
let gymB: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const get = (gymId: string, path: string) =>
  request.get(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `${uniq()}@purchases.test`]);
  return Number(insertId);
}

async function purchase(gymId: string, ownerId: number, status: string, createdAt: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO purchases (gym_id, owner_member_id, status, name, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [gymId, ownerId, status, `${createdAt.replace(' ', 'T')}Z`, createdAt, 'Tester']);
  return Number(insertId);
}

async function product(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'once', 'active', 'public', 'EUR', 10, 'inclusive')`, [gymId, `${name} ${uniq()}`]);
  return Number(insertId);
}

async function planSnapshot(gymId: string, ownerId: number, purchaseId: number, planName: string): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gymId, planName]);
  const { insertId } = await db.query(
    `INSERT INTO plan_snapshots (gym_id, member_id, membership_plan_id, status, starts_at, purchase_id)
     VALUES (?, ?, ?, 'active', '2026-11-01', ?)`, [gymId, ownerId, planId, purchaseId]);
  return Number(insertId);
}

async function standaloneOneoff(gymId: string, buyerId: number, purchaseId: number, name: string,
  assignedTo: number | null = null): Promise<number> {
  const pid = await product(gymId, name);
  const { insertId } = await db.query(
    `INSERT INTO product_oneoff_snapshots
       (gym_id, member_id, product_id, source_id, status, product_name, product_type, billing_frequency, quantity,
        unit_price, assigned_member_id, purchase_id)
     VALUES (?, ?, ?, ?, 'active', ?, 'fee', 'once', 2, 10, ?, ?)`,
    [gymId, buyerId, pid, Math.floor(Math.random() * 1e9), name, assignedTo, purchaseId]);
  return Number(insertId);
}

async function event(gymId: string, memberId: number, purchaseId: number | null, amount = 20): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, name, purchase_id)
     VALUES (?, ?, 'product_purchase', 'customer', ?, ?, ?)`,
    [gymId, memberId, amount, `Event ${uniq()}`, purchaseId]);
  return Number(insertId);
}

async function attempt(gymId: string, memberId: number, eventId: number, a: {
  status: string; created: string; completed?: string | null; method?: string; methodName?: string;
  providerStatus?: string | null; amount?: number;
}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO payment_requests
       (gym_id, member_id, billing_event_id, amount, source, status, method, payment_method_name, payment_method_code,
        provider_status, created_at, completed_at, transaction_type)
     VALUES (?, ?, ?, ?, 'admin', ?, ?, ?, ?, ?, ?, ?, 'payment')`,
    [gymId, memberId, eventId, a.amount ?? 20, a.status, a.method ?? 'provider', a.methodName ?? null,
      a.methodName ? a.methodName.toLowerCase().replace(/\s+/g, '_') : null, a.providerStatus ?? null,
      a.created, a.completed ?? null]);
  return Number(insertId);
}

let owner: number;
let child: number;
let outsider: number;
let pPlan: number;
let pRetry: number;
let pCart: number;
let pChildOnly: number;
let pOutsider: number;
let pRefund: number;

beforeAll(async () => {
  gymA = await createTestGym('Purchases tab A');
  gymB = await createTestGym('Purchases tab B');
  await createTestMembership(gymA, 'admin');
  await createTestMembership(gymB, 'admin');

  owner = await member(gymA, 'Family Owner');
  child = await member(gymA, 'Family Child');
  outsider = await member(gymA, 'Somebody Else');

  // 1) A plan for the child, paid by the owner, plus a standalone Product for the owner.
  pPlan = await purchase(gymA, owner, 'completed', '2026-11-01 10:00:00');
  const snap = await planSnapshot(gymA, owner, pPlan, `Duo ${uniq()}`);
  await db.query('INSERT INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner) VALUES (?, ?, ?, 0)',
    [gymA, snap, child]);
  const included = await product(gymA, 'Towel');
  await db.query(
    `INSERT INTO plan_session_snapshots (gym_id, plan_snapshot_id, product_id, quantity, item_name, item_type, assigned_member_id)
     VALUES (?, ?, ?, 4, 'Towel', 'fee', ?)`, [gymA, snap, included, child]);
  await standaloneOneoff(gymA, owner, pPlan, 'Towel'); // same name, standalone: must stay separate
  const ePlan = await event(gymA, owner, pPlan, 50);
  await attempt(gymA, owner, ePlan, {
    status: 'completed', created: '2026-11-01 10:01:00', completed: '2026-11-01 10:02:00',
    method: 'cash', methodName: 'Cash',
  });

  // 2) Failed then successful attempt.
  pRetry = await purchase(gymA, owner, 'completed', '2026-11-05 09:00:00');
  await standaloneOneoff(gymA, owner, pRetry, 'Shirt');
  const eRetry = await event(gymA, owner, pRetry);
  await attempt(gymA, owner, eRetry, {
    status: 'failed', created: '2026-11-05 09:01:00', methodName: 'Visa', providerStatus: 'FAILED',
  });
  await attempt(gymA, owner, eRetry, {
    status: 'completed', created: '2026-11-06 09:01:00', completed: '2026-11-06 09:03:00',
    methodName: 'Mastercard', providerStatus: 'SUCCEEDED',
  });
  // A later failed attempt never replaces the successful one.
  await attempt(gymA, owner, eRetry, {
    status: 'failed', created: '2026-11-07 09:01:00', methodName: 'Amex', providerStatus: 'FAILED',
  });

  // 3) In cart: no event yet. An unrelated event of the same member must not attach to it.
  pCart = await purchase(gymA, owner, 'in_cart', '2026-11-20 12:00:00');
  await standaloneOneoff(gymA, owner, pCart, 'Water');
  const unrelated = await event(gymA, owner, null);
  await attempt(gymA, owner, unrelated, {
    status: 'completed', created: '2026-11-20 12:30:00', completed: '2026-11-20 12:31:00', methodName: 'Cash',
  });

  // 4) Owned by the owner, but the child is its only beneficiary (assigned Product).
  pChildOnly = await purchase(gymA, owner, 'cancelled', '2026-11-10 08:00:00');
  await standaloneOneoff(gymA, owner, pChildOnly, 'Locker', child);

  // 5) Somebody else's purchase.
  pOutsider = await purchase(gymA, outsider, 'completed', '2026-11-15 08:00:00');
  await standaloneOneoff(gymA, outsider, pOutsider, 'Gloves');

  // 6) Refunded in full.
  pRefund = await purchase(gymA, owner, 'completed', '2026-11-12 08:00:00');
  await standaloneOneoff(gymA, owner, pRefund, 'Bag');
  const eRefund = await event(gymA, owner, pRefund);
  const paid = await attempt(gymA, owner, eRefund, {
    status: 'completed', created: '2026-11-12 08:01:00', completed: '2026-11-12 08:02:00',
    methodName: 'Visa', providerStatus: 'SUCCEEDED',
  });
  await db.query(
    `INSERT INTO payment_requests (gym_id, member_id, amount, source, status, method, transaction_type,
       refund_of_payment_request_id, created_at, completed_at)
     VALUES (?, ?, 20, 'admin', 'completed', 'provider', 'refund', ?, '2026-11-13 08:00:00', '2026-11-13 08:00:00')`,
    [gymA, owner, paid]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const list = async (memberId: number, gymId = gymA) => {
  const res = await get(gymId, `/payments/purchases?member_id=${memberId}`);
  expect(res.status).toBe(200);
  return res.body as { items: any[]; total: number };
};

describe('GET /payments/purchases (#3273)', () => {
  it('lists the owner\'s purchases from `purchases`, newest first, every status, once each', async () => {
    const body = await list(owner);
    expect(body.items.map((p) => p.id)).toEqual([pCart, pRefund, pChildOnly, pRetry, pPlan]);
    expect(body.total).toBe(5);
    expect(body.items.map((p) => p.status)).toEqual(['in_cart', 'completed', 'cancelled', 'completed', 'completed']);
    // #3270's name basis, the creation instant, is reported for the Admin to compose the label.
    expect(body.items[0].name).toBe('2026-11-20T12:00:00Z');
    expect(body.items.find((p) => p.id === pOutsider)).toBeUndefined();
  });

  it('lists a purchase for a beneficiary who does not own it, without duplicating it', async () => {
    const body = await list(child);
    // pPlan: plan beneficiary + plan line assignee (two matches, one row). pChildOnly: assigned Product.
    expect(body.items.map((p) => p.id)).toEqual([pChildOnly, pPlan]);
    const plan = body.items.find((p) => p.id === pPlan);
    expect(plan.owner).toEqual({ id: owner, name: 'Family Owner' });
  });

  it('groups a plan\'s included Products under it and keeps standalone Products apart', async () => {
    const p = (await list(owner)).items.find((x) => x.id === pPlan);
    expect(p.plans).toHaveLength(1);
    expect(p.plans[0].beneficiaries).toEqual([{ id: child, name: 'Family Child' }]);
    expect(p.plans[0].products).toEqual([
      expect.objectContaining({ kind: 'session', name: 'Towel', quantity: 4, beneficiary: { id: child, name: 'Family Child' } }),
    ]);
    expect(p.products).toEqual([
      expect.objectContaining({ kind: 'oneoff', name: 'Towel', quantity: 2, beneficiary: { id: owner, name: 'Family Owner' } }),
    ]);
  });

  it('reads the payment of the purchase\'s own Billing Event', async () => {
    const p = (await list(owner)).items.find((x) => x.id === pPlan);
    expect(p.billing_events).toHaveLength(1);
    expect(p.billing_events[0]).toMatchObject({
      status: 'paid', payment_method_name: 'Cash', payment_status: 'completed',
      paid_at: '2026-11-01T10:02:00.000Z', attempt_count: 1,
    });
  });

  it('shows the successful attempt after a failed one, not a later failure', async () => {
    const e = (await list(owner)).items.find((x) => x.id === pRetry).billing_events[0];
    expect(e).toMatchObject({
      payment_method_name: 'Mastercard', payment_status: 'completed',
      paid_at: '2026-11-06T09:03:00.000Z', attempt_count: 3,
    });
  });

  it('has no event and no payment date for a purchase still in the cart', async () => {
    const p = (await list(owner)).items.find((x) => x.id === pCart);
    expect(p.billing_events).toEqual([]);
  });

  it('reports a refunded payment as refunded, keeping its payment date', async () => {
    const e = (await list(owner)).items.find((x) => x.id === pRefund).billing_events[0];
    expect(e).toMatchObject({ payment_status: 'refunded', payment_method_name: 'Visa', paid_at: '2026-11-12T08:02:00.000Z' });
  });

  it('isolates gyms: another gym\'s member is a 404 and sees none of these purchases', async () => {
    expect((await get(gymB, `/payments/purchases?member_id=${owner}`)).status).toBe(404);
    const other = await member(gymB, 'Gym B member');
    expect((await list(other, gymB)).items).toEqual([]);
  });

  it('requires authentication, a member_id, and PAYMENTS read access', async () => {
    expect((await request.get(`/payments/purchases?member_id=${owner}`).set('x-gym-id', gymA)).status).toBe(401);
    expect((await get(gymA, '/payments/purchases')).status).toBe(400);

    const trainer = `trainer-${uniq()}`;
    await createTestMembership(gymA, 'trainer_performance', trainer);
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: trainer } as any);
    expect((await get(gymA, `/payments/purchases?member_id=${owner}`)).status).toBe(403);

    const asMember = `member-${uniq()}`;
    await createTestMembership(gymA, 'member', asMember);
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: asMember } as any);
    expect((await get(gymA, `/payments/purchases?member_id=${owner}`)).status).toBe(403);
  });
});
