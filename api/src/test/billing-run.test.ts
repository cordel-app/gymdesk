import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const SECRET = 'test-billing-secret';

beforeAll(() => {
  process.env.BILLING_INTERNAL_SECRET = SECRET;
});

afterEach(async () => {
  // Reset the rate-limit singleton between tests.
  await db.query('UPDATE billing_run_log SET last_run_at = NULL WHERE id = 1');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Billing Test Member', ?)`,
    [gymId, `billing-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId;
}

async function createPlanWithPolicy(gymId: string): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'closed')`,
    [gymId, `Billing-Plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`],
  );
  await db.query(
    `INSERT INTO billing_policies
       (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit,
        initial_billing_interval, initial_billing_unit,
        initial_service_interval, initial_service_unit,
        recurring_service_interval, recurring_service_unit)
     VALUES (?, ?, 1, 'month', 1, 'month', 1, 'month', 1, 'month')`,
    [gymId, planId],
  );
  return planId;
}

async function createDueMembership(
  gymId: string,
  memberId: number,
  planId: number,
  finalPrice = '29.99',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, final_price, next_billing_date)
     VALUES (?, ?, ?, 'active', '2000-01-01', ?, '2000-01-01')`,
    [gymId, memberId, planId, finalPrice],
  );
  return insertId;
}

async function insertExpiredPaymentRequest(
  gymId: string,
  userMembershipId: number,
  memberId: number,
): Promise<void> {
  const { rows: ctRows } = await db.query<{ id: number }>(
    "SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1",
  );
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, page_token, page_token_expires, source)
     VALUES (?, ?, ?, '29.99', 'EUR', ?, 'pending', 'monei', UUID(), UUID(),
             DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR), 'admin')`,
    [gymId, userMembershipId, memberId, ctRows[0].id],
  );
}

// ── POST /billing/run ─────────────────────────────────────────────────────────

describe('POST /billing/run', () => {
  it('returns 401 with missing secret', async () => {
    const res = await request.post('/billing/run');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong secret', async () => {
    const res = await request.post('/billing/run').set('x-internal-secret', 'wrong');
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid secret', async () => {
    const res = await request.post('/billing/run').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('processed');
    expect(res.body).toHaveProperty('succeeded');
    expect(res.body).toHaveProperty('failed');
  });

  it('returns 429 when run again within 23 hours', async () => {
    await request.post('/billing/run').set('x-internal-secret', SECRET);
    const res = await request.post('/billing/run').set('x-internal-secret', SECRET);
    expect(res.status).toBe(429);
  });

  // The due-memberships query uses an INNER JOIN on payment_methods.
  // A membership with no stored payment method is excluded entirely from the
  // run — no event is emitted, the membership is silently skipped.
  it('emits no event for a due membership with no payment_methods row', async () => {
    const gymId = await createTestGym('Billing No-PM Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    const planId = await createPlanWithPolicy(gymId);
    await createDueMembership(gymId, memberId, planId);

    await request.post('/billing/run').set('x-internal-secret', SECRET);

    const { rows } = await db.query(
      `SELECT id FROM billing_events WHERE member_id = ? AND gym_id = ?`,
      [memberId, gymId],
    );
    expect(rows).toHaveLength(0);
  });

  it('does not process memberships whose next_billing_date is in the future', async () => {
    const gymId = await createTestGym('Billing Future Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    const planId = await createPlanWithPolicy(gymId);
    await db.query(
      `INSERT INTO user_memberships
         (gym_id, member_id, membership_plan_id, status, starts_at, final_price, next_billing_date)
       VALUES (?, ?, ?, 'active', CURDATE(), '29.99', DATE_ADD(CURDATE(), INTERVAL 30 DAY))`,
      [gymId, memberId, planId],
    );
    await db.query(
      `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id)
       VALUES (?, ?, 'monei', 'tok_future', 'seq_future')`,
      [gymId, memberId],
    );

    await request.post('/billing/run').set('x-internal-secret', SECRET);

    const { rows } = await db.query(
      `SELECT id FROM billing_events
       WHERE member_id = ? AND gym_id = ?
         AND event_type IN ('recurring_payment', 'failed_billing')`,
      [memberId, gymId],
    );
    expect(rows).toHaveLength(0);
  });
});

// ── POST /billing/cleanup ─────────────────────────────────────────────────────

describe('POST /billing/cleanup', () => {
  it('returns 401 with missing secret', async () => {
    const res = await request.post('/billing/cleanup');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong secret', async () => {
    const res = await request.post('/billing/cleanup').set('x-internal-secret', 'wrong');
    expect(res.status).toBe(401);
  });

  it('returns 200 with expired count', async () => {
    const res = await request.post('/billing/cleanup').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(typeof res.body.expired).toBe('number');
    expect(res.body.expired).toBeGreaterThanOrEqual(0);
  });

  it('marks expired pending payment_requests as expired', async () => {
    const gymId = await createTestGym('Billing Cleanup Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    const planId = await createPlanWithPolicy(gymId);
    const userMembershipId = await createDueMembership(gymId, memberId, planId);
    await insertExpiredPaymentRequest(gymId, userMembershipId, memberId);

    const res = await request.post('/billing/cleanup').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.expired).toBeGreaterThanOrEqual(1);

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM payment_requests
       WHERE member_id = ? AND gym_id = ? AND source = 'admin'
       ORDER BY id DESC LIMIT 1`,
      [memberId, gymId],
    );
    expect(rows[0]?.status).toBe('expired');
  });
});
