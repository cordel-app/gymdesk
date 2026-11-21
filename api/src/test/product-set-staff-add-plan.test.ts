import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

// #2966 stage 2 — staff adds further Membership Plans to the member's in-cart ProductSet as plan snapshots.
let gymId: string;
let otherGymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'AP Member', `ap-${uniq()}@test.com`]);
  return insertId;
}
async function plan(price: number, gym = gymId): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, 6, 0, 0)`, [gym, `AP-Plan-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, '2020-01-01', 'active')`,
    [gym, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`,
    [gym, insertId]);
  return insertId;
}
async function draft(planId: number | null, owner: number) {
  const res = await auth(request.post('/product-sets')).send({ member_id: owner, membership_plan_id: planId, starts_at: TODAY });
  expect(res.status).toBe(201);
  return res.body.id as number;
}
const planRows = async (setId: number) => (await db.query<any>(
  `SELECT s.id, s.membership_plan_id FROM product_set_plan_snapshots j JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
    WHERE j.product_set_id = ? ORDER BY j.id`, [setId])).rows;

beforeAll(async () => {
  gymId = await createTestGym('Staff add plan gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('Staff add plan other gym');
  await createTestMembership(otherGymId, 'admin');
});
afterAll(async () => {
  await db.query('DELETE FROM payment_requests WHERE gym_id IN (?, ?)', [gymId, otherGymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id IN (?, ?)', [gymId, otherGymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('staff adds a plan to the in-cart ProductSet (#2966 stage 2)', () => {
  it('adds further plans as snapshots of the same set, keeping the existing one', async () => {
    const owner = await member();
    const first = await plan(30);
    const setId = await draft(first, owner);
    const before = await planRows(setId);
    expect(before).toHaveLength(1);

    const second = await plan(50);
    const res = await auth(request.post(`/product-sets/${setId}/plans`)).send({ membership_plan_id: second });
    expect(res.status).toBe(200);
    expect(res.body.plan_snapshot_id).toBeGreaterThan(0);
    const third = await plan(70);
    expect((await auth(request.post(`/product-sets/${setId}/plans`)).send({ membership_plan_id: third })).status).toBe(200);

    const after = await planRows(setId);
    expect(after.map((r: any) => Number(r.membership_plan_id))).toEqual([first, second, third]);
    expect(Number(after[0].id)).toBe(Number(before[0].id));
    const { rows: sets } = await db.query<any>(`SELECT COUNT(*) AS n FROM product_sets WHERE gym_id = ? AND owner_member_id = ?`, [gymId, owner]);
    expect(Number(sets[0].n)).toBe(1);
    const { rows: ben } = await db.query<any>(
      'SELECT member_id, is_owner FROM plan_snapshot_beneficiaries WHERE plan_snapshot_id = ?', [res.body.plan_snapshot_id]);
    expect(ben).toEqual([expect.objectContaining({ member_id: owner, is_owner: 1 })]);
  });

  it('adds a plan to a cart that has none yet, and does not need a user_memberships row', async () => {
    const owner = await member();
    const setId = await draft(null, owner);
    const p = await plan(40);
    const res = await auth(request.post(`/product-sets/${setId}/plans`)).send({ membership_plan_id: p });
    expect(res.status).toBe(200);
    const { rows } = await db.query<any>('SELECT membership_plan_id FROM product_sets WHERE id = ?', [setId]);
    expect(Number(rows[0].membership_plan_id)).toBe(p);
    const { rows: um } = await db.query<any>('SELECT COUNT(*) AS n FROM user_memberships WHERE gym_id = ? AND member_id = ?', [gymId, owner]);
    expect(Number(um[0].n)).toBe(0);
  });

  it('removes only an added plan; the first plan is not removable here', async () => {
    const owner = await member();
    const first = await plan(30);
    const setId = await draft(first, owner);
    const added = await auth(request.post(`/product-sets/${setId}/plans`)).send({ membership_plan_id: await plan(50) });
    const [firstRow] = await planRows(setId);
    const refused = await auth(request.delete(`/product-sets/${setId}/plans/${firstRow.id}`));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('primary_plan_not_removable');
    expect((await auth(request.delete(`/product-sets/${setId}/plans/${added.body.plan_snapshot_id}`))).status).toBe(200);
    expect(await planRows(setId)).toHaveLength(1);
    expect((await auth(request.delete(`/product-sets/${setId}/plans/${added.body.plan_snapshot_id}`))).status).toBe(404);
  });

  it('validates the plan and the body', async () => {
    const setId = await draft(await plan(30), await member());
    expect((await auth(request.post(`/product-sets/${setId}/plans`)).send({})).status).toBe(400);
    expect((await auth(request.post(`/product-sets/${setId}/plans`)).send({ membership_plan_id: 999999 })).status).toBe(404);
    const inactive = await plan(20);
    await db.query(`UPDATE membership_plans SET lifecycle_status = 'inactive' WHERE id = ?`, [inactive]);
    expect((await auth(request.post(`/product-sets/${setId}/plans`)).send({ membership_plan_id: inactive })).status).toBe(400);
    expect((await auth(request.post(`/product-sets/${setId}/plans`)).send({ membership_plan_id: await plan(20), owner_is_beneficiary: 'no' })).status).toBe(400);
  });

  it('refuses a committed version and keeps tenants apart', async () => {
    const setId = await draft(await plan(30), await member());
    const p = await plan(25);
    expect((await request.post(`/product-sets/${setId}/plans`).send({ membership_plan_id: p })).status).toBe(401);
    expect((await auth(request.post(`/product-sets/${setId}/plans`), otherGymId).send({ membership_plan_id: p })).status).toBe(404);
    await db.query(`UPDATE product_sets SET status = 'superseded' WHERE id = ?`, [setId]);
    expect((await auth(request.post(`/product-sets/${setId}/plans`)).send({ membership_plan_id: p })).status).toBe(409);
  });
});
