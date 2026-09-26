// #635 stage 8 — the assignment's own Billing & Duration decides what it bills.
//
// Stage 1 added Free Period / Paid Duration / Bonus Duration to a Membership
// Plan and stage 2 froze them onto every assignment, but nothing read them: a
// Plan sold with a free first month billed its full fee on day one. §7 asks for
// "the same semantics as the Promotion configuration", and the thread's Q2
// answer settles the collision — "in case of conflict, prioritize the
// promotion".
//
// Integration, not unit: what is under test is which row the simulation reads
// its durations from (the assignment's own, the Plan's live ones, or neither)
// and what an edit of one does to the other. The classification arithmetic is
// unit-tested in `plan-duration.test.ts` and the engine in
// `billing-simulation.test.ts`.

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

/** A fixed start date, so the projected dates in the assertions are stable. */
const START = '2026-03-10';
const MONTHS = ['2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10', '2026-07-10', '2026-08-10'];

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Duration Member', `apdb-${uniq()}@test.com`],
  );
  return insertId;
}

async function createPlan(gymId: string, durations: {
  free?: number | null; paid?: number | null; bonus?: number | null;
} = {}): Promise<number> {
  const { free = null, paid = null, bonus = null } = durations;
  const { insertId } = await db.query(
    `INSERT INTO membership_plans
       (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_months, paid_months, bonus_months)
     VALUES (?, ?, 'active', 'public', '1', ?, ?, ?)`,
    [gymId, `APDB-Plan-${uniq()}`, free, paid, bonus],
  );
  const planId = insertId;
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 100, '2025-01-01', 'active')`,
    [gymId, planId],
  );
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gymId, planId],
  );
  return planId;
}

const assign = (gymId: string, body: Record<string, unknown>) =>
  request.post('/user-memberships')
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send(body);

const getSimulation = (gymId: string, memberId: number) =>
  request.get(`/user-memberships/member/${memberId}/billing-simulation`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

const putBillingDuration = (gymId: string, umId: number, body: Record<string, unknown>) =>
  request.put(`/user-memberships/${umId}/billing-duration`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send(body);

const monthlySection = (body: any) => body.sections.find((s: any) => s.section === 'month');

/** The Membership Fee line of every projected monthly event, as [date, charge]. */
function feeEvents(body: any): [string, number][] {
  return (monthlySection(body)?.events ?? []).map((e: any) => {
    const fee = e.lines.find((l: any) => l.kind === 'membership_fee');
    return [e.date, fee?.actual_charge];
  });
}

function feeBenefits(body: any, index: number): any[] {
  return monthlySection(body).events[index].lines.find((l: any) => l.kind === 'membership_fee').benefits;
}

// ─── The assignment bills its frozen Billing & Duration ──────────────────────

describe('Billing Simulation — the assignment bills its own Billing & Duration', () => {
  let gymId: string;
  let memberId: number;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('APDB Duration Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
    planId = await createPlan(gymId, { free: 1, paid: 2, bonus: 2 });
    const res = await assign(gymId, { member_id: memberId, membership_plan_id: planId, starts_at: START });
    expect(res.status).toBe(201);
  });

  it('waives the Membership Fee for the Free Period and the Bonus Duration', async () => {
    const res = await getSimulation(gymId, memberId);
    expect(res.status).toBe(200);
    expect(feeEvents(res.body)).toEqual([
      [MONTHS[0], 0],   // free
      [MONTHS[1], 100], // paid
      [MONTHS[2], 100], // paid
      [MONTHS[3], 0],   // bonus
      [MONTHS[4], 0],   // bonus
      [MONTHS[5], 100], // regular, and the horizon
    ]);
    expect(res.body.horizon_date).toBe(MONTHS[5]);
  });

  it('explains each waived charge as the Plan\'s own period, not a Promotion', async () => {
    const { body } = await getSimulation(gymId, memberId);
    expect(feeBenefits(body, 0)).toEqual([{
      source: 'membership_plan', name: null, action: 'waive', value: null, period_status: 'free_plan',
    }]);
    expect(feeBenefits(body, 3)[0]).toMatchObject({ source: 'membership_plan', period_status: 'bonus_plan' });
    expect(feeBenefits(body, 1)).toEqual([]);
    expect(feeBenefits(body, 5)).toEqual([]);
  });

  // §13 — the row it reads is its own, so the catalogue can move underneath it.
  it('does not follow a later change to the Plan\'s Billing & Duration', async () => {
    const before = (await getSimulation(gymId, memberId)).body;
    await db.query(
      'UPDATE membership_plans SET free_months = 12, paid_months = 0, bonus_months = 0 WHERE id = ?',
      [planId],
    );
    expect((await getSimulation(gymId, memberId)).body).toEqual(before);
  });
});

// ─── §15 — editing one assignment's durations moves that assignment only ─────

describe('PUT /user-memberships/:id/billing-duration — the edit stays on the assignment', () => {
  let gymId: string;
  let planId: number;
  let memberA: number;
  let memberB: number;
  let umA: number;

  beforeAll(async () => {
    gymId = await createTestGym('APDB Edit Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, { free: 0, paid: 12, bonus: 0 });
    memberA = await createMember(gymId);
    memberB = await createMember(gymId);
    const a = await assign(gymId, { member_id: memberA, membership_plan_id: planId, starts_at: START });
    const b = await assign(gymId, { member_id: memberB, membership_plan_id: planId, starts_at: START });
    expect([a.status, b.status]).toEqual([201, 201]);
    umA = a.body.id;
  });

  it('bills the edited Free Period from the next simulation onwards', async () => {
    expect(feeEvents((await getSimulation(gymId, memberA)).body)).toEqual([[MONTHS[0], 100]]);

    const res = await putBillingDuration(gymId, umA, { free_months: 2 });
    expect(res.status).toBe(200);

    expect(feeEvents((await getSimulation(gymId, memberA)).body)).toEqual([
      [MONTHS[0], 0], [MONTHS[1], 0], [MONTHS[2], 100],
    ]);
  });

  it('leaves the other assignment of the same Plan, and the Plan itself, untouched', async () => {
    expect(feeEvents((await getSimulation(gymId, memberB)).body)).toEqual([[MONTHS[0], 100]]);
    const { rows } = await db.query(
      'SELECT free_months, paid_months, bonus_months FROM membership_plans WHERE id = ?',
      [planId],
    );
    expect(rows[0]).toMatchObject({ free_months: 0, paid_months: 12, bonus_months: 0 });
  });
});

// ─── The live fallback, for an assignment that captured no snapshot ──────────

describe('Billing Simulation — an assignment with no snapshot reads the Plan\'s live durations', () => {
  let gymId: string;
  let memberId: number;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('APDB Legacy Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
    planId = await createPlan(gymId, { free: 1, paid: 0, bonus: 0 });
    // The shape a row created before migration 174 has: none of the six
    // snapshot columns set, and no benefit rows of its own.
    await db.query(
      `INSERT INTO user_memberships
         (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
       VALUES (?, ?, ?, 'active', ?, 0)`,
      [gymId, memberId, planId, START],
    );
  });

  it('waives the first charge from the Plan, because it has no durations of its own', async () => {
    const { body } = await getSimulation(gymId, memberId);
    expect(feeEvents(body)).toEqual([[MONTHS[0], 0], [MONTHS[1], 100]]);
    expect(feeBenefits(body, 0)[0]).toMatchObject({ source: 'membership_plan', period_status: 'free_plan' });
  });

  it('stops following the Plan as soon as it captures a snapshot of its own', async () => {
    const { rows } = await db.query(
      'SELECT id FROM user_memberships WHERE member_id = ? AND gym_id = ?',
      [memberId, gymId],
    );
    // An explicit edit materialises the snapshot first (stage 6), so the
    // assignment now owns every section — including the durations it had been
    // reading live.
    expect((await putBillingDuration(gymId, rows[0].id, { bonus_months: 1 })).status).toBe(200);
    await db.query('UPDATE membership_plans SET free_months = 6 WHERE id = ?', [planId]);

    const { body } = await getSimulation(gymId, memberId);
    expect(feeEvents(body)).toEqual([[MONTHS[0], 0], [MONTHS[1], 0], [MONTHS[2], 100]]);
    expect(feeBenefits(body, 1)[0]).toMatchObject({ period_status: 'bonus_plan' });
  });
});

// ─── Q2 — "in case of conflict, prioritize the promotion" ────────────────────

describe('Billing Simulation — a Promotion outranks the Plan\'s own Billing & Duration', () => {
  let gymId: string;
  let memberId: number;
  let planId: number;
  let umId: number;
  let promotionId: number;
  let promotionName: string;

  beforeAll(async () => {
    gymId = await createTestGym('APDB Promotion Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
    planId = await createPlan(gymId, { free: 3, paid: 0, bonus: 0 });
    const res = await assign(gymId, { member_id: memberId, membership_plan_id: planId, starts_at: START });
    expect(res.status).toBe(201);
    umId = res.body.id;

    promotionName = `APDB-Promo-${uniq()}`;
    const { insertId } = await db.query(
      `INSERT INTO promotions
         (gym_id, name, lifecycle_status, stackable, only_applicable_for_new_members,
          starts_at, ends_at, free_months, paid_months, bonus_months, pay_beforehand_months)
       VALUES (?, ?, 'active', 1, 0, '2025-01-01', '2030-01-01', 0, 2, 0, 0)`,
      [gymId, promotionName],
    );
    promotionId = insertId;
    await db.query(
      'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promotionId, planId],
    );
    // A paid promotional window at a fixed price: the Promotion charges money
    // where the Plan alone would have charged nothing.
    await db.query(
      `INSERT INTO promotion_membership_fee_benefits
         (gym_id, promotion_id, action, value, enabled, duration_months)
       VALUES (?, ?, 'fixed_price', 80, 1, NULL)`,
      [gymId, promotionId],
    );
    const applied = await request.post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ promotion_id: promotionId });
    expect(applied.status).toBe(201);
    // The Promotion's own timeline is anchored on the date it was applied, so
    // the application is backdated to the assignment's start date — otherwise
    // the promotional window would begin in whatever month the suite runs in
    // and the two configurations would never overlap.
    await db.query(
      'UPDATE user_membership_promotions SET applied_at = ? WHERE user_membership_id = ? AND gym_id = ?',
      [START, umId, gymId],
    );
  });

  it('charges the Promotion\'s price inside the Plan\'s Free Period', async () => {
    const { body } = await getSimulation(gymId, memberId);
    const benefits = feeBenefits(body, 0);
    expect(benefits).toHaveLength(1);
    expect(benefits[0]).toMatchObject({
      source: 'promotion', name: promotionName, action: 'fixed_price', value: 80, period_status: 'pay_promotion',
    });
    expect(feeEvents(body)[0]).toEqual([MONTHS[0], 80]);
  });

  it('falls back to the Plan\'s own Free Period once the Promotion\'s window ends', async () => {
    const { body } = await getSimulation(gymId, memberId);
    // Two promotional months at 80, then the Plan's third free month, then the
    // first regular charge.
    expect(feeEvents(body)).toEqual([
      [MONTHS[0], 80], [MONTHS[1], 80], [MONTHS[2], 0], [MONTHS[3], 100],
    ]);
    expect(feeBenefits(body, 2)[0]).toMatchObject({ source: 'membership_plan', period_status: 'free_plan' });
  });

  it('applies the Plan\'s own period again after the Promotion is revoked', async () => {
    const revoked = await request.delete(`/user-memberships/${umId}/promotions/${promotionId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(revoked.status).toBe(200);

    const { body } = await getSimulation(gymId, memberId);
    expect(feeEvents(body)).toEqual([[MONTHS[0], 0], [MONTHS[1], 0], [MONTHS[2], 0], [MONTHS[3], 100]]);
    expect(feeBenefits(body, 0)[0]).toMatchObject({ source: 'membership_plan', period_status: 'free_plan' });
  });
});

// ─── Tenant isolation ───────────────────────────────────────────────────────

describe('Billing Simulation — tenant isolation and auth', () => {
  let gymA: string;
  let gymB: string;
  let memberId: number;

  beforeAll(async () => {
    gymA = await createTestGym('APDB Tenant A');
    gymB = await createTestGym('APDB Tenant B');
    await createTestMembership(gymA, 'admin');
    await createTestMembership(gymB, 'admin');
    memberId = await createMember(gymA);
    const planId = await createPlan(gymA, { free: 1 });
    expect((await assign(gymA, { member_id: memberId, membership_plan_id: planId, starts_at: START })).status).toBe(201);
  });

  it('does not simulate another gym\'s member', async () => {
    expect((await getSimulation(gymB, memberId)).status).toBe(404);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request.get(`/user-memberships/member/${memberId}/billing-simulation`).set('x-gym-id', gymA);
    expect(res.status).toBe(401);
  });
});
