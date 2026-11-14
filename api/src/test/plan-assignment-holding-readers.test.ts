// #2125 M6b-9: two more readers take the assignment from `plan_snapshots`: the One per Member check
// of the Products a Membership Plan carries, and the Members App's "you already hold a plan" check.
// Both ask only for running, paused or awaiting-payment plans. The assignment is its current
// snapshot (the one the owner's Active Product Set links), and coverage is that snapshot's own
// beneficiaries.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { violatesOnePerMember } from '../api/one-per-member';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let lockerId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

/** A Member who can sign in to the Members App. */
async function member(): Promise<{ id: number; userId: string }> {
  const userId = `pah-member-${uniq()}`;
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Holding Reader', `${userId}@test.com`, userId]);
  await createTestMembership(gymId, 'member', userId);
  return { id: Number(insertId), userId };
}

/** A free monthly plan for up to two Members; `withLocker` makes it carry the One per Member Product. */
async function plan(opts: { withLocker?: boolean } = {}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gymId, `PAH Plan ${uniq()}`]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  if (opts.withLocker) {
    await db.query(
      'INSERT INTO membership_plan_oneoff (gym_id, membership_plan_id, product_id, quantity, mandatory) VALUES (?, ?, ?, 1, 1)',
      [gymId, insertId, lockerId]);
  }
  return Number(insertId);
}

const activate = (um: number, body: object = { on_conflict: 'add' }) =>
  auth(request.post(`/user-memberships/${um}/activate`)).send(body);
/** Assigns the plan to the Member and makes it their running plan. */
async function run(memberId: number, planId: number): Promise<number> {
  const um = await createTestDraftAssignment(gymId, memberId, planId);
  must(await activate(um), 'activate');
  return um;
}
const setStatus = async (um: number, status: 'paused' | 'active') =>
  must(await auth(request.put(`/user-memberships/${um}`)).send({ status }), status);
const cancel = async (um: number) => must(await auth(request.delete(`/user-memberships/${um}`)), 'cancel');
const cover = async (um: number, memberId: number) =>
  must(await auth(request.post(`/user-memberships/${um}/members`)).send({ member_id: memberId }), 'cover');
const draftOf = async (memberId: number): Promise<number> =>
  Number(must(await auth(request.post('/product-sets/draft')).send({ member_id: memberId }), 'draft').body.id);

/** The Member chooses a plan in the Members App. */
const choose = (userId: string, planId: number) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: userId } as any);
  return request.post(`/me/membership-plans/${planId}/assign`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({});
};
const holdsLocker = (memberId: number, gym = gymId) => violatesOnePerMember(db, gym, memberId, lockerId);

beforeAll(async () => {
  gymId = await createTestGym('Assignment Holding Readers Gym');
  otherGymId = await createTestGym('Assignment Holding Readers Other Gym');
  await createTestMembership(gymId, 'admin');
  const p = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, enrollment_status, is_system, one_per_member, created_by)
     VALUES (?, 'Locker PAH', 'fee', 10, 'EUR', 'once', 'active', 'public', 0, 1, 'test')`, [gymId]);
  lockerId = Number(p.insertId);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('One per Member reads the plans a Member holds from plan_snapshots', () => {
  it('a running or paused plan holds its Product; a Draft or a cancelled one does not', async () => {
    const m = await member();
    const p = await plan({ withLocker: true });
    const um = await createTestDraftAssignment(gymId, m.id, p);
    expect(await holdsLocker(m.id)).toBe(false);

    must(await activate(um), 'activate');
    expect(await holdsLocker(m.id)).toBe(true);
    await setStatus(um, 'paused');
    expect(await holdsLocker(m.id)).toBe(true);
    await setStatus(um, 'active');
    await cancel(um);
    expect(await holdsLocker(m.id)).toBe(false);
  });

  it('a covered Member holds it too; a Member the plan does not cover, or another gym, does not', async () => {
    const owner = await member();
    const covered = await member();
    const stranger = await member();
    const um = await run(owner.id, await plan({ withLocker: true }));
    await cover(um, covered.id);
    expect(await holdsLocker(covered.id)).toBe(true);
    expect(await holdsLocker(stranger.id)).toBe(false);
    expect(await holdsLocker(owner.id, otherGymId)).toBe(false);
  });

  it('a second plan carrying the Product is refused as an add, and a replacement does not count the plan it supersedes', async () => {
    const m = await member();
    const p = await plan({ withLocker: true });
    const first = await run(m.id, p);
    const second = await createTestDraftAssignment(gymId, m.id, p);
    const add = await activate(second);
    expect(add.status).toBe(409);
    expect(add.body.error).toMatch(/one assignment of this product: Locker PAH/);
    // A replacement does not count the plan it supersedes.
    expect((await activate(second, { on_conflict: 'replace' })).status).toBeLessThan(300);
    expect(await holdsLocker(m.id)).toBe(true);
    const { rows } = await db.query<any>('SELECT status FROM user_memberships WHERE id = ?', [first]);
    expect(rows[0].status).toBe('superseded');
  });

  it('holds the Product while a Draft Product Set links the same snapshot', async () => {
    const m = await member();
    await run(m.id, await plan({ withLocker: true }));
    await draftOf(m.id);
    expect(await holdsLocker(m.id)).toBe(true);
  });

  it('the snapshot is the record: a user_memberships row that disagrees does not release the Product', async () => {
    const m = await member();
    const um = await run(m.id, await plan({ withLocker: true }));
    await db.query("UPDATE user_memberships SET status = 'cancelled' WHERE id = ?", [um]);
    expect(await holdsLocker(m.id)).toBe(true);
  });
});

describe('the Members App reads "already holds a plan" from plan_snapshots', () => {
  it('is closed to an unauthenticated caller', async () => {
    expect((await request.post(`/me/membership-plans/${await plan()}/assign`).set('x-gym-id', gymId).send({})).status).toBe(401);
  });

  it('refuses a Member with a running or paused plan, and lets them choose once it is cancelled', async () => {
    const m = await member();
    const um = await run(m.id, await plan());
    const next = await plan();
    const refused = await choose(m.userId, next);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('plan_change_via_gym');

    await setStatus(um, 'paused');
    expect((await choose(m.userId, next)).body.error).toBe('plan_change_via_gym');

    await setStatus(um, 'active');
    await cancel(um);
    expect((await choose(m.userId, next)).status).toBe(201);
  });

  it('refuses a Member another Member\'s running plan covers', async () => {
    const owner = await member();
    const covered = await member();
    const um = await run(owner.id, await plan());
    await cover(um, covered.id);
    const refused = await choose(covered.userId, await plan());
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('plan_change_via_gym');
  });

  it('lets a Member with no plan, or with only a staff Draft assignment of another Member, choose one', async () => {
    const m = await member();
    await createTestDraftAssignment(gymId, (await member()).id, await plan());
    expect((await choose(m.userId, await plan())).status).toBe(201);
  });

  it('the snapshot is the record: a user_memberships row that disagrees does not open the choice', async () => {
    const m = await member();
    const um = await run(m.id, await plan());
    await db.query("UPDATE user_memberships SET status = 'cancelled' WHERE id = ?", [um]);
    expect((await choose(m.userId, await plan())).body.error).toBe('plan_change_via_gym');
  });
});
