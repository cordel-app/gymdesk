// #2802: `plan_access` on GET /user-memberships/:id — the access the plan grants each
// beneficiary, read from the plan's own access configuration. Display only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let gymId: string;
let otherGymId: string;
let centerA: number;
let centerB: number;

async function member(name: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `pa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`],
  );
  return insertId as number;
}
async function center(name: string, status = 'active'): Promise<number> {
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, name, status]);
  return insertId as number;
}
async function plan(mode: string, centers: number[] = [], memberLimit = '1'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit, center_access_mode)
     VALUES (?, ?, 'active', 'public', ?, ?)`,
    [gymId, `Access plan ${mode} ${Math.random().toString(36).slice(2, 6)}`, memberLimit, mode],
  );
  for (const c of centers) {
    await db.query('INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)', [gymId, insertId, c]);
  }
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 20, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId as number;
}
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const detail = (um: number, gym = gymId) => auth(request.get(`/user-memberships/${um}`), gym);

beforeAll(async () => {
  gymId = await createTestGym('Plan access gym');
  otherGymId = await createTestGym('Plan access other gym');
  await createTestMembership(gymId);
  await createTestMembership(otherGymId);
  centerA = await center('Alpha');
  centerB = await center('Beta');
  await center('Gamma');
});

describe('GET /user-memberships/:id plan_access', () => {
  it('lists the centers the plan grants, once per beneficiary, and leaves the fee alone', async () => {
    const owner = await member('Owner One');
    const partner = await member('Partner Two');
    const um = await createTestDraftAssignment(gymId, owner, await plan('specific_centers', [centerB, centerA], '2'));
    const before = await detail(um);
    expect(before.status).toBe(200);
    expect(before.body.plan_access).toEqual([
      { member_id: owner, member_name: 'Owner One', all_centers: false, online: false,
        centers: [{ id: centerA, name: 'Alpha' }, { id: centerB, name: 'Beta' }] },
    ]);

    const add = await auth(request.post(`/user-memberships/${um}/members`)).send({ member_id: partner });
    expect(add.status).toBeLessThan(300);
    const after = await detail(um);
    expect(after.body.plan_access.map((e: any) => [e.member_id, e.centers.map((c: any) => c.name)])).toEqual([
      [owner, ['Alpha', 'Beta']], [partner, ['Alpha', 'Beta']],
    ]);
    // A second beneficiary's access costs nothing: the fee is the same figure.
    expect(after.body.membership_fee).toBe(before.body.membership_fee);
    expect(after.body.effective_price).toEqual(before.body.effective_price);
  });

  it('reports All Centers and On-line plans without listing centers', async () => {
    const m = await member('All Member');
    const all = await detail(await createTestDraftAssignment(gymId, m, await plan('all_centers')));
    expect(all.body.plan_access).toEqual([{ member_id: m, member_name: 'All Member', all_centers: true, online: false, centers: [] }]);

    const m2 = await member('Online Member');
    const online = await detail(await createTestDraftAssignment(gymId, m2, await plan('online')));
    expect(online.body.plan_access).toEqual([{ member_id: m2, member_name: 'Online Member', all_centers: false, online: true, centers: [] }]);
  });

  it('resolves Only Member Default Center from the beneficiary\'s default, and lists nothing without one', async () => {
    const m = await member('Default Member');
    await db.query(
      'INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at) VALUES (?, ?, ?, 1, UTC_TIMESTAMP())',
      [gymId, m, centerB]);
    const withDefault = await detail(await createTestDraftAssignment(gymId, m, await plan('member_default_center')));
    expect(withDefault.body.plan_access.map((e: any) => e.centers)).toEqual([[{ id: centerB, name: 'Beta' }]]);

    const m2 = await member('No Default Member');
    await db.query(
      'INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at) VALUES (?, ?, ?, 0, UTC_TIMESTAMP())',
      [gymId, m2, centerA]);
    const none = await detail(await createTestDraftAssignment(gymId, m2, await plan('member_default_center')));
    expect(none.body.plan_access).toEqual([]);
  });

  it('does not answer for another gym', async () => {
    const m = await member('Isolated Member');
    const um = await createTestDraftAssignment(gymId, m, await plan('all_centers'));
    expect((await detail(um, otherGymId)).status).toBe(404);
    expect((await request.get(`/user-memberships/${um}`)).status).toBe(401);
  });
});
