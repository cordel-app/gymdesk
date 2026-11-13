// #2125 M6b-5: three readers that ask "which running plans does this Member hold or is covered by"
// read the assignment from `plan_snapshots`: the Member card's Products badge, the Duo partner check
// and Home's "services not scheduled" task. The assignment is its current snapshot (the one the
// owner's Active Product Set links) and coverage is that snapshot's own beneficiaries.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { membersShareCoverage } from '../api/duo-booking';

let gymId: string;
let otherGymId: string;
let serviceId: number;
let productId: number;
let centerId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function member(name = 'Coverage Reader'): Promise<number> {
  return Number(must(await auth(request.post('/members')).send({ name, email: `pcr-${uniq()}@test.com`, default_center_id: centerId }), 'member').body.id);
}
/** A plan for two members that includes `sessions` sessions of the test Professional Service. */
async function plan(sessions = 0): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gymId, `PCR Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  if (sessions > 0) {
    await db.query('INSERT INTO membership_plan_session (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, ?)',
      [gymId, insertId, productId, sessions]);
  }
  return Number(insertId);
}
const activate = async (um: number) =>
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
async function running(sessions = 0, name?: string): Promise<{ m: number; um: number }> {
  const m = await member(name);
  const um = await createTestDraftAssignment(gymId, m, await plan(sessions));
  await activate(um);
  return { m, um };
}
const setStatus = async (um: number, status: 'paused' | 'active') =>
  must(await auth(request.put(`/user-memberships/${um}`)).send({ status }), status);
const cover = async (um: number, memberId: number) =>
  must(await auth(request.post(`/user-memberships/${um}/members`)).send({ member_id: memberId }), 'cover');
const draftOf = async (memberId: number): Promise<number> =>
  Number(must(await auth(request.post('/product-sets/draft')).send({ member_id: memberId }), 'draft').body.id);

const tabCounts = (memberId: number, gym = gymId) => auth(request.get(`/members/${memberId}/tab-counts`), gym);
const plansBadge = async (memberId: number): Promise<number> =>
  Number(must(await tabCounts(memberId), 'tab counts').body.products_services);
const share = (a: number, b: number) => db.transaction((tx) => membersShareCoverage(tx, gymId, a, b));
/** The members Home's "services not scheduled" task flags, by id. */
async function flagged(): Promise<{ count: number; ids: number[] }> {
  const res = must(await auth(request.get('/dashboard/home')), 'home');
  const task = (res.body.tasks as any[]).find((t) => t.key === 'services_not_scheduled');
  return { count: Number(task?.count ?? 0), ids: ((task?.samples ?? []) as any[]).map((s) => Number(s.id)) };
}

beforeAll(async () => {
  gymId = await createTestGym('Assignment Coverage Readers Gym');
  otherGymId = await createTestGym('Assignment Coverage Readers Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'PCR Center', 'active']));
  ({ insertId: serviceId } = await db.query(
    'INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)', [gymId, `PCR-PT-${uniq()}`]));
  await db.query("INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')", [gymId, serviceId]);
  ({ insertId: productId } = await db.query(
    `INSERT INTO products (gym_id, name, type, units, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, 'sessions', 1, 20.00, 'EUR', 'once', 'active', 'available', 0)`, [gymId, `PCR Session ${uniq()}`]));
  await db.query('INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)',
    [gymId, productId, serviceId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('the Member card\'s Products badge counts running plans from plan_snapshots', () => {
  it('is closed to an unauthenticated caller and to another gym', async () => {
    const { m } = await running();
    expect((await request.get(`/members/${m}/tab-counts`).set('x-gym-id', gymId)).status).toBe(401);
    expect((await tabCounts(m, otherGymId)).status).toBe(404);
  });

  it('counts the owner\'s running plan, and each of two', async () => {
    const { m } = await running();
    expect(await plansBadge(m)).toBe(1);
    await activate(await createTestDraftAssignment(gymId, m, await plan()));
    expect(await plansBadge(m)).toBe(2);
  });

  it('does not count a Draft plan, a paused one or a cancelled one', async () => {
    const draftOnly = await member();
    await createTestDraftAssignment(gymId, draftOnly, await plan());
    expect(await plansBadge(draftOnly)).toBe(0);

    const { m, um } = await running();
    await setStatus(um, 'paused');
    expect(await plansBadge(m)).toBe(0);
    await setStatus(um, 'active');
    expect(await plansBadge(m)).toBe(1);
    must(await auth(request.delete(`/user-memberships/${um}`)), 'cancel');
    expect(await plansBadge(m)).toBe(0);
  });

  it('counts a plan once while a Draft Product Set links the same snapshot', async () => {
    const { m } = await running();
    await draftOf(m);
    expect(await plansBadge(m)).toBe(1);
  });

  it('counts a plan for the Member it covers', async () => {
    const { um } = await running();
    const covered = await member();
    expect(await plansBadge(covered)).toBe(0);
    await cover(um, covered);
    expect(await plansBadge(covered)).toBe(1);
  });

  it('the snapshot is the record: a user_memberships row that disagrees does not move the count', async () => {
    const { m, um } = await running();
    await db.query("UPDATE user_memberships SET status = 'cancelled' WHERE id = ?", [um]);
    expect(await plansBadge(m)).toBe(1);
  });
});

describe('two Members are linked through plan coverage (the Duo partner check)', () => {
  it('the owner and a covered Member are linked, in either order; a stranger is not', async () => {
    const { m, um } = await running();
    const partner = await member();
    const stranger = await member();
    expect(await share(m, partner)).toBe(false);
    await cover(um, partner);
    expect(await share(m, partner)).toBe(true);
    expect(await share(partner, m)).toBe(true);
    expect(await share(m, stranger)).toBe(false);
  });

  it('a paused plan links nobody, and a resumed one links them again', async () => {
    const { m, um } = await running();
    const partner = await member();
    await cover(um, partner);
    await setStatus(um, 'paused');
    expect(await share(m, partner)).toBe(false);
    await setStatus(um, 'active');
    expect(await share(m, partner)).toBe(true);
  });

  it('two Members each holding a plan of their own are not linked', async () => {
    const a = await running();
    const b = await running();
    expect(await share(a.m, b.m)).toBe(false);
  });
});

describe('Home\'s "services not scheduled" task reads the plan\'s sessions from its current snapshot', () => {
  it('flags the owner and the covered Member of a running plan with sessions, and stops when it is paused', async () => {
    const { m, um } = await running(3, `PCR Owner ${uniq()}`);
    const covered = await member(`PCR Covered ${uniq()}`);
    await cover(um, covered);
    const other = await running(0, `PCR No Sessions ${uniq()}`);

    const before = await flagged();
    expect(before.count).toBe(2);
    expect(before.ids).toEqual(expect.arrayContaining([m, covered]));
    expect(before.ids).not.toContain(other.m);

    await setStatus(um, 'paused');
    expect((await flagged()).count).toBe(0);
    await setStatus(um, 'active');
    expect((await flagged()).count).toBe(2);
  });
});
