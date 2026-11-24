// #3281: the Member header's Membership Plan Status (`enrollment_status` on `GET /members` and
// `GET /members/:id`, `latestEnrollmentStatusSql()`) is derived on read from the current snapshot
// of every plan the Member owns **or is covered by** — the same plans the Products tab lists — with
// #3113's priority (Active, Paused, Cancels on End Date, closed). The defect: a Member covered by a
// family member's Duo read only the plans they owned, so a header said "Cancels at End Date" beside
// an Active Duo row on the Products tab.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestFamily, createTestGym,
  createTestMembership, request,
} from './helpers';

let gymId: string;
let otherGymId: string;
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function member(gym = gymId, name = 'Coverage Status Member'): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gym, name, `cov-${uniq()}@test.com`]);
  return Number(insertId);
}
async function plan(gym = gymId): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gym, `Duo ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gym, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gym, insertId]);
  return Number(insertId);
}
const activate = async (um: number, gym = gymId) =>
  must(await auth(request.post(`/user-memberships/${um}/activate`), gym).send({ on_conflict: 'add' }), 'activate');
const cover = async (um: number, memberId: number, gym = gymId) =>
  must(await auth(request.post(`/user-memberships/${um}/members`), gym).send({ member_id: memberId }), 'cover');
/** `owner`'s plan, optionally covering `covered` too, committed as a running plan. */
async function running(owner: number, covered: number[] = [], gym = gymId): Promise<number> {
  const um = await createTestDraftAssignment(gym, owner, await plan(gym));
  for (const c of covered) await cover(um, c, gym);
  await activate(um, gym);
  return um;
}
async function status(memberId: number, gym = gymId): Promise<string | null> {
  const rows = must(await auth(request.get('/members'), gym), 'list').body as any[];
  return rows.find((r) => Number(r.id) === memberId)?.enrollment_status ?? null;
}
async function detailStatus(memberId: number, gym = gymId): Promise<string | null> {
  return must(await auth(request.get(`/members/${memberId}`), gym), 'detail').body.enrollment_status ?? null;
}
const setStatus = (um: number, s: string) =>
  db.query(`UPDATE plan_snapshots SET status = ?, assignment_status = IF(id = anchor_plan_snapshot_id, ?, assignment_status)
             WHERE anchor_plan_snapshot_id = ?`, [s, s, um]);

beforeAll(async () => {
  gymId = await createTestGym('Plan Status Coverage Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('Plan Status Coverage Other Gym');
  await createTestMembership(otherGymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('Member Membership Plan Status counts the plans that cover the Member (#3281)', () => {
  it('is closed to an unauthenticated caller', async () => {
    expect((await request.get('/members').set('x-gym-id', gymId)).status).toBe(401);
  });

  it('the screenshot: an owned plan cancelling at its end beside an Active Duo that covers the Member reads Active', async () => {
    const owner = await member(gymId, 'Duo Owner');
    const covered = await member(gymId, 'Duo Partner');
    await createTestFamily(gymId, owner, [covered]);
    const own = await running(covered);
    await setStatus(own, 'active_cancel_at_period_end');
    expect(await status(covered)).toBe('active_cancel_at_period_end');

    await running(owner, [covered]);
    expect(await status(covered)).toBe('active');
    expect(await detailStatus(covered)).toBe('active');
    // the filter uses the same calculation
    const filtered = must(await auth(request.get('/members?enrollment_status=active')), 'filter').body as any[];
    expect(filtered.some((r) => Number(r.id) === covered)).toBe(true);
  });

  it('a covered Member with no plan of their own reads the plan that covers them', async () => {
    const owner = await member();
    const covered = await member();
    await createTestFamily(gymId, owner, [covered]);
    const um = await running(owner, [covered]);
    expect(await status(covered)).toBe('active');
    await setStatus(um, 'paused');
    expect(await status(covered)).toBe('paused');
  });

  it('a family member\'s plan that does not cover the Member is not counted', async () => {
    const owner = await member();
    const sibling = await member();
    await createTestFamily(gymId, owner, [sibling]);
    await running(owner);
    expect(await status(owner)).toBe('active');
    expect(await status(sibling)).toBeNull();
  });

  it('applies the #3113 priority across owned and covered plans', async () => {
    const owner = await member();
    const covered = await member();
    await createTestFamily(gymId, owner, [covered]);
    const own = await running(covered);
    const duo = await running(owner, [covered]);
    await setStatus(own, 'paused');
    await setStatus(duo, 'active_cancel_at_period_end');
    expect(await status(covered)).toBe('paused');
    await setStatus(own, 'cancelled');
    expect(await status(covered)).toBe('active_cancel_at_period_end');
    await setStatus(duo, 'expired');
    expect(['cancelled', 'expired']).toContain(await status(covered));
  });

  it('a coverage proposed in an uncommitted Draft does not change the status', async () => {
    const owner = await member();
    const covered = await member();
    await createTestFamily(gymId, owner, [covered]);
    const um = await createTestDraftAssignment(gymId, owner, await plan());
    await cover(um, covered);
    expect(await status(covered)).toBeNull();
    await activate(um);
    expect(await status(covered)).toBe('active');
  });

  it('does not reach another gym', async () => {
    const owner = await member(otherGymId);
    const covered = await member(otherGymId);
    await createTestFamily(otherGymId, owner, [covered]);
    await running(owner, [covered], otherGymId);
    expect(await status(covered, otherGymId)).toBe('active');
    const rows = must(await auth(request.get('/members')), 'list').body as any[];
    expect(rows.some((r) => Number(r.id) === covered)).toBe(false);
  });
});

// #3281 stage 2 (24 Nov clarification): the Member's Plan Status is the exact status of the plan it
// is derived from — a running plan marked for cancellation in the open Draft reads `to_be_canceled`,
// never `active`, and after the commit it reads the plan's committed status, never another one.
describe('Member Membership Plan Status keeps the exact plan status (#3281 stage 2)', () => {
  const snapshotStatus = async (um: number) => (await db.query<any>(
    'SELECT status FROM plan_snapshots WHERE gym_id = ? AND anchor_plan_snapshot_id = ? ORDER BY id DESC LIMIT 1',
    [gymId, um])).rows[0]?.status;

  it('a single plan marked To Be Canceled reads to_be_canceled, then the committed status after Save', async () => {
    const owner = await member(gymId, 'Pending Cancel Member');
    const um = await running(owner);
    expect(await status(owner)).toBe('active');

    const mark = must(await auth(request.post(`/user-memberships/${um}/mark-cancel`)), 'mark-cancel');
    expect(await snapshotStatus(um)).toBe('to_be_canceled');
    expect(await status(owner)).toBe('to_be_canceled');
    expect(await detailStatus(owner)).toBe('to_be_canceled');
    // the filter offers the value it shows, and `active` no longer matches it
    const marked = must(await auth(request.get('/members?enrollment_status=to_be_canceled')), 'filter').body as any[];
    expect(marked.some((r) => Number(r.id) === owner)).toBe(true);
    const active = must(await auth(request.get('/members?enrollment_status=active')), 'filter').body as any[];
    expect(active.some((r) => Number(r.id) === owner)).toBe(false);

    must(await auth(request.post(`/product-sets/${mark.body.product_set_id}/activate`)), 'commit');
    const committed = await snapshotStatus(um);
    expect(['active_cancel_at_period_end', 'cancelled']).toContain(committed);
    expect(await status(owner)).toBe(committed);
    expect(await detailStatus(owner)).toBe(committed);
  });

  it('reports active_cancel_at_period_end as itself', async () => {
    const owner = await member();
    const um = await running(owner);
    await setStatus(um, 'active_cancel_at_period_end');
    expect(await status(owner)).toBe('active_cancel_at_period_end');
    expect(await detailStatus(owner)).toBe('active_cancel_at_period_end');
  });
});
