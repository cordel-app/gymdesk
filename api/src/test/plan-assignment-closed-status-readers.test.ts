// #2125 M6b-13: the readers that need a closed plan's status and dates take the assignment from
// `plan_snapshots`: the enrollment status (`latestEnrollmentStatusSql()`, the Members list's Plan
// column and its filter) and the New Member rule (`GET /members`' `is_new_member`, the Promotion
// apply paths). The assignment is its current snapshot; a closed one reads its closed status
// because the settle run (M6b-6/7) wrote it there.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

/** A gym with an admin and one center (a Member needs a default center). */
async function gymWithCenter(name: string): Promise<{ gym: string; center: number }> {
  const gym = await createTestGym(name);
  await createTestMembership(gym, 'admin');
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gym, 'PCS Center', 'active']);
  return { gym, center: Number(insertId) };
}
const centers = new Map<string, number>();
async function member(gym = gymId, name = 'Closed Status Reader'): Promise<number> {
  return Number(must(await auth(request.post('/members'), gym)
    .send({ name, email: `pcs-${uniq()}@test.com`, default_center_id: centers.get(gym) }), 'member').body.id);
}
/** A monthly plan at 10.00, named so a test can find it. */
async function plan(gym = gymId, name = `PCS Plan ${uniq()}`): Promise<{ id: number; name: string }> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gym, name]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gym, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gym, insertId]);
  return { id: Number(insertId), name };
}
const activate = async (um: number, gym = gymId) =>
  must(await auth(request.post(`/user-memberships/${um}/activate`), gym).send({ on_conflict: 'add' }), 'activate');
/** Assigns `planId` to the Member and makes it their running plan (beside any they already hold). */
async function run(memberId: number, planId: number, gym = gymId): Promise<number> {
  const um = await createTestDraftAssignment(gym, memberId, planId);
  await activate(um, gym);
  return um;
}
beforeAll(async () => {
  const a = await gymWithCenter('Assignment Closed Status Readers Gym');
  const b = await gymWithCenter('Assignment Closed Status Readers Other Gym');
  gymId = a.gym; otherGymId = b.gym;
  centers.set(a.gym, a.center); centers.set(b.gym, b.center);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const cancel = async (um: number, gym = gymId) => must(await auth(request.delete(`/user-memberships/${um}`), gym), 'cancel');
const draftOf = async (memberId: number, gym = gymId): Promise<number> =>
  Number(must(await auth(request.post('/product-sets/draft'), gym).send({ member_id: memberId }), 'draft').body.id);

/** The Members list's row for a Member of `gym`. */
async function row(memberId: number, gym = gymId, query = ''): Promise<any> {
  const res = must(await auth(request.get(`/members${query}`), gym), 'members');
  return (res.body as any[]).find((r) => Number(r.id) === memberId);
}

describe('the enrollment status is read from plan_snapshots', () => {
  it('is closed to an unauthenticated caller', async () => {
    expect((await request.get('/members').set('x-gym-id', gymId)).status).toBe(401);
  });

  it('reads a running plan as active, and a Member with only a Draft as having none', async () => {
    const running = await member();
    await run(running, (await plan()).id);
    expect((await row(running)).enrollment_status).toBe('active');
    const drafted = await member();
    await createTestDraftAssignment(gymId, drafted, (await plan()).id);
    expect((await row(drafted)).enrollment_status).toBeNull();
  });

  it('reads the closed status of a cancelled plan, and filters on it', async () => {
    const m = await member();
    const um = await run(m, (await plan()).id);
    await cancel(um);
    const status = (await row(m)).enrollment_status;
    expect(['cancelled', 'active_cancel_at_period_end']).toContain(status);
    expect(await row(m, gymId, `?enrollment_status=${status}`)).toBeDefined();
    expect(await row(m, gymId, '?enrollment_status=active')).toBeUndefined();
  });

  it('the latest assignment decides, and a Draft copy of the running plan does not move it', async () => {
    const m = await member();
    const first = await run(m, (await plan()).id);
    await cancel(first);
    await run(m, (await plan()).id);
    await draftOf(m);
    expect((await row(m)).enrollment_status).toBe('active');
  });

  it('the snapshot is the record: a user_memberships row that disagrees does not move it', async () => {
    const m = await member();
    const um = await run(m, (await plan()).id);
    await db.query("UPDATE user_memberships SET status = 'paused' WHERE id = ?", [um]);
    expect((await row(m)).enrollment_status).toBe('active');
  });

  it('does not reach another gym\'s Members', async () => {
    const m = await member(otherGymId);
    await run(m, (await plan(otherGymId)).id, otherGymId);
    expect(await row(m)).toBeUndefined();
    expect((await row(m, otherGymId)).enrollment_status).toBe('active');
  });
});

describe('the New Member rule reads plan_snapshots', () => {
  it('a Member who never held a plan, or holds only a Draft, is new', async () => {
    expect((await row(await member())).is_new_member).toBe(true);
    const drafted = await member();
    await createTestDraftAssignment(gymId, drafted, (await plan()).id);
    expect((await row(drafted)).is_new_member).toBe(true);
  });

  it('a Member with a running plan is not new, in the list and in the detail', async () => {
    const m = await member();
    await run(m, (await plan()).id);
    expect((await row(m)).is_new_member).toBe(false);
    expect(must(await auth(request.get(`/members/${m}`)), 'detail').body.is_new_member).toBe(false);
  });

  it('a plan cancelled inside its 14-day grace does not count, read from its closed snapshot', async () => {
    const m = await member();
    await cancel(await run(m, (await plan()).id));
    expect((await row(m)).is_new_member).toBe(true);
  });

  it('the snapshot is the record: a user_memberships row that disagrees does not move it', async () => {
    const m = await member();
    const um = await run(m, (await plan()).id);
    await db.query(
      "UPDATE user_memberships SET status = 'expired', ends_at = CURDATE() - INTERVAL 24 MONTH WHERE id = ?", [um]);
    expect((await row(m)).is_new_member).toBe(false);
  });
});
