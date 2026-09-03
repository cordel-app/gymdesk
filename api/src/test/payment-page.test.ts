import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, request } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function createMember(gymId: string, name = 'Token Test Member'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
    [gymId, name, `token-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId;
}

async function createMembershipPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'closed')`,
    [gymId, `Token-Plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`],
  );
  return insertId;
}

async function createUserMembership(
  gymId: string,
  memberId: number,
  planId: number,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, final_price)
     VALUES (?, ?, ?, 'active', CURDATE(), '29.99')`,
    [gymId, memberId, planId],
  );
  return insertId;
}

async function getChargeTypeId(code = 'membership_fee'): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM charge_types WHERE code = ?', [code]);
  return rows[0].id;
}

async function insertPendingRequest(opts: {
  gymId: string;
  userMembershipId: number;
  memberId: number;
  chargeTypeId: number;
  pageToken: string;
  providerRef?: string | null;
  expiresSql?: string;
}): Promise<number> {
  const expires = opts.expiresSql ?? 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)';
  const { insertId } = await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, provider_ref, page_token, page_token_expires, source)
     VALUES (?, ?, ?, '29.99', 'EUR', ?, 'pending', 'monei',
             UUID(), ?, ?, ${expires}, 'admin')`,
    [opts.gymId, opts.userMembershipId, opts.memberId, opts.chargeTypeId, opts.providerRef ?? null, opts.pageToken],
  );
  return insertId;
}

describe('GET /payment-page/token/:token', () => {
  let gymId: string;
  let memberId: number;
  let userMembershipId: number;
  let chargeTypeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Payment Page Gym');
    memberId = await createMember(gymId, 'Ana Token');
    const planId = await createMembershipPlan(gymId);
    userMembershipId = await createUserMembership(gymId, memberId, planId);
    chargeTypeId = await getChargeTypeId();
    await db.query(
      `INSERT INTO billing_policies
         (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit,
          initial_billing_interval, initial_billing_unit,
          initial_service_interval, initial_service_unit,
          recurring_service_interval, recurring_service_unit)
       VALUES (?, ?, 1, 'month', 1, 'month', 1, 'month', 1, 'month')`,
      [gymId, planId],
    );
  });

  it('returns display fields and Monei paymentId without Clerk auth', async () => {
    const pageToken = crypto.randomUUID();
    await insertPendingRequest({
      gymId, userMembershipId, memberId, chargeTypeId,
      pageToken, providerRef: 'pay_monei_abc',
    });

    const res = await request.get(`/payment-page/token/${pageToken}`);
    expect(res.status).toBe(200);
    expect(res.body.paymentId).toBe('pay_monei_abc');
    expect(res.body.gymName).toBe('Payment Page Gym');
    expect(res.body.memberName).toBe('Ana Token');
    expect(res.body.amount).toBeCloseTo(29.99);
    expect(res.body.currency).toBe('EUR');
    expect(res.body.billingInterval).toBe('1 month');
    expect(res.body).not.toHaveProperty('id');
    expect(res.body).not.toHaveProperty('gym_id');
    expect(res.body).not.toHaveProperty('member_id');
  });

  it('consumes the token so a second request returns 404', async () => {
    const pageToken = crypto.randomUUID();
    await insertPendingRequest({
      gymId, userMembershipId, memberId, chargeTypeId,
      pageToken, providerRef: 'pay_monei_once',
    });

    const first = await request.get(`/payment-page/token/${pageToken}`);
    expect(first.status).toBe(200);

    const second = await request.get(`/payment-page/token/${pageToken}`);
    expect(second.status).toBe(404);
  });

  it('returns 404 for an expired token', async () => {
    const pageToken = crypto.randomUUID();
    await insertPendingRequest({
      gymId, userMembershipId, memberId, chargeTypeId,
      pageToken, providerRef: 'pay_monei_expired',
      expiresSql: 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)',
    });

    const res = await request.get(`/payment-page/token/${pageToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown token', async () => {
    const res = await request.get(`/payment-page/token/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the Monei paymentId was never stored', async () => {
    const pageToken = crypto.randomUUID();
    await insertPendingRequest({
      gymId, userMembershipId, memberId, chargeTypeId,
      pageToken, providerRef: null,
    });

    const res = await request.get(`/payment-page/token/${pageToken}`);
    expect(res.status).toBe(404);
  });
});
