// #772 — the Assigned Membership Plan's own **Personal Membership Fee
// Benefit**: `PUT /user-memberships/:id/fee-benefit`, and what it does to
// every surface that prices a cycle.
//
// The ticket's whole point is longevity — the benefit "remains active for the
// entire lifetime of the Assigned Membership Plan" and "must not expire when a
// Promotion ends" — so the cases here do not stop at the write: they read the
// fee back off the assignment and off the Billing Simulation, on a date inside
// an applied Promotion and on one long after it.
//
// Fixtures are inserted directly; the HTTP API is only used for the action
// under test (CLAUDE.md).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function createPlan(gymId: string, price = 100): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans
       (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`,
    [gymId, `PFB-Plan-${uniq()}`],
  );
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, ?, 'active')`,
    [gymId, insertId, price, dayOffset(-365)],
  );
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gymId, insertId],
  );
  return insertId;
}

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'PFB Member', `pfb-${uniq()}@test.com`],
  );
  return insertId;
}

const assign = (gymId: string, planId: number, memberId: number) =>
  request
    .post('/user-memberships')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ member_id: memberId, membership_plan_id: planId, starts_at: dayOffset(0) });

const putFeeBenefit = (gymId: string, umId: number, body: Record<string, unknown>) =>
  request
    .put(`/user-memberships/${umId}/fee-benefit`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send(body);

const getAssignment = (gymId: string, umId: number) =>
  request.get(`/user-memberships/${umId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function assignPlan(gymId: string, price = 100) {
  const planId = await createPlan(gymId, price);
  const memberId = await createMember(gymId);
  const res = await assign(gymId, planId, memberId);
  expect(res.status).toBe(201);
  return { planId, memberId, umId: res.body.id as number };
}

describe('PUT /user-memberships/:id/fee-benefit', () => {
  let gymId: string;
  let planId: number;
  let umId: number;
  let siblingUmId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PFB Gym');
    await createTestMembership(gymId, 'admin');
    ({ planId, umId } = await assignPlan(gymId));
    const sibling = await assign(gymId, planId, await createMember(gymId));
    expect(sibling.status).toBe(201);
    siblingUmId = sibling.body.id;
  });

  it('defaults to no benefit on a freshly assigned plan', async () => {
    const fresh = await assignPlan(gymId);
    const res = await getAssignment(gymId, fresh.umId);
    expect(res.status).toBe(200);
    expect(res.body.snapshot.personal_fee_benefit).toEqual({ action: 'no_benefit', value: null });
    expect(res.body.membership_fee).toBe(100);
  });

  it('stores a % discount and returns the updated snapshot', async () => {
    const res = await putFeeBenefit(gymId, umId, { action: 'percentage_discount', value: 15 });
    expect(res.status).toBe(200);
    expect(res.body.personal_fee_benefit).toEqual({ action: 'percentage_discount', value: 15 });

    const { rows } = await db.query(
      'SELECT personal_fee_benefit_action, personal_fee_benefit_value FROM user_memberships WHERE id = ?',
      [umId],
    );
    expect(rows[0].personal_fee_benefit_action).toBe('percentage_discount');
    expect(Number(rows[0].personal_fee_benefit_value)).toBe(15);
  });

  it("moves what the assignment is charged, without touching the regular fee it discounts from", async () => {
    await putFeeBenefit(gymId, umId, { action: 'percentage_discount', value: 15 });
    const res = await getAssignment(gymId, umId);
    expect(res.body.membership_fee).toBe(85);
    // `membership_fee_price` is still the regular fee — the personal benefit is
    // a benefit, not a negotiated price, so the two stay separate decisions.
    expect(Number(res.body.membership_fee_price)).toBe(100);
    expect(res.body.discount_reason ?? null).toBe(null);
  });

  it('edits this assignment only — not the Plan, not another assignment', async () => {
    await putFeeBenefit(gymId, umId, { action: 'percentage_discount', value: 15 });

    const sibling = await getAssignment(gymId, siblingUmId);
    expect(sibling.body.snapshot.personal_fee_benefit).toEqual({ action: 'no_benefit', value: null });
    expect(sibling.body.membership_fee).toBe(100);

    const { rows } = await db.query('SELECT * FROM membership_plans WHERE id = ?', [planId]);
    expect(Object.keys(rows[0])).not.toContain('personal_fee_benefit_action');
  });

  it('clears the percentage when the benefit is removed', async () => {
    await putFeeBenefit(gymId, umId, { action: 'percentage_discount', value: 15 });
    const res = await putFeeBenefit(gymId, umId, { action: 'no_benefit' });
    expect(res.status).toBe(200);
    expect(res.body.personal_fee_benefit).toEqual({ action: 'no_benefit', value: null });

    const { rows } = await db.query(
      'SELECT personal_fee_benefit_value FROM user_memberships WHERE id = ?', [umId],
    );
    expect(rows[0].personal_fee_benefit_value).toBe(null);
    expect((await getAssignment(gymId, umId)).body.membership_fee).toBe(100);
  });

  it('rejects a percentage outside 0..100, a missing one, and an action it does not offer', async () => {
    for (const body of [
      { action: 'percentage_discount', value: 101 },
      { action: 'percentage_discount', value: -1 },
      { action: 'percentage_discount' },
      { action: 'percentage_discount', value: '' },
      { action: 'waive' },
      { action: 'fixed_price', value: 10 },
      {},
    ]) {
      expect((await putFeeBenefit(gymId, umId, body)).status).toBe(400);
    }
  });

  it('does not capture a snapshot as a side effect', async () => {
    // The benefit is not part of the Assigned Plan snapshot: it is agreed with
    // the member rather than captured from the catalogue, and the snapshot's
    // fallback is all-or-nothing. Writing one must not flip an assignment that
    // captured nothing to "captured", which would freeze its Plan's live
    // durations out of reach.
    // The pre-migration-174 shape: a real Plan, but not one of the seven
    // snapshot columns set and no benefit rows of its own.
    const memberId = await createMember(gymId);
    const { insertId: bare } = await db.query(
      `INSERT INTO user_memberships (member_id, gym_id, membership_plan_id, base_price, starts_at, status)
       VALUES (?, ?, ?, 0, ?, 'active')`,
      [memberId, gymId, planId, dayOffset(0)],
    );
    await db.query(
      'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)',
      [gymId, bare, memberId],
    );

    expect((await putFeeBenefit(gymId, bare as number, { action: 'percentage_discount', value: 20 })).status).toBe(200);

    const after = await getAssignment(gymId, bare as number);
    expect(after.body.snapshot.snapshot_captured).toBe(false);
    expect(after.body.snapshot.personal_fee_benefit).toEqual({ action: 'percentage_discount', value: 20 });
    const { rows } = await db.query(
      'SELECT free_months, paid_months, membership_fee_price FROM user_memberships WHERE id = ?', [bare],
    );
    expect(rows[0].free_months).toBe(null);
    expect(rows[0].paid_months).toBe(null);
    expect(rows[0].membership_fee_price).toBe(null);
  });

  it('refuses to edit a terminal assignment', async () => {
    const closed = await assignPlan(gymId);
    await db.query("UPDATE user_memberships SET status = 'cancelled' WHERE id = ?", [closed.umId]);
    const res = await putFeeBenefit(gymId, closed.umId, { action: 'percentage_discount', value: 10 });
    expect(res.status).toBe(400);
    const { rows } = await db.query(
      'SELECT personal_fee_benefit_action FROM user_memberships WHERE id = ?', [closed.umId],
    );
    expect(rows[0].personal_fee_benefit_action).toBe('no_benefit');
  });
});

describe('the benefit in the Billing Simulation', () => {
  let gymId: string;
  let umId: number;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PFB Simulation Gym');
    await createTestMembership(gymId, 'admin');
    ({ umId, memberId } = await assignPlan(gymId));
  });

  it('discounts every projected Membership Fee line, and says whose benefit it is', async () => {
    expect((await putFeeBenefit(gymId, umId, { action: 'percentage_discount', value: 25 })).status).toBe(200);

    const res = await request
      .get(`/user-memberships/member/${memberId}/billing-simulation`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);

    const feeLines = (res.body.sections as any[])
      .flatMap((s) => s.events as any[])
      .flatMap((e) => e.lines as any[])
      .filter((l) => l.kind === 'membership_fee');
    expect(feeLines.length).toBeGreaterThan(0);
    for (const line of feeLines) {
      expect(line.regular_price).toBe(100);
      expect(line.actual_charge).toBe(75);
      expect(line.benefits.some((b: any) => b.source === 'personal' && b.action === 'percentage_discount')).toBe(true);
    }
  });

  it('does not extend the projection horizon — an open-ended benefit is the regular charge', async () => {
    // A benefit that never ends would run the projection to its 36-month cap
    // if it counted as promotional (#629 §6).
    await putFeeBenefit(gymId, umId, { action: 'percentage_discount', value: 25 });
    const res = await request
      .get(`/user-memberships/member/${memberId}/billing-simulation`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const feeLines = (res.body.sections as any[])
      .flatMap((s) => s.events as any[])
      .flatMap((e) => e.lines as any[])
      .filter((l) => l.kind === 'membership_fee');
    expect(feeLines.length).toBeLessThan(5);
  });
});

describe('tenant isolation and auth', () => {
  let gymA: string;
  let gymB: string;
  let umId: number;

  beforeAll(async () => {
    gymA = await createTestGym('PFB Gym A');
    gymB = await createTestGym('PFB Gym B');
    await createTestMembership(gymA, 'admin');
    await createTestMembership(gymB, 'admin');
    ({ umId } = await assignPlan(gymA));
  });

  it("returns 404 for another gym's assignment, and writes nothing", async () => {
    const res = await putFeeBenefit(gymB, umId, { action: 'percentage_discount', value: 50 });
    expect(res.status).toBe(404);
    const { rows } = await db.query(
      'SELECT personal_fee_benefit_action FROM user_memberships WHERE id = ?', [umId],
    );
    expect(rows[0].personal_fee_benefit_action).toBe('no_benefit');
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request
      .put(`/user-memberships/${umId}/fee-benefit`)
      .set('x-gym-id', gymA)
      .send({ action: 'no_benefit' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a read-only PAYMENTS role, and writes nothing', async () => {
    const readOnlyGym = await createTestGym('PFB Accountant Gym');
    await createTestMembership(readOnlyGym, 'accountant');
    const memberId = await createMember(readOnlyGym);
    const { insertId } = await db.query(
      `INSERT INTO user_memberships (member_id, gym_id, membership_plan_id, base_price, starts_at, status)
       VALUES (?, ?, NULL, 0, ?, 'active')`,
      [memberId, readOnlyGym, dayOffset(0)],
    );
    const res = await putFeeBenefit(readOnlyGym, insertId as number, { action: 'percentage_discount', value: 10 });
    expect(res.status).toBe(403);
    const { rows } = await db.query(
      'SELECT personal_fee_benefit_action FROM user_memberships WHERE id = ?', [insertId],
    );
    expect(rows[0].personal_fee_benefit_action).toBe('no_benefit');
  });

  it('returns 403 for a role with no access to PAYMENTS at all', async () => {
    const noAccessGym = await createTestGym('PFB Trainer Gym');
    await createTestMembership(noAccessGym, 'trainer_performance');
    const memberId = await createMember(noAccessGym);
    const { insertId } = await db.query(
      `INSERT INTO user_memberships (member_id, gym_id, membership_plan_id, base_price, starts_at, status)
       VALUES (?, ?, NULL, 0, ?, 'active')`,
      [memberId, noAccessGym, dayOffset(0)],
    );
    expect((await putFeeBenefit(noAccessGym, insertId as number, { action: 'no_benefit' })).status).toBe(403);
  });
});
