// #2779 — an expanded Past Plan in the Members App shows the Product lines and the
// Promotions the plan was agreed with, read from its snapshots only.
//
// Integration rather than unit, because what is under test is *which rows* the
// endpoint reads: a catalogue Product, Promotion or Plan edited after the plan ended
// must move nothing. The shaping is pure and unit-tested in
// `past-plan-details.unit.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  legacyAssignmentQuery,
  legacyChildQuery,
  request,
} from './helpers';

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const getMembership = (gymId: string) =>
  request.get('/me/membership').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function createCallingMember(gymId: string): Promise<number> {
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id)
     VALUES (?, 'Past Plan Member', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, `past-plan-${uniq()}@test.com`, TEST_USER_ID],
  );
  const { rows } = await db.query<{ id: number }>('SELECT id FROM members WHERE clerk_user_id = ?', [TEST_USER_ID]);
  await db.query(
    "UPDATE user_memberships SET status = 'cancelled' WHERE member_id = ? AND status IN ('active', 'paused')",
    [rows[0].id],
  );
  return rows[0].id;
}

async function createPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`,
    [gymId, `Past-Plan-${uniq()}`],
  );
  return insertId;
}

async function createProduct(gymId: string, name: string, type: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, ?, 30, 'EUR', 'month', 'active', 'available', 0)`,
    [gymId, name, type],
  );
  return insertId;
}

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/membership — past plan details (#2779)', () => {
  let gymId: string;
  let memberId: number;
  let pastUm: number;
  let plainUm: number;
  let lockerId: number;
  let promotionId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Past Plan Details Gym');
    await createTestMembership(gymId, 'member');
    memberId = await createCallingMember(gymId);
    const planId = await createPlan(gymId);
    lockerId = await createProduct(gymId, 'Locker Rental', 'service');
    const towelId = await createProduct(gymId, 'Towel', 'merchandise');

    // A live plan, so the two below are the history.
    await legacyAssignmentQuery(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
       VALUES (?, ?, ?, 'active', '2026-10-01', 60)`,
      [gymId, memberId, planId],
    );

    ({ insertId: pastUm } = await legacyAssignmentQuery(
      `INSERT INTO user_memberships
         (gym_id, member_id, membership_plan_id, status, starts_at, ends_at, base_price,
          membership_fee_price, recurring_billing_interval, recurring_billing_unit)
       VALUES (?, ?, ?, 'cancelled', '2026-03-01', '2026-08-31', 60, 45, 1, 'month')`,
      [gymId, memberId, planId],
    ));
    await legacyChildQuery(
      `INSERT INTO user_membership_periodical
         (gym_id, user_membership_id, product_id, quantity, item_name, item_type, unit_price,
          item_billing_frequency, currency, mandatory, \`action\`, \`value\`, direct_discount_percent)
       VALUES (?, ?, ?, 2, 'Locker Rental', 'service', 30, 'month', 'EUR', 0, 'percentage_discount', 50, 10)`,
      [gymId, pastUm, lockerId],
    );
    await legacyChildQuery(
      `INSERT INTO user_membership_oneoff
         (gym_id, user_membership_id, product_id, quantity, item_name, item_type, unit_price,
          item_billing_frequency, currency)
       VALUES (?, ?, ?, 1, 'Towel', 'merchandise', 12, 'once', 'EUR')`,
      [gymId, pastUm, towelId],
    );

    const { insertId } = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
         only_applicable_for_new_members, free_months, paid_months, bonus_months)
       VALUES (?, 'Spring Offer', '2026-01-01', '2099-12-31', 'active', 1, 0, 1, 2, 0)`,
      [gymId],
    );
    promotionId = insertId;
    const { insertId: appId } = await legacyChildQuery(
      `INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, applied_by, status, snapshot)
       VALUES (?, ?, ?, 'test', 'applied', ?)`,
      [gymId, pastUm, promotionId, JSON.stringify({
        name: 'Spring Offer',
        membership_fee_benefits: [{ enabled: true, action: 'percentage_discount', value: 20, duration_months: 3 }],
      })],
    );
    await db.query(
      `INSERT INTO user_membership_promotion_session_snapshot
         (gym_id, user_membership_promotion_id, product_id, product_name, quantity, item_type,
          item_billing_frequency, unit_price, currency, \`action\`, \`value\`, requirement)
       VALUES (?, ?, NULL, 'Personal Training', 2, 'sessions', 'once', 40, 'EUR', 'waive', NULL, 'mandatory')`,
      [gymId, appId],
    );

    // A past plan with no lines and no Promotion.
    ({ insertId: plainUm } = await legacyAssignmentQuery(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, closed_at, base_price)
       VALUES (?, ?, ?, 'expired', '2026-01-05', '2026-02-28 10:00:00', 60)`,
      [gymId, memberId, planId],
    ));
  });

  const pastPlan = async (id: number) => {
    const res = await getMembership(gymId);
    expect(res.status).toBe(200);
    return res.body.past_memberships.find((p: any) => p.id === id);
  };

  it('reports the start and end dates on the past plan itself', async () => {
    const plan = await pastPlan(pastUm);
    expect(plan.starts_at).toBe('2026-03-01');
    expect(plan.ended_on).toBe('2026-08-31');
  });

  it('lists the plan lines from its snapshot, with their treatment and discount', async () => {
    const plan = await pastPlan(pastUm);
    expect(plan.details.membership_fee_price).toBe(45);
    expect(plan.details.lines).toEqual([
      expect.objectContaining({
        category: 'oneoff', product_name: 'Towel', product_type: 'merchandise', quantity: 1,
        mandatory: true, action: 'no_benefit', value: null, direct_discount_percent: null,
      }),
      expect.objectContaining({
        category: 'periodical', product_name: 'Locker Rental', product_type: 'service', quantity: 2,
        billing_frequency: 'month', mandatory: false, action: 'percentage_discount', value: 50,
        direct_discount_percent: 10,
      }),
    ]);
  });

  it('reports the applied Promotion from its own snapshot, with what it granted', async () => {
    const plan = await pastPlan(pastUm);
    expect(plan.details.promotions).toEqual([expect.objectContaining({
      name: 'Spring Offer',
      status: 'applied',
      membership_fee_benefits: [{ action: 'percentage_discount', value: 20, duration_months: 3 }],
      products: [{ product_name: 'Personal Training', quantity: 2, action: 'waive', value: null }],
    })]);
  });

  it('is unmoved by later catalogue changes', async () => {
    await db.query("UPDATE products SET name = 'Renamed Locker', type = 'other' WHERE id = ?", [lockerId]);
    await db.query("UPDATE promotions SET name = 'Renamed Offer' WHERE id = ?", [promotionId]);
    const plan = await pastPlan(pastUm);
    expect(plan.details.lines.map((l: any) => l.product_name)).toContain('Locker Rental');
    expect(plan.details.lines.find((l: any) => l.product_name === 'Locker Rental').product_type).toBe('service');
    expect(plan.details.promotions[0].name).toBe('Spring Offer');
  });

  it('carries no Promotion section for a plan with none', async () => {
    const plan = await pastPlan(plainUm);
    expect(plan.details.promotions).toEqual([]);
    expect(plan.details.lines).toEqual([]);
  });

  it('does not leak another gym\'s history', async () => {
    const otherGym = await createTestGym('Past Plan Details Gym 2');
    await createTestMembership(otherGym, 'member');
    await createCallingMember(otherGym);
    const res = await getMembership(otherGym);
    expect(res.status).toBe(200);
    expect(res.body.past_memberships).toEqual([]);
  });
});
