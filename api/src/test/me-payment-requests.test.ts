// Tests for POST /me/payment-requests — the member-initiated first payment
// (#789 §2: no test file exercised this route at all).
//
// The route is the entry point of the whole customer-initiated flow: it is what
// stamps `consent_given_at`, what decides the amount the member is asked for, and
// what creates the row the hosted page loads and the webhook later reconciles.
// Its four behaviours below were untested, including the two that answer an error
// — which are precisely the ones a member hits.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// The provider is stubbed so no HTTP reaches Monei. Spread the real module so
// every *other* consumer of `../payments` that app.ts pulls in (billing.ts among
// them) keeps its own exports.
const providerCalls = vi.hoisted(() => ({
  createPaymentRequest: [] as Array<{ orderId: string; amount: number; currency: string }>,
}));
vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({
    createPaymentRequest: async (params: { orderId: string; amount: number; currency: string }) => {
      providerCalls.createPaymentRequest.push(params);
      return { providerOrderId: `monei-${params.orderId}`, checkoutUrl: 'https://pay.test/x' };
    },
  }),
}));

let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Me Payment Requests Gym');
});

afterAll(async () => {
  vi.mocked(verifyToken).mockResolvedValue({ sub: TEST_USER_ID } as any);
  await cleanupTestGyms();
  await db.end();
});

// ─── fixtures ────────────────────────────────────────────────────────────────

/**
 * A member of `gymId` with their own Clerk user id, and the session acting as
 * them.
 *
 * Each case gets its own id on purpose: the route's limiter is keyed on the Clerk
 * user (3/hour), so sharing one identity would leave the later tests in this file
 * fighting over a three-request budget instead of testing the route.
 */
async function actAsNewMember(label: string): Promise<{ memberId: number; userId: string }> {
  const userId = `me-pr-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await createTestMembership(gymId, 'member', userId);
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'Me PR Member', ?, ?)`,
    [gymId, `${userId}@test.com`, userId],
  );
  vi.mocked(verifyToken).mockResolvedValue({ sub: userId } as any);
  return { memberId: insertId, userId };
}

async function createPlan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `Me-PR-Plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`],
  );
  await db.query(
    `INSERT INTO billing_policies
       (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gymId, insertId],
  );
  return insertId;
}

/** An active assignment whose current cycle owes `fee` (a frozen Membership Fee). */
async function createAssignment(memberId: number, fee = '29.99'): Promise<number> {
  const planId = await createPlan();
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price, membership_fee_price)
     VALUES (?, ?, ?, 'active', CURDATE(), '0.00', ?)`,
    [gymId, memberId, planId, fee],
  );
  return insertId;
}

function post(body: Record<string, unknown> = {}) {
  return request
    .post('/me/payment-requests')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send(body);
}

async function readRequestRow(id: number) {
  const { rows } = await db.query<{
    gym_id: string;
    member_id: number;
    user_membership_id: number;
    amount: string;
    status: string;
    source: string;
    consent_given_at: Date | null;
    initiated_by: string | null;
    page_token: string | null;
    provider_order: string;
  }>('SELECT * FROM payment_requests WHERE id = ?', [id]);
  return rows[0];
}

// ─── guards ──────────────────────────────────────────────────────────────────

describe('POST /me/payment-requests — guards', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await request.post('/me/payment-requests').set('x-gym-id', gymId).send({});
    expect(res.status).toBe(401);
  });

  it('returns 403 for a staff role — the route is requireRole(’member’)', async () => {
    const staffGym = await createTestGym('Me PR Staff Gym');
    const userId = `me-pr-staff-${Date.now()}`;
    await createTestMembership(staffGym, 'admin', userId);
    vi.mocked(verifyToken).mockResolvedValue({ sub: userId } as any);

    const res = await request
      .post('/me/payment-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGym)
      .send({});
    expect(res.status).toBe(403);
  });

  it('returns 404 when the member holds no active membership', async () => {
    const { memberId } = await actAsNewMember('noactive');
    const planId = await createPlan();
    // Cancelled, so the route's `status = 'active'` filter finds nothing.
    await db.query(
      `INSERT INTO user_memberships
         (gym_id, member_id, membership_plan_id, status, starts_at, base_price, membership_fee_price)
       VALUES (?, ?, ?, 'cancelled', CURDATE(), '0.00', '29.99')`,
      [gymId, memberId, planId],
    );

    const res = await post();
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed user_membership_id', async () => {
    const { memberId } = await actAsNewMember('badid');
    await createAssignment(memberId);

    const res = await post({ user_membership_id: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/user_membership_id/);
  });
});

// ─── happy path ──────────────────────────────────────────────────────────────

describe('POST /me/payment-requests — the row it writes', () => {
  it('stamps consent, marks the row customer-initiated, and returns a checkout link', async () => {
    const { memberId } = await actAsNewMember('happy');
    const umId = await createAssignment(memberId, '29.99');
    providerCalls.createPaymentRequest = [];

    const res = await post();
    expect(res.status).toBe(201);
    expect(res.body.checkoutUrl).toContain('/checkout?token=');

    const row = await readRequestRow(res.body.id);
    expect(row.gym_id).toBe(gymId);
    expect(row.member_id).toBe(memberId);
    expect(row.user_membership_id).toBe(umId);
    expect(row.status).toBe('pending');
    // `customer`, not `admin`: the member raised it themselves.
    expect(row.source).toBe('customer');
    // The consent the hosted page's checkbox stands behind. A staff-raised
    // request leaves this NULL, which is the whole distinction.
    expect(row.consent_given_at).not.toBeNull();
    expect(row.initiated_by).toBeNull();
    expect(Number(row.amount)).toBe(29.99);
    // The token the page is loaded with is only in the URL and this column.
    expect(row.page_token).not.toBeNull();
    expect(res.body.checkoutUrl).toContain(row.page_token!);
  });

  // CLAUDE.md: an amount crosses the provider boundary in **minor units**, and a
  // test of a provider call asserts the amount the stub received. A euro amount
  // here would charge 29.99 € as twenty-nine cents.
  it('hands the provider the fee in minor units', async () => {
    const { memberId } = await actAsNewMember('minor');
    await createAssignment(memberId, '29.99');
    providerCalls.createPaymentRequest = [];

    const res = await post();
    expect(res.status).toBe(201);

    expect(providerCalls.createPaymentRequest).toHaveLength(1);
    expect(providerCalls.createPaymentRequest[0].amount).toBe(2999);
    expect(providerCalls.createPaymentRequest[0].currency).toBe('EUR');
  });

  it('accepts an explicit user_membership_id and writes the request against it', async () => {
    const { memberId } = await actAsNewMember('explicit');
    const umId = await createAssignment(memberId, '15.00');

    const res = await post({ user_membership_id: umId });
    expect(res.status).toBe(201);
    expect((await readRequestRow(res.body.id)).user_membership_id).toBe(umId);
  });

  it('404s an explicit user_membership_id belonging to another member', async () => {
    const other = await actAsNewMember('victim');
    const otherUmId = await createAssignment(other.memberId, '40.00');

    const { memberId } = await actAsNewMember('attacker');
    await createAssignment(memberId, '20.00');

    const res = await post({ user_membership_id: otherUmId });
    expect(res.status).toBe(404);
  });
});

// ─── the two decisions that answer an error ──────────────────────────────────

describe('POST /me/payment-requests — a cycle that owes nothing', () => {
  // #635 stage 15: the amount is the fee resolved on the cycle the member is next
  // charged for, so a cycle the contract waives is not payable at all. Nothing is
  // sent to the provider and no row is written — which is also why replacing a
  // card cannot be done through this route.
  it('returns 400 while the assignment is inside its Free Period, and calls no provider', async () => {
    const { memberId } = await actAsNewMember('free');
    const umId = await createAssignment(memberId, '29.99');
    await db.query('UPDATE user_memberships SET free_periods = 1 WHERE id = ?', [umId]);
    providerCalls.createPaymentRequest = [];

    const res = await post();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owes nothing/i);

    expect(providerCalls.createPaymentRequest).toHaveLength(0);
    const { rows } = await db.query('SELECT id FROM payment_requests WHERE user_membership_id = ?', [umId]);
    expect(rows).toHaveLength(0);
  });
});

describe('POST /me/payment-requests — more than one active membership', () => {
  // #634 (migration 172): a member may hold several active Plans at once, so
  // "their active membership" is no longer a single row. Without an explicit id
  // the route refuses rather than charging whichever one MySQL returned first.
  it('returns 409 naming the candidates, and 201 once one of them is named', async () => {
    const { memberId } = await actAsNewMember('two');
    const first = await createAssignment(memberId, '29.99');
    const second = await createAssignment(memberId, '49.99');

    const conflict = await post();
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('multiple_active_memberships');
    expect([...conflict.body.user_membership_ids].sort()).toEqual([first, second].sort());

    const res = await post({ user_membership_id: second });
    expect(res.status).toBe(201);
    const row = await readRequestRow(res.body.id);
    expect(row.user_membership_id).toBe(second);
    expect(Number(row.amount)).toBe(49.99);
  });
});

// ─── the limiter ─────────────────────────────────────────────────────────────
//
// Last in the file: express-rate-limit keeps its counters in the module, so a
// member whose budget is spent here stays spent for the rest of the process.
describe('POST /me/payment-requests — 3 per hour per Clerk user', () => {
  it('answers 429 on the fourth request and leaves the third one’s row alone', async () => {
    const { memberId } = await actAsNewMember('limit');
    await createAssignment(memberId, '10.00');

    for (let i = 0; i < 3; i++) {
      expect((await post()).status).toBe(201);
    }

    const blocked = await post();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/too many/i);

    // The limiter rejects before the handler, so it writes nothing of its own.
    const { rows } = await db.query('SELECT id FROM payment_requests WHERE member_id = ?', [memberId]);
    expect(rows).toHaveLength(3);
  });

  it('does not spend another member’s budget', async () => {
    const { memberId } = await actAsNewMember('unaffected');
    await createAssignment(memberId, '10.00');

    expect((await post()).status).toBe(201);
  });
});
