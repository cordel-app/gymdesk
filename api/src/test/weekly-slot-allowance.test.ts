import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { createDraft, addCoverage } from '../api/product-sets';
import { activateWithEvents, snapshotProductSetFromPlan } from '../api/product-set-configuration';

// #3090 stage 4 (§5): GET /members/:id/personal-training-slots reports, per Professional
// Service, the sessions per week the member's own plans include, which the Professional
// Services Schedule warns against. A service held without a renewing plan line reports null.

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'M', `wsa-${uniq()}@example.com`]);
  return insertId;
}

async function service(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO professional_services (gym_id, name, is_system) VALUES (?, ?, 0)', [gymId, `WSA-PS-${uniq()}`]);
  await db.query(
    `INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`,
    [gymId, insertId]);
  return Number(insertId);
}

async function sessionProduct(serviceId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system, units)
     VALUES (?, ?, 'sessions', 0, 'EUR', 'once', 'active', 'available', 0, 1)`, [gymId, `WSA-Prod-${uniq()}`]);
  await db.query('INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)',
    [gymId, insertId, serviceId]);
  return Number(insertId);
}

/** An active plan for `owner` including each `[productId, quantity, frequency]` Session Benefit. */
async function activePlan(owner: number, lines: Array<[number, number, string | null]>): Promise<void> {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '2')`, [gymId, `WSA-Plan-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 50, '2020-01-01', 'active')`, [gymId, planId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  for (const [productId, quantity, frequency] of lines) {
    await db.query(
      'INSERT INTO membership_plan_session (gym_id, membership_plan_id, product_id, quantity, frequency) VALUES (?, ?, ?, ?, ?)',
      [gymId, planId, productId, quantity, frequency]);
  }
  await db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: Number(planId), startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: Number(planId), membershipFeePrice: 50, startsAt: TODAY });
    await addCoverage(tx, { gymId, productSetId: d.productSet.id, memberId: owner, isOwner: true });
    const out = await activateWithEvents(tx, { gymId, productSetId: d.productSet.id, today: TODAY });
    if (out.kind !== 'ok') throw new Error(out.kind);
  });
}

const getSlots = (memberId: number) =>
  request.get(`/members/${memberId}/personal-training-slots`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

beforeAll(async () => {
  gymId = await createTestGym('Weekly slot allowance gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('GET /members/:id/personal-training-slots — included_per_week', () => {
  it('reports the weekly allowance of a renewing plan line and null for a one-time one', async () => {
    const owner = await member();
    const weekly = await service();
    const fourWeekly = await service();
    const oneTime = await service();
    await activePlan(owner, [
      [await sessionProduct(weekly), 2, 'week'],
      [await sessionProduct(fourWeekly), 4, 'four_weeks'],
      [await sessionProduct(oneTime), 5, null],
    ]);

    const res = await getSlots(owner);
    expect(res.status).toBe(200);
    const byId = new Map<number, any>(res.body.professional_services.map((s: any) => [s.professional_service_id, s]));
    expect(byId.get(weekly).included_per_week).toBe(2);
    expect(byId.get(fourWeekly).included_per_week).toBe(1);
    expect(byId.get(oneTime).included_per_week).toBeNull();
  });

  it("does not count another member's plan", async () => {
    const owner = await member();
    const other = await member();
    const svc = await service();
    await activePlan(owner, [[await sessionProduct(svc), 3, 'week']]);

    const res = await getSlots(other);
    expect(res.status).toBe(200);
    expect(res.body.professional_services.find((s: any) => s.professional_service_id === svc)).toBeUndefined();
  });
});
