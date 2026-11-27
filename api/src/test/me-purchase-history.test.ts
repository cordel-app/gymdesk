// #3443 — the Members App's Purchases tab: `GET /me/purchase-history`. Integration against real
// MySQL: purchases, snapshots, Billing Events and attempts are seeded directly (the action under
// test is the read), the member is the caller's own and never named by the request.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestFamily, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const OWNER_CLERK = `mph-owner-${uniq()}`;
const CHILD_CLERK = `mph-child-${uniq()}`;
const OTHER_CLERK = `mph-other-${uniq()}`;
const CART_CLERK = `mph-cart-${uniq()}`;

let owner: number;
let child: number;
let other: number;
let pOld: number;
let pPaid: number;
let pCancelled: number;
let pCart: number;
let pOther: number;

function asMember(clerk: string, path: string) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return request.get(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
}

async function member(name: string, clerk: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, name, `mph-${uniq()}@test.com`, clerk]);
  return Number(insertId);
}

async function purchase(ownerId: number, status: string, createdAt: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO purchases (gym_id, owner_member_id, status, name, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [gymId, ownerId, status, `Gym - Purchase - ${createdAt}`, createdAt, 'Front Desk Person']);
  return Number(insertId);
}

async function oneoff(buyerId: number, purchaseId: number, name: string, quantity = 1): Promise<void> {
  const { insertId: productId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'once', 'active', 'public', 'EUR', 99, 'inclusive')`, [gymId, `${name} ${uniq()}`]);
  await db.query(
    `INSERT INTO product_oneoff_snapshots
       (gym_id, member_id, product_id, source_id, status, product_name, product_type, billing_frequency, quantity,
        unit_price, purchase_id)
     VALUES (?, ?, ?, ?, 'active', ?, 'fee', 'once', ?, 10, ?)`,
    [gymId, buyerId, productId, Math.floor(Math.random() * 1e9), name, quantity, purchaseId]);
}

async function event(memberId: number, purchaseId: number, amount: number, cancelled = false): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, name, purchase_id, cancelled_at)
     VALUES (?, ?, 'product_purchase', 'customer', ?, ?, ?, ${cancelled ? 'UTC_TIMESTAMP()' : 'NULL'})`,
    [gymId, memberId, amount, `Event ${uniq()}`, purchaseId]);
  return Number(insertId);
}

async function attempt(memberId: number, eventId: number, status: string, providerStatus: string | null): Promise<void> {
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, member_id, billing_event_id, amount, source, status, method, payment_method_name, provider_status,
        completed_at, transaction_type)
     VALUES (?, ?, ?, 20, 'admin', ?, 'provider', 'Visa', ?, ${status === 'completed' ? 'UTC_TIMESTAMP()' : 'NULL'}, 'payment')`,
    [gymId, memberId, eventId, status, providerStatus]);
}

beforeAll(async () => {
  gymId = await createTestGym('Purchase history');
  await createTestMembership(gymId, 'member', OWNER_CLERK);
  await createTestMembership(gymId, 'member', CHILD_CLERK);
  await createTestMembership(gymId, 'member', OTHER_CLERK);
  await createTestMembership(gymId, 'member', CART_CLERK);
  owner = await member('Owner', OWNER_CLERK);
  child = await member('Child', CHILD_CLERK);
  other = await member('Other', OTHER_CLERK);
  await createTestFamily(gymId, owner, [child]);

  pOld = await purchase(owner, 'completed', '2026-10-01 10:00:00');
  await oneoff(owner, pOld, 'Old towel');

  // Paid after a failed attempt: two attempts must not duplicate the purchase.
  pPaid = await purchase(owner, 'completed', '2026-11-01 10:00:00');
  await oneoff(owner, pPaid, 'Shirt', 2);
  const e = await event(owner, pPaid, 20);
  await attempt(owner, e, 'failed', 'FAILED');
  await attempt(owner, e, 'completed', 'SUCCEEDED');

  // Cancelled with its cancelled event: still listed as history.
  pCancelled = await purchase(owner, 'cancelled', '2026-11-10 10:00:00');
  await oneoff(owner, pCancelled, 'Water');
  await event(owner, pCancelled, 5, true);

  // In cart: no Billing Event at all.
  pCart = await purchase(owner, 'in_cart', '2026-11-20 10:00:00');
  await oneoff(owner, pCart, 'Bar');

  pOther = await purchase(other, 'completed', '2026-11-21 10:00:00');
  await oneoff(other, pOther, 'Not yours');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/purchase-history (#3443)', () => {
  it('requires authentication', async () => {
    const res = await request.get('/me/purchase-history').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it("lists the caller's own purchases newest first, each once, with its own status", async () => {
    const res = await asMember(OWNER_CLERK, '/me/purchase-history');
    expect(res.status).toBe(200);
    expect(res.body.items.map((p: any) => p.id)).toEqual([pCart, pCancelled, pPaid, pOld]);
    expect(res.body.total).toBe(4);
    const byId = new Map(res.body.items.map((p: any) => [p.id, p]));
    expect((byId.get(pCart) as any).status).toBe('in_cart');
    expect((byId.get(pCart) as any).billing_events).toEqual([]);
    expect((byId.get(pCancelled) as any).status).toBe('cancelled');
    const paid = byId.get(pPaid) as any;
    expect(paid.status).toBe('completed');
    expect(paid.products).toEqual([expect.objectContaining({ name: 'Shirt', quantity: 2, kind: 'oneoff' })]);
    expect(paid.total_amount).toBe('20.00');
    expect(paid.billing_events).toHaveLength(1);
    expect(paid.billing_events[0].status).toBe('paid');
    expect(paid.billing_events[0].payment_method_name).toBe('Visa');
  });

  it('leaves out the staff-only facts', async () => {
    const res = await asMember(OWNER_CLERK, '/me/purchase-history');
    const item = res.body.items[0];
    for (const key of ['created_by', 'modified_by', 'modified_at', 'channel']) expect(item).not.toHaveProperty(key);
    expect(JSON.stringify(res.body)).not.toContain('Front Desk Person');
    expect(res.body.items.every((p: any) => p.id !== pOther)).toBe(true);
  });

  it('pages with limit and offset', async () => {
    const first = await asMember(OWNER_CLERK, '/me/purchase-history?limit=2');
    expect(first.body.items.map((p: any) => p.id)).toEqual([pCart, pCancelled]);
    const second = await asMember(OWNER_CLERK, '/me/purchase-history?limit=2&offset=2');
    expect(second.body.items.map((p: any) => p.id)).toEqual([pPaid, pOld]);
    expect(second.body.total).toBe(4);
  });

  it('refuses a limit out of range', async () => {
    expect((await asMember(OWNER_CLERK, '/me/purchase-history?limit=0')).status).toBe(400);
    expect((await asMember(OWNER_CLERK, '/me/purchase-history?limit=51')).status).toBe(400);
    expect((await asMember(OWNER_CLERK, '/me/purchase-history?offset=-1')).status).toBe(400);
  });

  it("is the Family Owner's, as Payments is", async () => {
    const res = await asMember(CHILD_CLERK, '/me/purchase-history');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('family_owner_only');
  });

  it('shows another member only their own purchases', async () => {
    const res = await asMember(OTHER_CLERK, '/me/purchase-history');
    expect(res.status).toBe(200);
    expect(res.body.items.map((p: any) => p.id)).toEqual([pOther]);
  });
});

describe('GET /me/purchase-history — the header amount (#3495)', () => {
  let cartOwner: number;
  let cart: number;
  let paidNoEvent: number;

  beforeAll(async () => {
    cartOwner = await member('Cart owner', CART_CLERK);
    // A paid purchase with no Billing Event: no recorded amount.
    paidNoEvent = await purchase(cartOwner, 'completed', '2026-11-02 10:00:00');
    await oneoff(cartOwner, paidNoEvent, 'Gift');
    // The open cart: two standalone In Cart lines (12.50 + 2 × 4.00), created now so it is live.
    const { insertId } = await db.query(
      `INSERT INTO purchases (gym_id, owner_member_id, status, name, created_by)
       VALUES (?, ?, 'in_cart', 'Gym - Purchase - now', 'Cart owner')`, [gymId, cartOwner]);
    cart = Number(insertId);
    for (const [name, price, qty] of [['Bottle', 12.5, 1], ['Bar', 4, 2]] as const) {
      const { insertId: productId } = await db.query(
        `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
         VALUES (?, ?, 'fee', 'once', 'active', 'public', 'EUR', ?, 'inclusive')`, [gymId, `${name} ${uniq()}`, price]);
      await db.query(
        `INSERT INTO product_oneoff_snapshots
           (gym_id, member_id, product_id, source_id, status, product_name, product_type, billing_frequency, quantity,
            unit_price, purchase_id)
         VALUES (?, ?, ?, ?, 'in_cart', ?, 'fee', 'once', ?, ?, ?)`,
        [gymId, cartOwner, productId, Math.floor(Math.random() * 1e9), name, qty, price, cart]);
    }
  });

  it("reports an in-cart purchase's Initial Payment, the figure its checkout charges", async () => {
    const res = await asMember(CART_CLERK, '/me/purchase-history');
    expect(res.status).toBe(200);
    const byId = new Map(res.body.items.map((p: any) => [p.id, p]));
    const open = byId.get(cart) as any;
    expect(open.status).toBe('in_cart');
    expect(open.total_amount).toBeNull();
    expect(open.initial_payment_amount).toBe('20.50');
  });

  it('reports no Initial Payment for a purchase outside the cart', async () => {
    const res = await asMember(CART_CLERK, '/me/purchase-history');
    const paid = res.body.items.find((p: any) => p.id === paidNoEvent);
    expect(paid.status).toBe('completed');
    expect(paid.total_amount).toBeNull();
    expect(paid.initial_payment_amount).toBeNull();
  });
});
