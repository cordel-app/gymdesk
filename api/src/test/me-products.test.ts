// #1121 stages 1 and 2 — `GET /me/products`, the member's own read of the gym's
// Product catalogue, and `POST /me/products/:id/purchase`, how they buy one.
//
// Integration, not unit: what is under test is **which rows a member is shown**,
// that the catalogue is their gym's alone, and that a purchase moves the rows it
// should — the `member_products` row, its `payment_requests` row and, once the
// provider confirms, the Billing Event. What each row *says*, and how the
// Members App words it, is asserted in `member-products.unit.test.ts` and
// `member-product-purchase.unit.test.ts`, where both halves are pure.
//
// Only the provider's `createPaymentRequest` is stubbed, so no HTTP reaches
// Monei; the webhook still verifies a real Monei signature. Fixtures are
// inserted directly; the HTTP API is used only for the action under test
// (CLAUDE.md).

import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const ROOT = '/me/products';
const MONEI_WEBHOOK_SECRET = 'test-1121-webhook-secret';

// Spread the real module so every *other* consumer of `../payments` that app.ts
// pulls in keeps its own exports, and keep `parseWebhook` real so the webhook
// below is signature-verified like a live one.
const providerCalls = vi.hoisted(() => ({
  createPaymentRequest: [] as Array<{ orderId: string; amount: number; currency: string; description?: string }>,
}));
vi.mock('../payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../payments')>();
  return {
    ...actual,
    getPaymentProvider: () => {
      const real = actual.getPaymentProvider();
      return {
        parseWebhook: real.parseWebhook.bind(real),
        createPaymentRequest: async (params: any) => {
          providerCalls.createPaymentRequest.push(params);
          return { providerOrderId: `monei-${params.orderId}`, checkoutUrl: 'https://pay.test/x' };
        },
      };
    },
  };
});

let gymId: string;

// `members.clerk_user_id` is globally UNIQUE (migration 003), so this file
// brings its own Clerk ids rather than claiming the shared `TEST_USER_ID` row.
const MEMBER_CLERK = `mep-member-${Date.now()}`;

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

interface ItemOpts {
  name: string;
  type?: 'fee' | 'sessions' | 'service' | 'other';
  status?: 'active' | 'inactive';
  enrollment?: 'public' | 'staff_only';
  amount?: string | null;
  frequency?: string | null;
  units?: number | null;
  isSystem?: 0 | 1;
  taxRateId?: number | null;
  description?: string | null;
  deleted?: boolean;
}

async function createItem(gid: string, opts: ItemOpts): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, description, type, units, billing_frequency, status,
        enrollment_status, is_system, currency, amount, tax_rate_id, tax_behavior,
        deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, 'inclusive', ?)`,
    [
      gid, opts.name, opts.description ?? null, opts.type ?? 'fee', opts.units ?? null,
      opts.frequency ?? null, opts.status ?? 'active', opts.enrollment ?? 'public',
      opts.isSystem ?? 0, opts.amount === undefined ? '15.00' : opts.amount,
      opts.taxRateId ?? null, opts.deleted ? new Date() : null,
    ],
  );
  return insertId;
}

/** A member row linked to a Clerk id, so `resolveMemberId()` finds it. */
async function createLinkedMember(gid: string, clerkId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gid, 'Catalogue Member', `mep-${uniq()}@test.com`, clerkId],
  );
  return insertId;
}

/** The member's own call: their token, their gym. */
function asMember(gid: string = gymId, clerkId: string = MEMBER_CLERK) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerkId } as any);
  return request.get(ROOT).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid);
}

const names = (body: any): string[] => body.items.map((i: any) => i.name);

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = MONEI_WEBHOOK_SECRET;
  gymId = await createTestGym('Member Products Gym');
  await createTestMembership(gymId, 'member', MEMBER_CLERK);
  await createLinkedMember(gymId, MEMBER_CLERK);
});

afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await cleanupTestGyms();
  await db.end();
});

describe('auth and gating', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get(ROOT).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a gym role that is not a member', async () => {
    const roleGymId = await createTestGym('Products Role Guard Gym');
    await createTestMembership(roleGymId, 'admin', 'mep-role-admin');
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'mep-role-admin' } as any);
    const res = await request.get(ROOT)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', roleGymId);
    expect(res.status).toBe(403);
  });
});

describe('which Products the member is shown (#1121 Q1)', () => {
  it('lists the gym’s active, public items alphabetically', async () => {
    const gid = await createTestGym('Products Catalogue Gym');
    await createTestMembership(gid, 'member', 'mep-cat-member');
    await createLinkedMember(gid, 'mep-cat-member');
    await createItem(gid, { name: 'Locker Rental', frequency: 'month' });
    await createItem(gid, { name: 'Access Key', frequency: 'once', amount: '5.00' });

    const res = await asMember(gid, 'mep-cat-member');
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(['Access Key', 'Locker Rental']);
  });

  it('excludes an inactive item, a staff-only one and a deleted one', async () => {
    const gid = await createTestGym('Products Exclusion Gym');
    await createTestMembership(gid, 'member', 'mep-excl-member');
    await createLinkedMember(gid, 'mep-excl-member');
    await createItem(gid, { name: 'Shown' });
    await createItem(gid, { name: 'Parking Fee', status: 'inactive' });
    await createItem(gid, { name: 'Insurance Fee', enrollment: 'staff_only' });
    await createItem(gid, { name: 'Retired Item', deleted: true });

    const res = await asMember(gid, 'mep-excl-member');
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(['Shown']);
  });

  // `is_system` says an item was seeded from `charge_types`, not that it is
  // internal — a Locker Rental is a System row and a public one (#1149).
  it('includes a System item that the gym made public', async () => {
    const gid = await createTestGym('Products System Gym');
    await createTestMembership(gid, 'member', 'mep-sys-member');
    await createLinkedMember(gid, 'mep-sys-member');
    await createItem(gid, { name: 'Locker Rental', isSystem: 1, frequency: 'month' });

    const res = await asMember(gid, 'mep-sys-member');
    expect(names(res.body)).toEqual(['Locker Rental']);
  });

  it('is scoped to the caller’s gym', async () => {
    const otherGym = await createTestGym('Products Other Gym');
    await createItem(otherGym, { name: 'Another Gym Locker' });

    const res = await asMember();
    expect(res.status).toBe(200);
    expect(names(res.body)).not.toContain('Another Gym Locker');
  });

  it('a gym with nothing public answers an empty catalogue, not an error', async () => {
    const gid = await createTestGym('Products Empty Gym');
    await createTestMembership(gid, 'member', 'mep-empty-member');
    await createLinkedMember(gid, 'mep-empty-member');
    await createItem(gid, { name: 'Staff Only Fee', enrollment: 'staff_only' });

    const res = await asMember(gid, 'mep-empty-member');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

describe('what each row carries (#1121 §4)', () => {
  it('quotes the VAT-inclusive price and says tax is included', async () => {
    const gid = await createTestGym('Products Tax Gym');
    await createTestMembership(gid, 'member', 'mep-tax-member');
    await createLinkedMember(gid, 'mep-tax-member');
    const { insertId: rateId } = await db.query(
      `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status)
       VALUES (?, 'VAT 21%', 21, 0, 'active')`,
      [gid],
    );
    // Stored inclusive, so the gross figure is the stored amount itself — what
    // changes with the rate is only whether the row claims tax at all.
    await createItem(gid, {
      name: 'Taxed Locker', amount: '15.00', frequency: 'month', taxRateId: rateId,
    });

    const res = await asMember(gid, 'mep-tax-member');
    expect(res.body.items[0]).toMatchObject({
      name: 'Taxed Locker', price_incl_tax: 15, currency: 'EUR',
      tax_included: true, billing_frequency: 'month',
    });
  });

  it('an item with no tax rate claims no tax, and still reports its price', async () => {
    const gid = await createTestGym('Products Untaxed Gym');
    await createTestMembership(gid, 'member', 'mep-untax-member');
    await createLinkedMember(gid, 'mep-untax-member');
    await createItem(gid, { name: 'Plain Fee', amount: '20.00', frequency: 'once' });

    const res = await asMember(gid, 'mep-untax-member');
    expect(res.body.items[0]).toMatchObject({
      name: 'Plain Fee', price_incl_tax: 20, tax_included: false,
    });
  });

  it('an unpriced item reports null rather than zero', async () => {
    const gid = await createTestGym('Products Unpriced Gym');
    await createTestMembership(gid, 'member', 'mep-unpriced-member');
    await createLinkedMember(gid, 'mep-unpriced-member');
    await createItem(gid, { name: 'Premium Fitness App', amount: null, frequency: 'once' });

    const res = await asMember(gid, 'mep-unpriced-member');
    expect(res.body.items[0].price_incl_tax).toBeNull();
  });

  // #942 — the price is the whole package's, and `units` travels so the member
  // can be told so. Nothing divides by it.
  it('a Sessions package carries its units beside the package price', async () => {
    const gid = await createTestGym('Products Sessions Gym');
    await createTestMembership(gid, 'member', 'mep-sess-member');
    await createLinkedMember(gid, 'mep-sess-member');
    await createItem(gid, {
      name: 'Personal Training Class Package (10 Sessions)',
      type: 'sessions', units: 10, amount: '500.00', frequency: 'once',
    });

    const res = await asMember(gid, 'mep-sess-member');
    expect(res.body.items[0]).toMatchObject({ type: 'sessions', units: 10, price_incl_tax: 500 });
  });

  // #1121 stage 2 §6 — the catalogue now says what the member has done about
  // each Product, and whether the Buy action exists for it. A Product nobody
  // has bought is `available`, and `purchasable` is the server's answer rather
  // than something the page derives (a recurring Product is not buyable yet).
  it('reports a purchase state and whether it can be bought', async () => {
    const gid = await createTestGym('Products State Gym');
    await createTestMembership(gid, 'member', 'mep-state-member');
    await createLinkedMember(gid, 'mep-state-member');
    await createItem(gid, { name: 'Day Pass', amount: '10.00', frequency: 'once' });
    await createItem(gid, { name: 'Locker Rental', amount: '15.00', frequency: 'month' });
    await createItem(gid, { name: 'Unpriced Extra', amount: null, frequency: 'once' });

    const res = await asMember(gid, 'mep-state-member');
    const byName = Object.fromEntries(res.body.items.map((i: any) => [i.name, i]));
    expect(byName['Day Pass']).toMatchObject({ purchase_state: 'available', purchasable: true });
    expect(byName['Locker Rental']).toMatchObject({ purchase_state: 'available', purchasable: false });
    expect(byName['Unpriced Extra']).toMatchObject({ purchase_state: 'available', purchasable: false });
  });
});

/* ── #1121 stage 2: buying one ─────────────────────────────────────────────── */

/** The member's own purchase call. */
function buyAs(gid: string, clerkId: string, productId: number) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerkId } as any);
  return request.post(`${ROOT}/${productId}/purchase`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid);
}

/** A gym with a member of its own, so each case starts from a clean catalogue. */
async function purchaseGym(label: string): Promise<{ gid: string; clerk: string }> {
  const gid = await createTestGym(`Products ${label} Gym`);
  const clerk = `mep-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${uniq()}`;
  await createTestMembership(gid, 'member', clerk);
  await createLinkedMember(gid, clerk);
  return { gid, clerk };
}

function signedHeaders(body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', MONEI_WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex');
  return { 'monei-signature': `t=${ts},v1=${sig}` };
}

/** Monei reports an outcome for the purchase's own order. */
async function deliverWebhook(orderId: string, status: 'SUCCEEDED' | 'FAILED') {
  const chargeId = crypto.randomBytes(20).toString('hex');
  const raw = JSON.stringify({
    id: `evt_${chargeId}`,
    type: status === 'SUCCEEDED' ? 'charge.succeeded' : 'charge.failed',
    accountId: 'acc_test',
    livemode: false,
    objectId: chargeId,
    objectType: 'charge',
    createdAt: Math.floor(Date.now() / 1000),
    object: {
      id: chargeId,
      orderId,
      status,
      // A purchase may come back with a reusable token; nothing must store it
      // (a one-off authorises one charge, #788 is where a card comes from).
      paymentToken: `tok_${uniq()}`,
      sequenceId: `seq_${uniq()}`,
      paymentMethod: { card: { last4: '4242', brand: 'visa' } },
    },
  });
  const res = await request
    .post('/webhooks/payment')
    .set(signedHeaders(raw))
    .set('Content-Type', 'application/json')
    .send(raw);
  expect(res.status).toBe(200);
}

async function purchaseRows(gid: string) {
  const { rows } = await db.query<any>(
    `SELECT mp.*, pr.source, pr.status AS request_status, pr.provider_order,
            pr.user_membership_id, pr.amount AS request_amount
       FROM member_products mp
       LEFT JOIN payment_requests pr ON pr.id = mp.payment_request_id
      WHERE mp.gym_id = ? ORDER BY mp.id`,
    [gid],
  );
  return rows;
}

describe('starting a purchase (#1121 stage 2 §5)', () => {
  it('raises a payment for the quoted price and writes a pending purchase', async () => {
    const { gid, clerk } = await purchaseGym('Buy');
    const productId = await createItem(gid, {
      name: 'Personal Training Session', amount: '50.00', frequency: 'once',
    });

    const res = await buyAs(gid, clerk, productId);
    expect(res.status).toBe(201);
    expect(res.body.checkoutUrl).toContain('/checkout?token=');
    expect(res.body).toMatchObject({ amount: 50, currency: 'EUR' });

    // The provider is handed cents, never euros (CLAUDE.md's boundary rule).
    const call = providerCalls.createPaymentRequest.at(-1)!;
    expect(call.amount).toBe(5000);
    expect(call.description).toBe('Personal Training Session');

    const [row] = await purchaseRows(gid);
    expect(row).toMatchObject({
      product_id: productId,
      status: 'pending_payment',
      product_name: 'Personal Training Session',
      source: 'product_purchase',
      request_status: 'pending',
      created_by_type: 'member',
    });
    // The payment belongs to the member, not to an assignment (migration 228).
    expect(row.user_membership_id).toBeNull();
    expect(Number(row.amount)).toBe(50);
    expect(Number(row.request_amount)).toBe(50);
    expect(row.purchased_at).toBeNull();
  });

  it('freezes the Sessions package it was bought as, price and units', async () => {
    const { gid, clerk } = await purchaseGym('Snapshot');
    const productId = await createItem(gid, {
      name: 'Ten Sessions', type: 'sessions', units: 10, amount: '500.00', frequency: 'once',
    });

    expect((await buyAs(gid, clerk, productId)).status).toBe(201);
    // The Product is renamed and repriced afterwards: the purchase must not move
    // (#635 §16's rule, one table over).
    await db.query(`UPDATE products SET name = 'Twelve Sessions', amount = '900.00' WHERE id = ?`, [productId]);

    const [row] = await purchaseRows(gid);
    expect(row).toMatchObject({ product_name: 'Ten Sessions', product_type: 'sessions', units: 10 });
    expect(Number(row.amount)).toBe(500);
  });

  it('refuses a second checkout for the same Product', async () => {
    const { gid, clerk } = await purchaseGym('Duplicate');
    const productId = await createItem(gid, { name: 'Day Pass', amount: '10.00', frequency: 'once' });

    expect((await buyAs(gid, clerk, productId)).status).toBe(201);
    const second = await buyAs(gid, clerk, productId);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('purchase_pending');
    expect(await purchaseRows(gid)).toHaveLength(1);

    // …and the catalogue says so, so the Buy action is not offered again.
    const res = await asMember(gid, clerk);
    expect(res.body.items[0]).toMatchObject({ purchase_state: 'pending_payment', purchasable: false });
  });

  it('refuses a recurring Product, naming stage 2’s boundary', async () => {
    const { gid, clerk } = await purchaseGym('Recurring');
    const productId = await createItem(gid, { name: 'Locker Rental', amount: '15.00', frequency: 'month' });

    const res = await buyAs(gid, clerk, productId);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('recurring_not_supported');
    expect(await purchaseRows(gid)).toHaveLength(0);
  });

  it('refuses an unpriced Product', async () => {
    const { gid, clerk } = await purchaseGym('Unpriced Buy');
    const productId = await createItem(gid, { name: 'Premium App', amount: null, frequency: 'once' });

    const res = await buyAs(gid, clerk, productId);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_price');
  });

  // A member must not be able to buy what they cannot be shown: the route reads
  // the Product through the very predicate that built the catalogue.
  it('a staff-only, inactive or deleted Product is a 404', async () => {
    const { gid, clerk } = await purchaseGym('Hidden');
    const staffOnly = await createItem(gid, { name: 'Insurance Fee', enrollment: 'staff_only', frequency: 'once' });
    const inactive = await createItem(gid, { name: 'Parking', status: 'inactive', frequency: 'once' });
    const deleted = await createItem(gid, { name: 'Retired', deleted: true, frequency: 'once' });

    for (const id of [staffOnly, inactive, deleted]) {
      const res = await buyAs(gid, clerk, id);
      expect(res.status, String(id)).toBe(404);
    }
    expect(await purchaseRows(gid)).toHaveLength(0);
  });

  it('another gym’s Product is a 404', async () => {
    const { gid, clerk } = await purchaseGym('Tenant');
    const otherGym = await createTestGym('Products Foreign Gym');
    const foreign = await createItem(otherGym, { name: 'Foreign Pass', amount: '10.00', frequency: 'once' });

    const res = await buyAs(gid, clerk, foreign);
    expect(res.status).toBe(404);
    expect(await purchaseRows(gid)).toHaveLength(0);
    expect(await purchaseRows(otherGym)).toHaveLength(0);
  });

  it('returns 401 without auth and 403 for a role that is not a member', async () => {
    const { gid } = await purchaseGym('Purchase Auth');
    const productId = await createItem(gid, { name: 'Day Pass', amount: '10.00', frequency: 'once' });

    const anon = await request.post(`${ROOT}/${productId}/purchase`).set('x-gym-id', gid);
    expect(anon.status).toBe(401);

    await createTestMembership(gid, 'admin', 'mep-buy-admin');
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'mep-buy-admin' } as any);
    const staff = await request.post(`${ROOT}/${productId}/purchase`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid);
    expect(staff.status).toBe(403);
  });
});

describe('the payment decides whether the member holds it (#1121 stage 2 §6, #1118 §10)', () => {
  it('a completed payment makes the purchase the member’s, once', async () => {
    const { gid, clerk } = await purchaseGym('Complete');
    const productId = await createItem(gid, { name: 'Day Pass', amount: '10.00', frequency: 'once' });
    expect((await buyAs(gid, clerk, productId)).status).toBe(201);
    const [pending] = await purchaseRows(gid);

    await deliverWebhook(pending.provider_order, 'SUCCEEDED');

    const [row] = await purchaseRows(gid);
    expect(row).toMatchObject({ status: 'active', request_status: 'completed' });
    expect(row.purchased_at).not.toBeNull();
    expect(row.billing_event_id).not.toBeNull();

    // The ledger both the member's Payments card and the staff pages read, with
    // no assignment and the member on it.
    const { rows: events } = await db.query<any>(
      `SELECT event_type, member_id, user_membership_id, amount FROM billing_events WHERE gym_id = ?`,
      [gid],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: 'payment_recorded', member_id: row.member_id });
    expect(events[0].user_membership_id).toBeNull();
    expect(Number(events[0].amount)).toBe(10);

    // A one-off purchase authorises one charge: no card is stored from it.
    const { rows: cards } = await db.query<any>(
      'SELECT id FROM payment_methods WHERE gym_id = ?', [gid],
    );
    expect(cards).toHaveLength(0);

    // Monei retries: the second delivery changes nothing and writes no second
    // Billing Event.
    await deliverWebhook(pending.provider_order, 'SUCCEEDED');
    const { rows: again } = await db.query<any>(
      'SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ?', [gid],
    );
    expect(Number(again[0].n)).toBe(1);
    expect((await purchaseRows(gid))[0]).toMatchObject({ status: 'active' });

    // …and the catalogue reports it as held, with no Buy action.
    const res = await asMember(gid, clerk);
    expect(res.body.items[0]).toMatchObject({ purchase_state: 'purchased' });
  });

  it('a failed payment cancels the purchase and leaves the Product available', async () => {
    const { gid, clerk } = await purchaseGym('Failed');
    const productId = await createItem(gid, { name: 'Day Pass', amount: '10.00', frequency: 'once' });
    expect((await buyAs(gid, clerk, productId)).status).toBe(201);
    const [pending] = await purchaseRows(gid);

    await deliverWebhook(pending.provider_order, 'FAILED');

    const [row] = await purchaseRows(gid);
    expect(row).toMatchObject({ status: 'cancelled', request_status: 'failed' });
    expect(row.purchased_at).toBeNull();
    const { rows: events } = await db.query<any>(
      'SELECT id FROM billing_events WHERE gym_id = ?', [gid],
    );
    expect(events).toHaveLength(0);

    // The member can try again: the pending key is free and the catalogue says
    // the Product is available.
    const res = await asMember(gid, clerk);
    expect(res.body.items[0]).toMatchObject({ purchase_state: 'available', purchasable: true });
    expect((await buyAs(gid, clerk, productId)).status).toBe(201);
  });

  it('the hosted page loads a purchase’s token and words it as one', async () => {
    const { gid, clerk } = await purchaseGym('Page');
    const productId = await createItem(gid, { name: 'Day Pass', amount: '10.00', frequency: 'once' });
    const res = await buyAs(gid, clerk, productId);
    const token = new URL(res.body.checkoutUrl).searchParams.get('token')!;

    // An INNER JOIN on the assignment answered 404 here for every purchase.
    const page = await request.get(`/payment-page/token/${token}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ purpose: 'product_purchase', amount: 10, itemName: 'Day Pass' });
  });
});
