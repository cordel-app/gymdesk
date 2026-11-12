// #2624 stage 3 (§2) — an Assigned Plan line's Final Price includes the
// Promotion Benefit of the Promotions applied to the plan, and it is the figure
// the billing engine charges for that line (so the grid, the plan's Billing
// Event Forecast and the Billing Events cannot disagree). A line no Promotion
// covers keeps its own treatment and Direct Discount, and a benefit is never
// applied twice.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym,
  createTestMembership, request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let gymId: string;
let otherGymId: string;

async function createProduct(name: string, amount: number, frequency = 'once') {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system, tax_behavior)
     VALUES (?, ?, 'service', ?, 'EUR', ?, 'active', 'available', 0, 'inclusive')`,
    [gymId, name, amount, frequency],
  );
  return Number(insertId);
}

async function createPlan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, paid_periods)
     VALUES (?, ?, 'active', 'staff_only', 12)`,
    [gymId, `APFP Plan ${uniq()}`],
  );
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gymId, insertId],
  );
  return Number(insertId);
}

async function createPromotion(planId: number, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions
       (gym_id, name, starts_at, ends_at, lifecycle_status, stackable, only_applicable_for_new_members, paid_months)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, 0, 6)`,
    [gymId, name],
  );
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, insertId, planId],
  );
  return Number(insertId);
}

async function createAssignment(planId: number): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'APFP Member', `apfp-${uniq()}@test.com`],
  );
  return createTestDraftAssignment(gymId, Number(insertId), planId, { config: { base_price: 50 } });
}

const applyPromotion = (umId: number, promotionId: number) => request
  .post(`/user-memberships/${umId}/promotions`)
  .set('Authorization', TEST_AUTH_HEADER)
  .set('x-gym-id', gymId)
  .send({ promotion_id: promotionId });

const getDetail = (umId: number, gym = gymId) =>
  request.get(`/user-memberships/${umId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

/** The engine's charge for a Product on the forecast's first date that bills it. */
function forecastCharge(body: any, productId: number): number | undefined {
  for (const d of body.billing_event_simulation?.dates ?? []) {
    const line = d.lines.find((l: any) => l.kind === 'product' && l.product_id === productId);
    if (line) return line.actual_charge;
  }
  return undefined;
}

beforeAll(async () => {
  gymId = await createTestGym('APFP Gym');
  otherGymId = await createTestGym('APFP Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
});

describe('Assigned Plan line Final Price includes the Promotion Benefit (#2624 stage 3)', () => {
  it('takes a percentage Promotion Benefit off the covered line only, matching the forecast', async () => {
    const planId = await createPlan();
    const towel = await createProduct(`apfp-towel-${uniq()}`, 30);
    const locker = await createProduct(`apfp-locker-${uniq()}`, 20);
    for (const productId of [towel, locker]) {
      await db.query(
        'INSERT INTO membership_plan_oneoff (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, 1)',
        [gymId, planId, productId],
      );
    }
    const promotionId = await createPromotion(planId, 'APFP Half Towel');
    await db.query(
      `INSERT INTO promotion_oneoff (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`)
       VALUES (?, ?, ?, 1, 'percentage_discount', 50)`,
      [gymId, promotionId, towel],
    );
    const umId = await createAssignment(planId);

    const before = await getDetail(umId);
    expect(before.status).toBe(200);
    const towelBefore = before.body.snapshot.oneoff_benefits.find((l: any) => l.product_id === towel);
    expect(towelBefore.final_price_incl_tax).toBe(30);

    expect((await applyPromotion(umId, promotionId)).status).toBe(201);

    const res = await getDetail(umId);
    expect(res.status).toBe(200);
    const lines = res.body.snapshot.oneoff_benefits;
    const towelLine = lines.find((l: any) => l.product_id === towel);
    const lockerLine = lines.find((l: any) => l.product_id === locker);
    expect(towelLine.original_price_incl_tax).toBe(30);
    expect(towelLine.final_price_incl_tax).toBe(15);
    expect(towelLine.final_line_price_incl_tax).toBe(15);
    expect(lockerLine.final_price_incl_tax).toBe(20);
    // The grid and the Billing Events are one figure.
    expect(forecastCharge(res.body, towel)).toBe(15);

    // The section's own read (the editor's refetch) reports the same figure.
    const section = await request
      .get(`/user-memberships/${umId}/oneoff-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(section.status).toBe(200);
    expect(section.body.find((l: any) => l.product_id === towel).final_price_incl_tax).toBe(15);
  });

  it('combines the Promotion Benefit with the line Direct Discount, applied once each', async () => {
    const planId = await createPlan();
    const pass = await createProduct(`apfp-pass-${uniq()}`, 40);
    await db.query(
      `INSERT INTO membership_plan_oneoff (gym_id, membership_plan_id, product_id, quantity, direct_discount_percent)
       VALUES (?, ?, ?, 1, 10)`,
      [gymId, planId, pass],
    );
    const promotionId = await createPromotion(planId, 'APFP Quarter Pass');
    await db.query(
      `INSERT INTO promotion_oneoff (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`)
       VALUES (?, ?, ?, 1, 'percentage_discount', 25)`,
      [gymId, promotionId, pass],
    );
    const umId = await createAssignment(planId);
    expect((await applyPromotion(umId, promotionId)).status).toBe(201);

    const res = await getDetail(umId);
    const line = res.body.snapshot.oneoff_benefits.find((l: any) => l.product_id === pass);
    // €40 → 25% Promotion Benefit → €30 → 10% Direct Discount → €27.
    expect(line.final_price_incl_tax).toBe(27);
    expect(forecastCharge(res.body, pass)).toBe(27);
  });

  it('reads a waiving Promotion Benefit on a recurring line as €0 for the covered cycle', async () => {
    const planId = await createPlan();
    const locker = await createProduct(`apfp-monthly-locker-${uniq()}`, 15, 'month');
    await db.query(
      'INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, 1)',
      [gymId, planId, locker],
    );
    const promotionId = await createPromotion(planId, 'APFP Free Locker');
    await db.query(
      `INSERT INTO promotion_periodical (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`)
       VALUES (?, ?, ?, 3, 'waive', NULL)`,
      [gymId, promotionId, locker],
    );
    const umId = await createAssignment(planId);
    expect((await applyPromotion(umId, promotionId)).status).toBe(201);

    const res = await getDetail(umId);
    const line = res.body.snapshot.periodical_benefits.find((l: any) => l.product_id === locker);
    expect(line.original_price_incl_tax).toBe(15);
    expect(line.final_price_incl_tax).toBe(0);
    expect(forecastCharge(res.body, locker)).toBe(0);
  });

  it('does not reveal another gym\'s assignment', async () => {
    const planId = await createPlan();
    const umId = await createAssignment(planId);
    expect((await getDetail(umId, otherGymId)).status).toBe(404);
  });
});
