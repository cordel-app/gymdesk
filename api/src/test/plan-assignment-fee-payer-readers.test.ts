// #2125 M6b-25: the Membership Fee a Promotion apply answers with (`currentMembershipFeeInTx()`)
// and the member a cash first payment is recorded for (`POST /user-memberships/:id/record-payment`)
// take the assignment from its current plan snapshot, not from the `user_memberships` row.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Fee Payer', `fpr-${uniq()}@test.com`]);
  return Number(insertId);
}

async function plan(price: number | null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'staff_only', 1)`, [gymId, `FPR Plan ${uniq()}`]);
  if (price != null) {
    await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                    VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  }
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}

beforeAll(async () => {
  gymId = await createTestGym('Fee Payer Readers Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('the Promotion apply answers the fee of the assignment\'s plan snapshot', () => {
  it('discounts the Draft\'s own fee', async () => {
    const planId = await plan(null);
    const { insertId: promoId } = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                               only_applicable_for_new_members, paid_months)
       VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, 0, 12)`, [gymId, `FPR Promo ${uniq()}`]);
    await db.query('INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promoId, planId]);
    await db.query(
      `INSERT INTO promotion_membership_fee_benefits (gym_id, promotion_id, duration_months, enabled, action, value)
       VALUES (?, ?, NULL, 1, 'percentage_discount', 10)`, [gymId, promoId]);
    const um = await createTestDraftAssignment(gymId, await member(), planId, { config: { base_price: 100 } });

    const res = await auth(request.post(`/user-memberships/${um}/promotions`)).send({ promotion_id: promoId });
    expect(res.status).toBe(201);
    expect(Number(res.body.membership_fee)).toBe(90);
  });
});

describe('record-payment records the payment for the assignment snapshot\'s owner', () => {
  it('names the snapshot\'s member even when the legacy row names another', async () => {
    const owner = await member();
    const um = await createTestDraftAssignment(gymId, owner, await plan(30));
    expect((await auth(request.post(`/user-memberships/${um}/save-and-pay`)).send({})).status).toBeLessThan(300);

    // The legacy row disagrees with the snapshot; the payment follows the snapshot.
    await db.query('UPDATE user_memberships SET member_id = ? WHERE id = ?', [await member(), um]);
    const res = await auth(request.post(`/user-memberships/${um}/record-payment`)).send({});
    expect(res.status).toBeLessThan(300);

    const { rows } = await db.query<{ member_id: number }>(
      `SELECT member_id FROM payment_requests WHERE gym_id = ? AND user_membership_id = ? AND method = 'cash'`,
      [gymId, um]);
    expect(rows.map((r) => Number(r.member_id))).toEqual([owner]);
  });
});
