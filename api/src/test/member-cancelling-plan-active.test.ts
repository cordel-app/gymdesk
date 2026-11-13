// #2777 — in the Members App a plan that cancels on its end date is the member's plan until that
// date (My Plans, under its Admin status), and Past once the date has passed. Integration.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { CANCELS_AT_PERIOD_END_STATUS } from '../domain/assignmentStatus';

// The migration that gives Active sets activated before #2659 stage 3 their entitlement links.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const backfill = require('../infra/migrations/418_backfill_entitlement_plan_links.js');

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const asMember = (clerk: string, path: string) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any).mockResolvedValueOnce({ sub: clerk } as any);
  return request.get(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};
const asAdmin = (method: 'post' | 'delete', path: string) => {
  // Drop any one-shot member identity a previous read did not consume.
  vi.mocked(verifyToken).mockReset().mockResolvedValue({ sub: 'test-user-id' } as any);
  return (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};

async function member(): Promise<{ clerk: string; id: number }> {
  const clerk = `cancel-active-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Cancelling Member', `${clerk}@t.com`, clerk]);
  return { clerk, id: Number(insertId) };
}

async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `Cancel Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}

/** A member holding one plan, cancelled to run to its end date. */
async function cancellingPlan() {
  const m = await member();
  const planId = await plan(30);
  const um = await createTestDraftAssignment(gymId, m.id, planId, { config: { membership_fee_price: 30 } });
  expect((await asAdmin('post', `/user-memberships/${um}/activate`).send({ on_conflict: 'add' })).status).toBeLessThan(300);
  // A future end date, so the cancellation keeps it running rather than ending it today.
  await db.query('UPDATE user_memberships SET ends_at = UTC_DATE() + INTERVAL 20 DAY WHERE id = ?', [um]);
  expect((await asAdmin('delete', `/user-memberships/${um}`)).status).toBe(204);
  const { rows } = await db.query<{ status: string }>('SELECT status FROM user_memberships WHERE id = ?', [um]);
  expect(rows[0].status).toBe(CANCELS_AT_PERIOD_END_STATUS);
  const { rows: set } = await db.query<{ id: number }>(
    `SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'active'`, [gymId, m.id]);
  return { m, um, planId, setId: Number(set[0].id) };
}

const myPlans = async (clerk: string, setId: number) => {
  const res = await asMember(clerk, `/me/product-sets/${setId}`);
  expect(res.status).toBe(200);
  return res.body.plans as any[];
};

beforeAll(async () => {
  gymId = await createTestGym('Cancelling Plan Active Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('a plan that cancels on its end date, in the Members App', () => {
  it('is listed in My Plans as Cancels on End Date, and is not Past', async () => {
    const { m, um, planId, setId } = await cancellingPlan();
    const plans = await myPlans(m.clerk, setId);
    expect(plans).toEqual([expect.objectContaining({
      membership_plan_id: planId, status: 'cancels_on_end_date', entitlement_only: true,
    })]);

    const mship = await asMember(m.clerk, '/me/membership');
    expect(mship.status).toBe(200);
    expect(mship.body.membership).toMatchObject({ id: um });
    expect((mship.body.past_memberships as any[]).map((p) => p.id)).not.toContain(um);
  });

  it('moves to Past once its end date has passed', async () => {
    const { m, um, setId } = await cancellingPlan();
    await db.query('UPDATE user_memberships SET ends_at = UTC_DATE() - INTERVAL 1 DAY WHERE id = ?', [um]);

    expect(await myPlans(m.clerk, setId)).toEqual([]);
    const mship = await asMember(m.clerk, '/me/membership');
    expect(mship.status).toBe(200);
    expect(mship.body.past_memberships).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: um, lifecycle_status: 'cancelled' })]));
  });

  it('is restored to an Active set that predates the entitlement links (migration 418)', async () => {
    const { m, setId } = await cancellingPlan();
    // An Active set activated before #2659 stage 3 carries no entitlement link.
    await db.query('DELETE FROM product_set_plan_snapshots WHERE product_set_id = ? AND entitlement_only = 1', [setId]);
    expect(await myPlans(m.clerk, setId)).toEqual([]);

    const knex = { raw: (sql: string) => db.query(sql) };
    await backfill.up(knex);
    await backfill.up(knex); // repeatable
    const plans = await myPlans(m.clerk, setId);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ status: 'cancels_on_end_date', entitlement_only: true });
  });
});
