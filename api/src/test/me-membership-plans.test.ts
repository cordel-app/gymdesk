// #1122 §1–§6 — the Members App's Add Plan.
//
// `GET /me/membership-plans` lists the plans a member may choose with the
// Promotions compatible with each; `POST /me/membership-plans/:id/assign`
// writes the member's own Draft, applies the chosen Promotions with their
// snapshots, and runs Save & Pay — so the member lands in Pending Payment (or
// Active, when the first cycle owes nothing) exactly as a staff assignment
// would, and pays it through the same Pay now.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';

// The provider is stubbed so no HTTP reaches Monei (#1288: Save & Pay now
// creates the hosted-page payment request itself).
vi.mock('../payments', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../payments')>();
  return {
    ...mod,
    // The real provider still verifies the webhook signature (#1325 PR 3a's
    // end-to-end case); only the call that would reach Monei is stubbed.
    getPaymentProvider: () => {
      let real: object = {};
      try { real = mod.getPaymentProvider(); } catch { /* no provider configured: only createPaymentRequest is needed */ }
      return Object.assign(Object.create(real), {
        createPaymentRequest: async (params: { orderId: string }) => ({
          providerOrderId: `monei-${params.orderId}`, checkoutUrl: 'https://pay.test/x',
        }),
      });
    },
  };
});
import {
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
  TEST_AUTH_HEADER,
} from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

async function createMember(): Promise<{ id: number; userId: string }> {
  const userId = `mmp-member-${uniq()}`;
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'MMP Member', `${userId}@test.com`, userId],
  );
  await createTestMembership(gymId, 'member', userId);
  return { id: insertId, userId };
}

function asMember(userId: string) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: userId } as any);
}

async function createPlan(opts: { price?: number | null; enrollment?: string; lifecycle?: string } = {}): Promise<number> {
  const { price = 40, enrollment = 'public', lifecycle = 'active' } = opts;
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, ?, ?, '1')`,
    [gymId, `MMP Plan ${uniq()}`, lifecycle, enrollment],
  );
  if (price != null) {
    await db.query(
      `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
       VALUES (?, ?, ?, '2020-01-01', 'active')`,
      [gymId, insertId, price],
    );
  }
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gymId, insertId],
  );
  return insertId;
}

async function createPromotion(planId: number, opts: {
  action?: string; value?: number | null; durationMonths?: number | null;
  newMembersOnly?: boolean; appliesTo?: string; enabled?: boolean;
} = {}): Promise<number> {
  const { action = 'percentage_discount', value = 50, durationMonths = 3, newMembersOnly = false, appliesTo = 'membership_plan', enabled = true } = opts;
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                             only_applicable_for_new_members, paid_months, applies_to)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, ?, 12, ?)`,
    [gymId, `MMP Promo ${uniq()}`, newMembersOnly ? 1 : 0, appliesTo],
  );
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, insertId, planId],
  );
  await db.query(
    `INSERT INTO promotion_membership_fee_benefits (gym_id, promotion_id, duration_months, enabled, action, value)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [gymId, insertId, durationMonths, enabled ? 1 : 0, action, value],
  );
  return insertId;
}

const h = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });
const list = (userId: string) => { asMember(userId); return request.get('/me/membership-plans').set(h()); };
const assign = (userId: string, planId: number, body: Record<string, unknown> = {}) => {
  asMember(userId); return request.post(`/me/membership-plans/${planId}/assign`).set(h()).send(body);
};

async function status(umId: number): Promise<string> {
  const { rows } = await db.query<{ status: string }>('SELECT status FROM user_memberships WHERE id = ?', [umId]);
  return rows[0].status;
}

beforeAll(async () => {
  gymId = await createTestGym('MMP Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/membership-plans', () => {
  it('lists the active public plans with their price and cadence, and the Promotions compatible with each', async () => {
    const member = await createMember();
    const planId = await createPlan({ price: 40 });
    await createPlan({ enrollment: 'staff_only' });
    await createPlan({ lifecycle: 'draft' });
    const promoId = await createPromotion(planId, { action: 'percentage_discount', value: 50, durationMonths: 3 });
    await createPromotion(planId, { action: 'no_benefit', value: null }); // nothing to offer
    await createPromotion(planId, { appliesTo: 'product' });               // about a Product
    await createPromotion(planId, { enabled: false });                     // benefit switched off

    const res = await list(member.userId);
    expect(res.status).toBe(200);
    const plan = res.body.plans.find((p: any) => p.id === planId);
    expect(plan).toBeTruthy();
    expect(res.body.plans.map((p: any) => p.id)).toEqual([planId]);
    expect(plan.price_incl_tax).toBe(40);
    expect(plan.billing_interval).toBe(1);
    expect(plan.billing_unit).toBe('month');
    expect(plan.promotions.map((p: any) => p.id)).toEqual([promoId]);
    expect(plan.promotions[0].benefit).toEqual({ action: 'percentage_discount', value: 50 });
    expect(plan.promotions[0].duration_months).toBe(3);
    expect(plan.promotions[0].final_price_incl_tax).toBe(20);
  });

  it('hides a new-members-only Promotion from a member who holds a live plan', async () => {
    const member = await createMember();
    const livePlan = await createPlan({ price: null });
    await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at) VALUES (?, ?, ?, 'active', CURDATE())`,
      [gymId, member.id, livePlan],
    );
    const planId = await createPlan({ price: 40 });
    const everyone = await createPromotion(planId, { newMembersOnly: false });
    await createPromotion(planId, { newMembersOnly: true });
    const res = await list(member.userId);
    const plan = res.body.plans.find((p: any) => p.id === planId);
    expect(plan.promotions.map((p: any) => p.id)).toEqual([everyone]);
    expect(res.body.is_new_member).toBe(false);
  });
});

describe('POST /me/membership-plans/:id/assign', () => {
  it('writes the member\'s own Draft, applies the Promotion with its snapshot, and lands in Pending Payment', async () => {
    const member = await createMember();
    const planId = await createPlan({ price: 40 });
    const promoId = await createPromotion(planId, { action: 'percentage_discount', value: 50 });
    const res = await assign(member.userId, planId, { promotion_ids: [promoId] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_payment');
    expect(Number(res.body.membership_fee)).toBe(20);
    expect(res.body.promotion_ids).toEqual([promoId]);

    // #1325 PR 3a: the member's plan is a ProductSet version, with the plan frozen
    // beside it and the Promotion applied with its own snapshot.
    const { rows: ps } = await db.query<any>(
      'SELECT owner_member_id, created_by_type, status, membership_plan_id FROM product_sets WHERE id = ?', [res.body.id]);
    expect(ps[0].owner_member_id).toBe(member.id);
    expect(ps[0].created_by_type).toBe('member');
    expect(ps[0].status).toBe('pending_payment');
    expect(ps[0].membership_plan_id).toBe(planId);
    const { rows: snap } = await db.query<any>(
      'SELECT membership_fee_price FROM product_set_plan_snapshots WHERE product_set_id = ?', [res.body.id]);
    expect(Number(snap[0].membership_fee_price)).toBe(40);
    const { rows: apps } = await db.query<any>(
      "SELECT promotion_id, status, snapshot FROM user_membership_promotions WHERE product_set_id = ? AND status = 'applied'", [res.body.id],
    );
    expect(apps.map((a: any) => a.promotion_id)).toEqual([promoId]);
    expect(apps[0].snapshot).not.toBeNull();
    // Nothing is an assignment yet: that is what activation projects.
    const { rows: um } = await db.query<any>('SELECT id FROM user_memberships WHERE member_id = ?', [member.id]);
    expect(um).toHaveLength(0);

    // The member's own read tells the page about it, and Pay now reaches it.
    asMember(member.userId);
    const me = await request.get('/me/membership').set(h());
    expect(me.body.membership).toBeNull();
    expect(me.body.pending_membership.id).toBe(res.body.id);
    expect(Number(me.body.pending_membership.membership_fee)).toBe(20);
  });

  it('activates straight away when the first cycle owes nothing', async () => {
    const member = await createMember();
    const planId = await createPlan({ price: 40 });
    const waive = await createPromotion(planId, { action: 'waive', value: null, durationMonths: 2 });
    const res = await assign(member.userId, planId, { promotion_ids: [waive] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
  });

  it('refuses a plan that is not public, a Promotion that does not target the plan, and one about a Product', async () => {
    const member = await createMember();
    expect((await assign(member.userId, await createPlan({ enrollment: 'staff_only' }))).status).toBe(400);
    const planId = await createPlan({ price: 40 });
    const other = await createPlan({ price: 40 });
    const foreignPromo = await createPromotion(other);
    expect((await assign(member.userId, planId, { promotion_ids: [foreignPromo] })).status).toBe(400);
    const productPromo = await createPromotion(planId, { appliesTo: 'product' });
    expect((await assign(member.userId, planId, { promotion_ids: [productPromo] })).status).toBe(400);
    expect((await assign(member.userId, planId, { promotion_ids: 'x' })).status).toBe(400);
  });

  it('refuses a member who already holds a plan — the change is the gym\'s — and creates nothing', async () => {
    const member = await createMember();
    const livePlan = await createPlan({ price: null });
    const { insertId: liveId } = await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at) VALUES (?, ?, ?, 'active', '2026-01-01')`,
      [gymId, member.id, livePlan],
    );
    const planId = await createPlan({ price: 40 });
    const refused = await assign(member.userId, planId);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('plan_change_via_gym');
    // `confirm` no longer opens a replacement.
    expect((await assign(member.userId, planId, { confirm: true })).status).toBe(409);
    const { rows: created } = await db.query<any>(
      'SELECT id FROM user_memberships WHERE gym_id = ? AND member_id = ? AND membership_plan_id = ?', [gymId, member.id, planId],
    );
    expect(created).toHaveLength(0);
    expect(await status(liveId)).toBe('active');
  });

  it('Save & Pay writes the initial pending Billing Event and its payment request, and a second plan is refused', async () => {
    const member = await createMember();
    const planId = await createPlan({ price: 40 });
    const res = await assign(member.userId, planId);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_payment');
    expect(res.body.checkout_url).toContain('/checkout?token=');
    const { rows } = await db.query<any>(
      `SELECT be.event_type, be.amount, pr.status AS pr_status, pr.billing_event_id
         FROM billing_events be JOIN payment_requests pr ON pr.billing_event_id = be.id
        WHERE be.id = ?`, [res.body.billing_event_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('payment_recorded');
    expect(rows[0].pr_status).toBe('pending');
    expect(Number(rows[0].amount)).toBe(40);

    const again = await assign(member.userId, await createPlan({ price: 40 }));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('plan_pending_payment');
  });
});

// ─── The paid plan reaches the member's own page (#1325 PR 3a) ───────────────

import crypto from 'crypto';

describe('a ProductSet plan paid through the webhook is the member\'s plan', () => {
  const SECRET = 'mmp-productset-webhook';
  beforeAll(() => {
    process.env.MONEI_API_KEY = 'test-api-key';
    process.env.MONEI_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    delete process.env.MONEI_API_KEY;
    delete process.env.MONEI_WEBHOOK_SECRET;
  });

  it('Pay now reaches a pending set, and the webhook makes it the member\'s current plan', async () => {
    const member = await createMember();
    const planId = await createPlan({ price: 40 });
    const res = await assign(member.userId, planId);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_payment');

    // Before payment: pending, not current.
    asMember(member.userId);
    const before = await request.get('/me/membership').set(h());
    expect(before.body.membership).toBeNull();
    expect(Number(before.body.pending_membership.membership_fee)).toBe(40);

    // Pay now on a pending set is a new attempt on the same initial event.
    asMember(member.userId);
    const payNow = await request.post('/me/payment-requests').set(h()).send({});
    expect(payNow.status).toBe(201);
    const { rows: attempts } = await db.query<any>(
      'SELECT attempt, provider_order FROM payment_requests WHERE billing_event_id = ? ORDER BY attempt', [res.body.billing_event_id]);
    expect(attempts.map((a: any) => a.attempt)).toEqual([1, 2]);

    const raw = JSON.stringify({
      id: 'evt_1', type: 'charge.succeeded', objectId: 'ch_1', objectType: 'charge',
      object: { id: 'ch_1', orderId: attempts[1].provider_order, status: 'SUCCEEDED' },
    });
    const t = String(Math.floor(Date.now() / 1000));
    const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
    const hook = await request.post('/webhooks/payment')
      .set({ 'monei-signature': `t=${t},v1=${v1}`, 'Content-Type': 'application/json' }).send(raw);
    expect(hook.status).toBe(200);

    asMember(member.userId);
    const after = await request.get('/me/membership').set(h());
    expect(after.body.pending_membership).toBeNull();
    expect(after.body.membership).not.toBeNull();
    expect(Number(after.body.membership.membership_fee)).toBe(40);
  });
});
