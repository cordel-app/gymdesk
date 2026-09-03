// Tests for payment-requests.ts router

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// Mock the payment provider so no real HTTP calls are made to Monei.
// The router calls getPaymentProvider().createPaymentRequest(...); this stub
// returns a fixed providerOrderId so the INSERT proceeds normally.
vi.mock('../payments', () => ({
  getPaymentProvider: () => ({
    createPaymentRequest: vi.fn().mockResolvedValue({
      providerOrderId: 'monei-test-order-123',
    }),
  }),
}));

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ─── Local setup helpers ──────────────────────────────────────────────────────

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'PR Test Member', ?)`,
    [gymId, `pr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId;
}

async function createMembershipPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'closed')`,
    [gymId, `PR-Plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`],
  );
  return insertId;
}

async function createUserMembership(
  gymId: string,
  memberId: number,
  planId: number,
  finalPrice = '29.99',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, final_price)
     VALUES (?, ?, ?, 'active', CURDATE(), ?)`,
    [gymId, memberId, planId, finalPrice],
  );
  return insertId;
}

async function getChargeTypeId(code = 'membership_fee'): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM charge_types WHERE code = ?', [code]);
  return rows[0].id;
}

async function insertPaymentRequest(
  gymId: string,
  userMembershipId: number,
  memberId: number,
  chargeTypeId: number,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, page_token, page_token_expires, initiated_by, source)
     VALUES (?, ?, ?, '29.99', 'EUR', ?, 'pending', 'monei',
             UUID(), UUID(), DATE_ADD(NOW(), INTERVAL 10 MINUTE), 'test-user-id', 'admin')`,
    [gymId, userMembershipId, memberId, chargeTypeId],
  );
  return insertId;
}

// ─── Auth and module access guards ───────────────────────────────────────────

describe('Auth and access guards', () => {
  let gymId: string;
  let gymNoAccess: string;

  beforeAll(async () => {
    gymId = await createTestGym('PR Auth Gym');
    await createTestMembership(gymId, 'admin');

    // trainer_performance has NONE access to PAYMENTS module → 403 on any route
    gymNoAccess = await createTestGym('PR No Access Gym');
    await createTestMembership(gymNoAccess, 'trainer_performance');
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request.get('/payment-requests').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in the requested gym', async () => {
    const otherGym = await createTestGym('PR Tenant Guard Gym');
    const res = await request
      .get('/payment-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGym);
    expect(res.status).toBe(403);
  });

  it('returns 403 when role has NONE access to the PAYMENTS module (trainer_performance)', async () => {
    const res = await request
      .get('/payment-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoAccess);
    expect(res.status).toBe(403);
  });
});

// ─── GET /payment-requests ───────────────────────────────────────────────────

describe('GET /payment-requests', () => {
  let gymId: string;
  let otherGymId: string;
  let memberId: number;
  let paymentRequestId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PR List Gym');
    otherGymId = await createTestGym('PR List Other Gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');

    memberId = await createMember(gymId);
    const planId = await createMembershipPlan(gymId);
    const userMembershipId = await createUserMembership(gymId, memberId, planId);
    const chargeTypeId = await getChargeTypeId();
    paymentRequestId = await insertPaymentRequest(gymId, userMembershipId, memberId, chargeTypeId);
  });

  it('returns 200 with an array of payment requests', async () => {
    const res = await request
      .get('/payment-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    const pr = res.body[0];
    expect(pr).toHaveProperty('id');
    expect(pr).toHaveProperty('member_name');
    expect(pr).toHaveProperty('status');
    expect(pr).toHaveProperty('amount');
  });

  it('includes the inserted payment request', async () => {
    const res = await request
      .get('/payment-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const found = res.body.some((pr: any) => pr.id === paymentRequestId);
    expect(found).toBe(true);
  });

  it('filters by member_id', async () => {
    const res = await request
      .get(`/payment-requests?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.every((pr: any) => pr.member_id === memberId)).toBe(true);
  });

  it('filters by status', async () => {
    const res = await request
      .get('/payment-requests?status=pending')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.every((pr: any) => pr.status === 'pending')).toBe(true);
  });

  it('tenant isolation: does not return records from another gym', async () => {
    // otherGymId has no payment_requests; the one in gymId must not bleed through
    const res = await request
      .get('/payment-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(200);
    const leakedId = res.body.some((pr: any) => pr.id === paymentRequestId);
    expect(leakedId).toBe(false);
  });
});

// ─── GET /payment-requests/:id ───────────────────────────────────────────────

describe('GET /payment-requests/:id', () => {
  let gymId: string;
  let otherGymId: string;
  let memberId: number;
  let paymentRequestId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PR Get Gym');
    otherGymId = await createTestGym('PR Get Other Gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');

    memberId = await createMember(gymId);
    const planId = await createMembershipPlan(gymId);
    const userMembershipId = await createUserMembership(gymId, memberId, planId);
    const chargeTypeId = await getChargeTypeId();
    paymentRequestId = await insertPaymentRequest(gymId, userMembershipId, memberId, chargeTypeId);
  });

  it('returns 200 with member_name and member_email', async () => {
    const res = await request
      .get(`/payment-requests/${paymentRequestId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', paymentRequestId);
    expect(res.body).toHaveProperty('member_name');
    expect(res.body).toHaveProperty('member_email');
    expect(res.body).toHaveProperty('amount');
    expect(res.body).toHaveProperty('status', 'pending');
    expect(res.body).toHaveProperty('currency', 'EUR');
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request
      .get('/payment-requests/999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('tenant isolation: returns 404 when record belongs to a different gym', async () => {
    const res = await request
      .get(`/payment-requests/${paymentRequestId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(404);
  });
});

// ─── POST /payment-requests ──────────────────────────────────────────────────

describe('POST /payment-requests', () => {
  let gymId: string;
  let otherGymId: string;
  let gymReadOnly: string;
  let userMembershipId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PR Create Gym');
    // otherGymId — same TEST_USER_ID is admin here; used for cross-gym isolation
    otherGymId = await createTestGym('PR Create Other Gym');
    // accountant has R access to PAYMENTS (no W) — POST should return 403
    gymReadOnly = await createTestGym('PR Read Only Gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');
    await createTestMembership(gymReadOnly, 'accountant');

    const memberId = await createMember(gymId);
    const planId = await createMembershipPlan(gymId);
    userMembershipId = await createUserMembership(gymId, memberId, planId, '49.99');
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request
      .post('/payment-requests')
      .set('x-gym-id', gymId)
      .send({ user_membership_id: userMembershipId });
    expect(res.status).toBe(401);
  });

  it('returns 403 for accountant role (read-only access to PAYMENTS)', async () => {
    const res = await request
      .post('/payment-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymReadOnly)
      .send({ user_membership_id: 1 });
    expect(res.status).toBe(403);
  });

  it('returns 400 when user_membership_id is missing', async () => {
    const res = await request
      .post('/payment-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent user_membership_id', async () => {
    const res = await request
      .post('/payment-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ user_membership_id: 999999 });
    expect(res.status).toBe(404);
  });

  it('tenant isolation: returns 404 when user_membership_id belongs to another gym', async () => {
    const res = await request
      .post('/payment-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId)
      .send({ user_membership_id: userMembershipId });
    expect(res.status).toBe(404);
  });

  it('returns 201 with id and checkoutUrl, and the row is in the DB', async () => {
    const res = await request
      .post('/payment-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ user_membership_id: userMembershipId });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(typeof res.body.id).toBe('number');
    expect(res.body).toHaveProperty('checkoutUrl');
    expect(typeof res.body.checkoutUrl).toBe('string');
    expect(res.body.checkoutUrl).toContain('/checkout?token=');

    // Verify the row was persisted
    const { rows } = await db.query<{ id: number; status: string; gym_id: string; provider_ref: string }>(
      'SELECT id, status, gym_id, provider_ref FROM payment_requests WHERE id = ?',
      [res.body.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].gym_id).toBe(gymId);
    expect(rows[0].provider_ref).toBe('monei-test-order-123');
  });
});
