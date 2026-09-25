// #635 stage 13 — the Membership Plan's Pre-paid Duration.
//
// The thread's answer to the stage 13 question adds a fourth field to Billing
// & Duration: "I'd also like to include the pre-paid duration which will flag
// in the simulation as pre-paid - no charge". It is the Promotion's own
// `pay_beforehand_months` (migration 141) on a Plan: the first N months of the
// Paid Duration are already paid up front, so they charge nothing while the
// rest of the Paid Duration still charges the regular fee.
//
// Integration, not unit: what is under test is the column's journey — the Plan
// editor writes it, an assignment freezes it (§11), the Billing Simulation
// reads the assignment's own copy and never the Plan's later one (§13), and an
// edit of one assignment stays on it (§15). The classification arithmetic is
// unit-tested in `plan-duration.test.ts`, and what the nightly run does with a
// prepaid cycle is in `billing-run-waived.test.ts`.

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

/** Fixed start date, so the projected dates in the assertions are stable. */
const START = '2026-03-10';
const MONTHS = ['2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10', '2026-07-10'];

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Prepaid Member', `ppd-${uniq()}@test.com`],
  );
  return insertId;
}

async function createPlan(gymId: string, durations: {
  free?: number | null; paid?: number | null; bonus?: number | null; prepaid?: number | null;
} = {}): Promise<number> {
  const { free = null, paid = null, bonus = null, prepaid = null } = durations;
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans
       (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_months, paid_months, bonus_months, pay_beforehand_months)
     VALUES (?, ?, 'active', 'public', '1', ?, ?, ?, ?)`,
    [gymId, `PPD-Plan-${uniq()}`, free, paid, bonus, prepaid],
  );
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

const putPlan = (gymId: string, planId: number, body: Record<string, unknown>) =>
  request.put(`/membership-plans/${planId}`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send(body);

const putBillingDuration = (gymId: string, umId: number, body: Record<string, unknown>) =>
  request.put(`/user-memberships/${umId}/billing-duration`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send(body);

const getSimulation = (gymId: string, memberId: number) =>
  request.get(`/user-memberships/member/${memberId}/billing-simulation`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

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

// ─── The Plan carries the field ──────────────────────────────────────────────

describe('PUT /membership-plans/:id — Pre-paid Duration', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PPD Plan Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, { free: 0, paid: 12, bonus: 0 });
  });

  it('stores it alongside the other three durations', async () => {
    const res = await putPlan(gymId, planId, {
      free_months: 1, paid_months: 12, pay_beforehand_months: 3, bonus_months: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      free_months: 1, paid_months: 12, pay_beforehand_months: 3, bonus_months: 2,
    });
  });

  it('clears it back to "not configured" when the field is emptied', async () => {
    const res = await putPlan(gymId, planId, { pay_beforehand_months: null });
    expect(res.status).toBe(200);
    expect(res.body.pay_beforehand_months).toBeNull();
  });

  it('rejects a negative value', async () => {
    const res = await putPlan(gymId, planId, { pay_beforehand_months: -1 });
    expect(res.status).toBe(400);
  });

  // The Promotion's own 0..paid_months bound (`validatePayBeforehandMonths`):
  // a Pre-paid month is a month of the Paid Duration, so there cannot be more
  // of them than there are paid months to pay for.
  it('rejects more pre-paid months than paid ones, in one payload', async () => {
    const res = await putPlan(gymId, planId, { paid_months: 2, pay_beforehand_months: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pay_beforehand_months/);
  });

  it('rejects it against the stored Paid Duration when only one field is sent', async () => {
    expect((await putPlan(gymId, planId, { paid_months: 6, pay_beforehand_months: 6 })).status).toBe(200);
    // Only the prepaid months move: 7 > the stored 6.
    expect((await putPlan(gymId, planId, { pay_beforehand_months: 7 })).status).toBe(400);
    // Only the paid months move: the stored 6 prepaid would outlast them.
    expect((await putPlan(gymId, planId, { paid_months: 5 })).status).toBe(400);
  });

  // A Plan with no Paid Duration has no months to prepay, and `null` must not
  // slip through the comparison as "unbounded" (the DB CHECK in migration 189
  // says the same thing, so this can never be stored either way).
  it('rejects pre-paid months on a Plan with no Paid Duration at all', async () => {
    const plan = await createPlan(gymId, { free: 1, paid: null, bonus: null });
    const res = await putPlan(gymId, plan, { pay_beforehand_months: 2 });
    expect(res.status).toBe(400);
    const { rows } = await db.query(
      'SELECT pay_beforehand_months FROM membership_plans WHERE id = ?', [plan],
    );
    expect(rows[0].pay_beforehand_months).toBeNull();
  });

  it('is invisible to another gym', async () => {
    const otherGym = await createTestGym('PPD Other Gym');
    await createTestMembership(otherGym, 'admin');
    const res = await putPlan(otherGym, planId, { pay_beforehand_months: 1 });
    expect(res.status).toBe(404);
  });

  it('carries over to a duplicated Plan', async () => {
    expect((await putPlan(gymId, planId, { paid_months: 6, pay_beforehand_months: 2 })).status).toBe(200);
    const res = await request.post(`/membership-plans/${planId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.pay_beforehand_months).toBe(2);
  });
});

// ─── The assignment freezes it and bills on it ───────────────────────────────

describe('Billing Simulation — a Pre-paid month charges nothing', () => {
  let gymId: string;
  let memberId: number;
  let planId: number;
  let umId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PPD Billing Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
    // free 1 · paid 3, of which 2 are pre-paid · bonus 0.
    planId = await createPlan(gymId, { free: 1, paid: 3, bonus: 0, prepaid: 2 });
    const res = await assign(gymId, { member_id: memberId, membership_plan_id: planId, starts_at: START });
    expect(res.status).toBe(201);
    umId = res.body.id;
  });

  it('freezes the Plan\'s Pre-paid Duration onto the assignment (§11)', async () => {
    const { rows } = await db.query(
      'SELECT pay_beforehand_months FROM user_memberships WHERE id = ?', [umId],
    );
    expect(Number(rows[0].pay_beforehand_months)).toBe(2);
  });

  it('charges the free month, then the two pre-paid ones, at 0', async () => {
    const res = await getSimulation(gymId, memberId);
    expect(res.status).toBe(200);
    expect(feeEvents(res.body)).toEqual([
      [MONTHS[0], 0],   // free
      [MONTHS[1], 0],   // pre-paid
      [MONTHS[2], 0],   // pre-paid
      [MONTHS[3], 100], // the remaining paid month — and the horizon
    ]);
  });

  it('labels a pre-paid month as the Plan\'s own pre-paid period, not a waiver of the fee', async () => {
    const { body } = await getSimulation(gymId, memberId);
    expect(feeBenefits(body, 1)).toEqual([{
      source: 'membership_plan', name: null, action: 'waive', value: null, period_status: 'prepaid_plan',
    }]);
    expect(feeBenefits(body, 0)[0]).toMatchObject({ period_status: 'free_plan' });
    expect(feeBenefits(body, 3)).toEqual([]);
  });

  // §13 — the assignment reads its own frozen column, so the catalogue can move.
  it('does not follow a later change to the Plan\'s Pre-paid Duration', async () => {
    const before = (await getSimulation(gymId, memberId)).body;
    expect((await putPlan(gymId, planId, { pay_beforehand_months: 0 })).status).toBe(200);
    expect((await getSimulation(gymId, memberId)).body).toEqual(before);
  });
});

// ─── §15 — editing one assignment's Pre-paid Duration ────────────────────────

describe('PUT /user-memberships/:id/billing-duration — Pre-paid Duration', () => {
  let gymId: string;
  let planId: number;
  let memberA: number;
  let memberB: number;
  let umA: number;

  beforeAll(async () => {
    gymId = await createTestGym('PPD Edit Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, { free: 0, paid: 12, bonus: 0, prepaid: 0 });
    memberA = await createMember(gymId);
    memberB = await createMember(gymId);
    const a = await assign(gymId, { member_id: memberA, membership_plan_id: planId, starts_at: START });
    const b = await assign(gymId, { member_id: memberB, membership_plan_id: planId, starts_at: START });
    expect([a.status, b.status]).toEqual([201, 201]);
    umA = a.body.id;
  });

  it('stops charging the months it now covers', async () => {
    expect(feeEvents((await getSimulation(gymId, memberA)).body)).toEqual([[MONTHS[0], 100]]);

    const res = await putBillingDuration(gymId, umA, { pay_beforehand_months: 2 });
    expect(res.status).toBe(200);
    expect(res.body.pay_beforehand_months).toBe(2);

    expect(feeEvents((await getSimulation(gymId, memberA)).body)).toEqual([
      [MONTHS[0], 0], [MONTHS[1], 0], [MONTHS[2], 100],
    ]);
  });

  it('leaves the other assignment of the same Plan, and the Plan itself, untouched', async () => {
    expect(feeEvents((await getSimulation(gymId, memberB)).body)).toEqual([[MONTHS[0], 100]]);
    const { rows } = await db.query(
      'SELECT pay_beforehand_months FROM membership_plans WHERE id = ?', [planId],
    );
    expect(Number(rows[0].pay_beforehand_months)).toBe(0);
  });

  it('rejects more pre-paid months than the assignment\'s Paid Duration', async () => {
    const res = await putBillingDuration(gymId, umA, { pay_beforehand_months: 13 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pay_beforehand_months/);

    // Rejected inside the transaction, so nothing of the payload landed.
    const { rows } = await db.query(
      'SELECT pay_beforehand_months FROM user_memberships WHERE id = ?', [umA],
    );
    expect(Number(rows[0].pay_beforehand_months)).toBe(2);
  });

  it('rejects a Paid Duration shorter than the pre-paid months already agreed', async () => {
    expect((await putBillingDuration(gymId, umA, { paid_months: 1 })).status).toBe(400);
  });
});
