// #2125 M6b-19: the readers of an assignment's recurring Product lines take the assignment from
// `plan_snapshots`: the Professional Service wallet's Additional Services leg
// (`loadMemberProfessionalServiceGrants()`'s `membership_service` grants) and
// `GET /user-memberships/:id/services` (the Assigned Plan card's services). Each test makes the
// assignment's current snapshot and its legacy `user_memberships` row disagree and asserts the
// snapshot wins.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { loadMemberProfessionalServiceGrants } from '../domain/memberProfessionalServices';
import { currentAssignmentSnapshotSql } from '../domain/planAssignments';
import { legacyProductInsert } from './legacyProductFixture';
import { testAssignmentWrite } from './assignmentFixture';

let gymId: string;
let otherGymId: string;
let centerId: number;
let productId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function member(): Promise<number> {
  return Number(must(await auth(request.post('/members'))
    .send({ name: 'Services Reader', email: `psr-${uniq()}@test.com`, default_center_id: centerId }), 'member').body.id);
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gymId, `PSR Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
/** A member holding one running plan with a recurring 5-session line of the test Product. */
async function runningWithService(): Promise<{ m: number; um: number }> {
  const m = await member();
  const um = await createTestDraftAssignment(gymId, m, await plan());
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
  // A recurring session line on the Active Product Set, as one-active-membership-plan.test.ts seeds it.
  const { rows } = await db.query<any>(
    "SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'active'", [gymId, m]);
  await legacyProductInsert(`INSERT INTO member_products_recurrent_snapshot (gym_id, product_set_id, product_id, quantity, starts_at,
       item_name, item_type, unit_price, item_billing_frequency, currency)
     VALUES (?, ?, ?, 1, UTC_DATE() - INTERVAL 1 DAY, 'Pack', 'sessions', 20, 'month', 'EUR')`, [gymId, rows[0].id, productId]);
  return { m, um };
}
const serviceGrants = async (memberId: number) =>
  (await loadMemberProfessionalServiceGrants(gymId, memberId)).filter((g) => g.kind === 'membership_service');
async function currentSnapshotId(um: number): Promise<number> {
  const { rows } = await db.query<any>(
    `SELECT ${currentAssignmentSnapshotSql('a.assignment_id', 'a.gym_id')} AS id
       FROM plan_snapshots a WHERE a.gym_id = ? AND a.source_user_membership_id = ? LIMIT 1`, [gymId, um]);
  return Number(rows[0].id);
}

beforeAll(async () => {
  gymId = await createTestGym('Assignment Services Readers Gym');
  otherGymId = await createTestGym('Assignment Services Readers Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'PSR Center', 'active']));
  const { insertId: serviceId } = await db.query(
    'INSERT INTO professional_services (gym_id, name, is_system) VALUES (?, ?, 0)', [gymId, `PSR-PT-${uniq()}`]);
  await db.query("INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')", [gymId, serviceId]);
  ({ insertId: productId } = await db.query(
    `INSERT INTO products (gym_id, name, type, units, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, 'sessions', 5, 20.00, 'EUR', 'month', 'active', 'available', 0)`, [gymId, `PSR Pack ${uniq()}`]));
  await db.query('INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)',
    [gymId, productId, serviceId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('the wallet\'s Additional Services leg follows the assignment\'s current plan snapshot', () => {
  it('a running plan\'s recurring session line grants its sessions to the owner', async () => {
    const { m } = await runningWithService();
    const grants = await serviceGrants(m);
    expect(grants).toHaveLength(1);
    expect(Number(grants[0].sessions)).toBe(5);
    expect(Number(grants[0].holder_member_id)).toBe(m);
  });

  it('a paused snapshot grants nothing, whatever the legacy row says', async () => {
    const { m, um } = await runningWithService();
    await db.query("UPDATE plan_snapshots SET status = 'paused' WHERE id = ?", [await currentSnapshotId(um)]);
    await testAssignmentWrite("UPDATE user_memberships SET status = 'active' WHERE id = ?", [um], { mirror: false });
    expect(await serviceGrants(m)).toHaveLength(0);
  });

  it('a running snapshot grants, even when the legacy row says cancelled and ended', async () => {
    const { m, um } = await runningWithService();
    await testAssignmentWrite("UPDATE user_memberships SET status = 'cancelled', ends_at = UTC_DATE() - INTERVAL 1 DAY WHERE id = ?", [um], { mirror: false });
    expect(await serviceGrants(m)).toHaveLength(1);
  });

  it('a cancelled snapshot grants until its paid-through date, and not after', async () => {
    const { m, um } = await runningWithService();
    const snap = await currentSnapshotId(um);
    await db.query("UPDATE plan_snapshots SET status = 'cancelled', ends_at = UTC_DATE() + INTERVAL 3 DAY WHERE id = ?", [snap]);
    expect(await serviceGrants(m)).toHaveLength(1);
    await db.query('UPDATE plan_snapshots SET ends_at = UTC_DATE() - INTERVAL 1 DAY WHERE id = ?', [snap]);
    expect(await serviceGrants(m)).toHaveLength(0);
  });
});

describe('GET /user-memberships/:id/services reads the assignment from plan_snapshots', () => {
  it('lists the assignment\'s services; 401 anonymous, 404 from another gym and for an unknown id', async () => {
    const { um } = await runningWithService();
    const res = must(await auth(request.get(`/user-memberships/${um}/services`)), 'list');
    expect(res.body).toHaveLength(1);
    expect(Number(res.body[0].user_membership_id)).toBe(um);
    expect(Number(res.body[0].product_id)).toBe(productId);
    expect((await request.get(`/user-memberships/${um}/services`).set('x-gym-id', gymId)).status).toBe(401);
    expect((await auth(request.get(`/user-memberships/${um}/services`), otherGymId)).status).toBe(404);
    expect((await auth(request.get('/user-memberships/999999999/services'))).status).toBe(404);
  });

});
