// #2125 M6b-24: the status gates of `PUT /user-memberships/:id`, the cancellation preview, the
// owner read of `assign-new-plan`, the Close action's current read and the snapshot-edit loader
// take the assignment from its current plan snapshot. The tests make the snapshot and the legacy
// row disagree (or move the legacy row to another gym) and assert the route follows the snapshot.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { testAssignmentWrite } from './assignmentFixture';

let gymId: string;
let otherGymId: string;
let centerId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function member(): Promise<number> {
  return Number(must(await auth(request.post('/members'))
    .send({ name: 'Gate Reader', email: `gtr-${uniq()}@test.com`, default_center_id: centerId }), 'member').body.id);
}

async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `GTR Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 30, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}

async function draft(): Promise<number> {
  return createTestDraftAssignment(gymId, await member(), await plan());
}

async function running(): Promise<number> {
  const um = await draft();
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
  return um;
}

/** The legacy row's status, leaving every plan snapshot as it is. */
const setLegacyStatus = (um: number, status: string) =>
  testAssignmentWrite('UPDATE user_memberships SET status = ? WHERE id = ?', [status, um]);
const setSnapshotStatus = (um: number, status: string) =>
  db.query('UPDATE plan_snapshots SET status = ? WHERE gym_id = ? AND source_user_membership_id = ?', [status, gymId, um]);

beforeAll(async () => {
  gymId = await createTestGym('Gate Readers Gym');
  otherGymId = await createTestGym('Gate Readers Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'GTR Center', 'active']));
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('the PUT status gates read the plan snapshot', () => {
  it('refuses activating by PUT when the snapshot says Draft', async () => {
    const um = await draft();
    await setLegacyStatus(um, 'paused');
    const res = await auth(request.put(`/user-memberships/${um}`)).send({ status: 'active' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/activate/);
  });

  it('refuses a date change when the snapshot says Pending Payment', async () => {
    const um = await draft();
    await setSnapshotStatus(um, 'pending_payment');
    const res = await auth(request.put(`/user-memberships/${um}`)).send({ starts_at: '2030-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pending payment/);
  });
});

describe('the read routes find the assignment through its plan snapshot', () => {
  it('answers the cancellation preview with no legacy row in the gym', async () => {
    const um = await running();
    await testAssignmentWrite('UPDATE user_memberships SET gym_id = ? WHERE id = ?', [otherGymId, um]);
    const res = await auth(request.get(`/user-memberships/${um}/cancellation-preview`));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ends_on');
  });

  it('answers 404 to another gym on the preview, assign-new-plan and close', async () => {
    const um = await running();
    const other = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGymId);
    expect((await other(request.get(`/user-memberships/${um}/cancellation-preview`))).status).toBe(404);
    expect((await other(request.post(`/user-memberships/${um}/assign-new-plan`))
      .send({ membership_plan_id: await plan(), starts_at: '2030-01-01' })).status).toBe(404);
    expect((await other(request.post(`/user-memberships/${um}/close`)).send({}))).toHaveProperty('status', 404);
  });
});
