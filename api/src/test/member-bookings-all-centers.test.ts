// #2953: My Bookings' "All centers" filter (`center_id=all`) spans every center the
// member's live plans let them use — never just the app's active center — on both
// the Upcoming (`GET /me/schedule`) and Past (`GET /me/activity-history`) tabs.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, request,
} from './helpers';

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockResolvedValue({
          publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
        }),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
    })),
  };
});

let gymId: string;
let centerA: number;
let centerB: number;
let centerC: number;
let activityX: number;
let activityY: number;
let evA: number;
let evB: number;
let evC: number;
let evNone: number;
let evAY: number;

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const suffix = () => Math.random().toString(36).slice(2, 7);

async function center(name: string): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO centers (gym_id, name, status) VALUES (?, ?, 'active')", [gymId, `${name}-${suffix()}`],
  );
  return insertId as number;
}
async function activity(): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, ?, 10, 'active')",
    [gymId, `AT-${suffix()}`],
  );
  return insertId as number;
}
async function event(centerId: number | null, activityId: number, past = false): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, activity_type_id, starts_at, ends_at, status)
     VALUES (?, ?, 'Session', ?,
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), 'scheduled')`,
    [gymId, centerId, activityId, past ? -48 : 24, past ? -47 : 25],
  );
  return insertId as number;
}
async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'All Centers Member', `all-centers-${Date.now()}-${suffix()}@test.com`],
  );
  return insertId as number;
}
async function plan(mode: string, centers: number[] = []): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit, center_access_mode)
     VALUES (?, ?, 'active', 'public', 1, ?)`,
    [gymId, `Plan ${mode} ${suffix()}`, mode],
  );
  for (const c of centers) {
    await db.query('INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)', [gymId, insertId, c]);
  }
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId as number;
}
async function assign(memberId: number, planId: number): Promise<void> {
  const um = await createTestDraftAssignment(gymId, memberId, planId);
  const res = await request.post(`/user-memberships/${um}/activate`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ on_conflict: 'add' });
  if (res.status >= 300) throw new Error(`activate: ${res.status} ${JSON.stringify(res.body)}`);
}
async function memberWith(...plans: Array<[string, number[]]>): Promise<number> {
  const m = await member();
  for (const [mode, centers] of plans) await assign(m, await plan(mode, centers));
  return m;
}
async function schedule(memberId: number, query: string, activeCenter?: number): Promise<number[]> {
  let req = request.get(`/me/schedule?${query}`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
    .set('x-impersonate-as', `member:${memberId}`);
  if (activeCenter != null) req = req.set('x-center-id', String(activeCenter));
  const res = await req;
  expect(res.status).toBe(200);
  return (res.body as { id: number }[]).map((r) => r.id).filter((id) => [evA, evB, evC, evNone, evAY].includes(id)).sort();
}
const sorted = (...ids: number[]) => [...ids].sort();

beforeAll(async () => {
  gymId = await createTestGym('All centers gym');
  centerA = await center('Centro');
  centerB = await center('Parc');
  centerC = await center('Other');
  activityX = await activity();
  activityY = await activity();
  evA = await event(centerA, activityX);
  evB = await event(centerB, activityX);
  evC = await event(centerC, activityX);
  evNone = await event(null, activityX);
  evAY = await event(centerA, activityY);
});

describe('GET /me/schedule?center_id=all (#2953)', () => {
  it('spans every accessible center, not the app\'s active center', async () => {
    const m = await memberWith(['specific_centers', [centerA, centerB]]);
    // The app's active center is C (inaccessible): "All" must not narrow to it.
    expect(await schedule(m, 'center_id=all', centerC)).toEqual(sorted(evA, evB, evNone, evAY));
  });

  it('one accessible center: All equals that center\'s own filter', async () => {
    const m = await memberWith(['specific_centers', [centerA]]);
    expect(await schedule(m, 'center_id=all', centerB)).toEqual(await schedule(m, `center_id=${centerA}`, centerB));
  });

  it('never shows sessions of a center the member cannot use', async () => {
    const m = await memberWith(['specific_centers', [centerA]], ['online', []]);
    const ids = await schedule(m, 'center_id=all');
    expect(ids).not.toContain(evB);
    expect(ids).not.toContain(evC);
    expect(ids).toEqual(sorted(evA, evNone, evAY));
  });

  it('an On-line-only member sees only events tied to no center', async () => {
    const m = await memberWith(['online', []]);
    expect(await schedule(m, 'center_id=all', centerA)).toEqual([evNone]);
  });

  it('All Centers plan, or no plan at all: no center restriction', async () => {
    const all = await memberWith(['all_centers', []]);
    expect(await schedule(all, 'center_id=all', centerA)).toEqual(sorted(evA, evB, evC, evNone, evAY));
    const none = await member();
    expect(await schedule(none, 'center_id=all', centerA)).toEqual(sorted(evA, evB, evC, evNone, evAY));
  });

  it('combines with the activity and trainer filters', async () => {
    const m = await memberWith(['specific_centers', [centerA, centerB]]);
    expect(await schedule(m, `center_id=all&activity_type_id=${activityY}`)).toEqual([evAY]);
    expect(await schedule(m, 'center_id=all&trainer_membership_id=999999999')).toEqual([]);
  });

  it('a specific center keeps its own behaviour', async () => {
    const m = await memberWith(['specific_centers', [centerA, centerB]]);
    expect(await schedule(m, `center_id=${centerB}`, centerA)).toEqual(sorted(evB, evNone));
  });
});

describe('GET /me/activity-history?center_id=all (#2953)', () => {
  it('applies the same scope to past bookings, ignoring the active center', async () => {
    const m = await memberWith(['specific_centers', [centerA, centerB]]);
    const pastA = await event(centerA, activityX, true);
    const pastB = await event(centerB, activityX, true);
    const pastC = await event(centerC, activityX, true);
    for (const ev of [pastA, pastB, pastC]) {
      await db.query(
        `INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status, booked_at)
         VALUES (?, ?, ?, 'booked', UTC_TIMESTAMP())`, [gymId, ev, m],
      );
    }
    const res = await request.get('/me/activity-history?center_id=all')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .set('x-impersonate-as', `member:${m}`).set('x-center-id', String(centerC));
    expect(res.status).toBe(200);
    const entityIds = (res.body.items as Array<{ entity_id: number }>).map((r) => Number(r.entity_id));
    expect(entityIds).toEqual(expect.arrayContaining([pastA, pastB]));
    expect(entityIds).not.toContain(pastC);
  });
});
