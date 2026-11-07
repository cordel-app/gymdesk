// #2422: GET /members/:memberId/centers/effective-access — what a Member can
// actually access, unioned over their live Membership Plans.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestDraftAssignment,
  createTestGym, createTestMembership, request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let gymId: string;
let otherGymId: string;
let centerA: number;
let centerB: number;
let centerC: number;

async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Access Member', `acc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`],
  );
  return insertId as number;
}
async function center(name: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, name, 'active']);
  return insertId as number;
}
async function plan(mode: string, centers: number[] = [], online = 0): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit, center_access_mode, online_access)
     VALUES (?, ?, 'active', 'public', 1, ?, ?)`,
    [gymId, `Plan ${mode} ${Math.random().toString(36).slice(2, 6)}`, mode, online],
  );
  for (const c of centers) {
    await db.query('INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)', [gymId, insertId, c]);
  }
  return insertId as number;
}
async function assign(memberId: number, planId: number): Promise<number> {
  const um = await createTestDraftAssignment(gymId, memberId, planId);
  await activateTestAssignment(gymId, um);
  return um;
}
async function setDefault(memberId: number, centerId: number) {
  await db.query(
    `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at) VALUES (?, ?, ?, 1, UTC_TIMESTAMP())`,
    [gymId, memberId, centerId],
  );
}
async function read(memberId: number, gym = gymId) {
  return request.get(`/members/${memberId}/centers/effective-access`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
}

beforeAll(async () => {
  gymId = await createTestGym('Effective access gym');
  otherGymId = await createTestGym('Effective access other gym');
  await createTestMembership(gymId);
  await createTestMembership(otherGymId);
  centerA = await center('Centro');
  centerB = await center('Parc Valles');
  centerC = await center('New Center');
});

describe('GET /members/:memberId/centers/effective-access', () => {
  it('requires auth and isolates tenants', async () => {
    const m = await member();
    expect((await request.get(`/members/${m}/centers/effective-access`)).status).toBe(401);
    expect((await read(m, otherGymId)).status).toBe(404);
  });

  it('All Centers lists no centers; On-line is independent', async () => {
    const m = await member();
    await assign(m, await plan('all_centers'));
    await assign(m, await plan('online'));
    const res = await read(m);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ all: true, online: true, specific_centers: [], default_center: null });
  });

  it('unions specific centers across plans without duplicates, plus on-line', async () => {
    const m = await member();
    await assign(m, await plan('specific_centers', [centerA, centerB]));
    await assign(m, await plan('specific_centers', [centerA, centerC], 1));
    const res = await read(m);
    expect(res.body.all).toBe(false);
    expect(res.body.online).toBe(true);
    expect(res.body.specific_centers.map((c: { name: string }) => c.name)).toEqual(['Centro', 'New Center', 'Parc Valles']);
  });

  it('on-line alone grants no physical center', async () => {
    const m = await member();
    await assign(m, await plan('online'));
    const res = await read(m);
    expect(res.body).toMatchObject({ all: false, online: true, specific_centers: [], default_center: null });
  });

  it('Default Center resolves to the actual default; missing default grants nothing', async () => {
    const withDefault = await member();
    await setDefault(withDefault, centerB);
    await assign(withDefault, await plan('member_default_center'));
    expect((await read(withDefault)).body.default_center).toEqual({ granted: true, center: { id: centerB, name: 'Parc Valles' } });

    const noDefault = await member();
    await assign(noDefault, await plan('member_default_center'));
    const res = await read(noDefault);
    expect(res.body.default_center).toEqual({ granted: true, center: null });
    expect(res.body.specific_centers).toEqual([]);
  });

  it('a cancelled plan stops contributing', async () => {
    const m = await member();
    const um = await assign(m, await plan('specific_centers', [centerA]));
    expect((await read(m)).body.specific_centers).toHaveLength(1);
    await db.query(`UPDATE user_memberships SET status = 'cancelled' WHERE id = ?`, [um]);
    expect((await read(m)).body.specific_centers).toEqual([]);
  });
});
