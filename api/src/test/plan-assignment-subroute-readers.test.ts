// #2125 M6b-23: the read-only sub-routes of an assignment — `GET /user-memberships/:id/billing-event-simulation`,
// `…/billing-events`, `…/members` and the `?as_member_id=` view context — find the assignment
// through its current plan snapshot. Each test makes the legacy `user_memberships` row unreachable
// from the gym (moved to another gym) and asserts the route still answers for the assignment.
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
    .send({ name: 'Sub-route Reader', email: `sbr-${uniq()}@test.com`, default_center_id: centerId }), 'member').body.id);
}

async function plan(memberLimit = 1): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', ?)`, [gymId, `SBR Plan ${uniq()}`, memberLimit]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 30, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}

async function running(planId: number, owner?: number): Promise<number> {
  const um = await createTestDraftAssignment(gymId, owner ?? await member(), planId);
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
  return um;
}

/** Makes the legacy row unreachable from the gym, leaving every plan snapshot as it is. */
const moveLegacyRowAway = (um: number) =>
  testAssignmentWrite('UPDATE user_memberships SET gym_id = ? WHERE id = ?', [otherGymId, um]);

beforeAll(async () => {
  gymId = await createTestGym('Sub-route Readers Gym');
  otherGymId = await createTestGym('Sub-route Readers Other Gym');
  await createTestMembership(gymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'SBR Center', 'active']));
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('the read-only sub-routes find the assignment through its plan snapshot', () => {
  it('answers the forecast, the Billing Events and the covered Members with no legacy row in the gym', async () => {
    const planId = await plan();
    const um = await running(planId);
    await moveLegacyRowAway(um);
    expect((await auth(request.get(`/user-memberships/${um}/billing-event-simulation`))).status).toBe(200);
    expect((await auth(request.get(`/user-memberships/${um}/billing-events`))).status).toBe(200);
    const members = must(await auth(request.get(`/user-memberships/${um}/members`)), 'members');
    expect(Array.isArray(members.body) ? members.body.length : members.body.members?.length).toBeGreaterThan(0);
  });

  it('still answers 404 for an assignment of another gym', async () => {
    const planId = await plan();
    const um = await running(planId);
    const other = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGymId);
    await createTestMembership(otherGymId, 'admin');
    expect((await other(request.get(`/user-memberships/${um}/billing-event-simulation`))).status).toBe(404);
    expect((await other(request.get(`/user-memberships/${um}/billing-events`))).status).toBe(404);
    expect((await other(request.get(`/user-memberships/${um}/members`))).status).toBe(404);
  });

  it('decides the Linked context from the snapshot\'s owner and beneficiaries', async () => {
    const planId = await plan(2);
    const owner = await member();
    const partner = await member();
    const stranger = await member();
    const um = await running(planId, owner);
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM plan_snapshots WHERE gym_id = ? AND source_user_membership_id = ? ORDER BY id DESC LIMIT 1`, [gymId, um]);
    await db.query(`INSERT IGNORE INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id) VALUES (?, ?, ?)`,
      [gymId, rows[0].id, partner]);
    await moveLegacyRowAway(um);
    expect((await auth(request.get(`/user-memberships/${um}/billing-events?as_member_id=${owner}`))).status).toBe(200);
    expect((await auth(request.get(`/user-memberships/${um}/billing-events?as_member_id=${partner}`))).status).toBe(403);
    expect((await auth(request.get(`/user-memberships/${um}/billing-events?as_member_id=${stranger}`))).status).toBe(404);
  });
});
