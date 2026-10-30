// #2123 stage 5: the Family Owner pays on the request paths too — Pay now, staff Retry —
// and the beneficiary stays the `member_id` on the record.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership,
  request, ensureTestProductSet, legacyAssignmentQuery,
} from './helpers';

const provider = vi.hoisted(() => ({ recurring: [] as Array<{ paymentToken: string }> }));
vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({
    createPaymentRequest: async (p: { orderId: string }) => ({ providerOrderId: `monei-${p.orderId}`, checkoutUrl: 'https://pay.test/x' }),
    executeRecurring: async (p: { paymentToken: string }) => {
      provider.recurring.push(p);
      return { success: true, providerRef: 'ref', providerStatus: 'SUCCEEDED' };
    },
  }),
}));

let gymId: string;
beforeAll(async () => {
  gymId = await createTestGym('Family Payer Routes Gym');
  await createTestMembership(gymId, 'admin');
});
beforeEach(() => { provider.recurring = []; });
afterAll(async () => {
  vi.mocked(verifyToken).mockResolvedValue({ sub: TEST_USER_ID } as any);
  await cleanupTestGyms();
  await db.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function member(opts: { token?: string; userId?: string } = {}): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'FPR', `fpr-${uniq()}@test.com`, opts.userId ?? null]);
  if (opts.token) {
    await db.query(
      `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id) VALUES (?, ?, 'monei', ?, 'seq')`,
      [gymId, insertId, opts.token]);
  }
  return insertId as number;
}
async function family(owner: number, other: number) {
  const { insertId } = await db.query('INSERT INTO families (gym_id, name) VALUES (?, ?)', [gymId, 'F']);
  await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 1)', [gymId, insertId, owner]);
  await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 0)', [gymId, insertId, other]);
}
async function assignment(memberId: number): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `FPR-Plan-${uniq()}`]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`,
    [gymId, planId]);
  const { insertId } = await legacyAssignmentQuery(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price, membership_fee_price)
     VALUES (?, ?, ?, 'active', CURDATE(), '0.00', '30.00')`, [gymId, memberId, planId]);
  return insertId;
}

describe('Pay now', () => {
  it('refuses a family beneficiary: the Family Owner pays', async () => {
    const userId = `fpr-ben-${uniq()}`;
    await createTestMembership(gymId, 'member', userId);
    const ben = await member({ userId });
    const owner = await member({ token: 'tok_owner' });
    await family(owner, ben);
    await assignment(ben);
    vi.mocked(verifyToken).mockResolvedValue({ sub: userId } as any);
    const res = await request.post('/me/payment-requests').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('family_owner_pays');
  });

  it('records the member as their own payer when they are in no family', async () => {
    const userId = `fpr-solo-${uniq()}`;
    await createTestMembership(gymId, 'member', userId);
    const solo = await member({ userId });
    await assignment(solo);
    vi.mocked(verifyToken).mockResolvedValue({ sub: userId } as any);
    const res = await request.post('/me/payment-requests').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({});
    expect(res.status).toBe(201);
    const { rows } = await db.query<any>('SELECT member_id, payer_member_id FROM payment_requests WHERE id = ?', [res.body.id]);
    expect(rows[0]).toMatchObject({ member_id: solo, payer_member_id: solo });
  });
});

describe('Retry payment', () => {
  async function failedEvent(beneficiary: number): Promise<number> {
    const um = await assignment(beneficiary);
    const { rows: ct } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
    const { insertId } = await db.query(
      `INSERT INTO billing_events (gym_id, product_set_id, member_id, event_type, amount, charge_type_id, source, billing_date)
       VALUES (?, ?, ?, 'failed_billing', '30.00', ?, 'system', CURDATE())`,
      [gymId, await ensureTestProductSet(gymId, beneficiary, um), beneficiary, ct[0].id]);
    return insertId as number;
  }
  const retry = (id: number) => request.post(`/payments/billing-events/${id}/retry`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({});

  it("charges the Family Owner's card and records them as payer", async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: TEST_USER_ID } as any);
    const ben = await member({ token: 'tok_beneficiary' });
    const owner = await member({ token: 'tok_owner' });
    await family(owner, ben);
    const eventId = await failedEvent(ben);
    const res = await retry(eventId);
    expect(res.status).toBe(200);
    expect(provider.recurring.map((c) => c.paymentToken)).toEqual(['tok_owner']);
    const { rows } = await db.query<any>('SELECT member_id, payer_member_id FROM payment_requests WHERE billing_event_id = ?', [eventId]);
    expect(rows[0]).toMatchObject({ member_id: ben, payer_member_id: owner });
  });

  it('is refused when the owner has no card, even if the beneficiary has one', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: TEST_USER_ID } as any);
    const ben = await member({ token: 'tok_beneficiary' });
    const owner = await member();
    await family(owner, ben);
    const res = await retry(await failedEvent(ben));
    expect(res.status).toBe(400);
    expect(provider.recurring).toHaveLength(0);
  });
});
