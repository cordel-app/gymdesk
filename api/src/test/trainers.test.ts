// Tests for trainers.ts — the assignable-trainer lookup (#986).
//
// The rule under test: a trainer is a Staff record whose employment_status is
// 'active', whatever their HR profile. Before #986 this route filtered on the
// *role* of the login row, so a gym staffed by Front Desk and Gym Managers got
// an empty Default Trainer dropdown.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const BASE = '/trainers';

let gymId: string;
let otherGymId: string;
let frontDeskMembershipId: number;
let coachMembershipId: number;
let inactiveMembershipId: number;
let legacyMembershipId: number;

/** A login row for a staff member, with a user id unique to this file. */
async function insertMembership(gym: string, name: string, role: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role, status, name)
     VALUES (?, ?, ?, 'active', ?)`,
    [`trainers-test-${Math.random().toString(36).slice(2, 10)}`, gym, role, name],
  );
  return Number(insertId);
}

async function insertStaff(gym: string, opts: {
  first: string; last: string; profile: string;
  membershipId?: number | null;
  employment?: 'active' | 'inactive';
  deleted?: boolean;
}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO staff
       (gym_id, gym_membership_id, first_name, last_name, email, profile,
        employment_status, current_status, hire_date, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'available', '2026-01-01', ?)`,
    [
      gym, opts.membershipId ?? null, opts.first, opts.last,
      `${opts.first}.${opts.last}.${Math.random().toString(36).slice(2, 7)}@example.com`.toLowerCase(),
      opts.profile, opts.employment ?? 'active',
      opts.deleted ? new Date() : null,
    ],
  );
  return Number(insertId);
}

beforeAll(async () => {
  gymId = await createTestGym('Trainers Test Gym');
  await createTestMembership(gymId, 'admin');

  // Front Desk: an active employee whose role is not a coach role at all —
  // invisible to this route before #986, and the whole point of the ticket.
  frontDeskMembershipId = await insertMembership(gymId, 'Ana Reception', 'front_desk');
  await insertStaff(gymId, { first: 'Ana', last: 'Reception', profile: 'Front Desk', membershipId: frontDeskMembershipId });

  coachMembershipId = await insertMembership(gymId, 'Bruno Coach', 'trainer_performance');
  await insertStaff(gymId, { first: 'Bruno', last: 'Coach', profile: 'Personal Trainer', membershipId: coachMembershipId });

  inactiveMembershipId = await insertMembership(gymId, 'Carla Former', 'trainer_performance');
  await insertStaff(gymId, {
    first: 'Carla', last: 'Former', profile: 'Personal Trainer',
    membershipId: inactiveMembershipId, employment: 'inactive',
  });

  // The login role is deliberately `nutritionist` and not `trainer_perf_nutrition`:
  // `gym_memberships.role` is VARCHAR(20) (migration 001) and migration 075 added
  // the 22-character value to the CHECK without widening the column, so it cannot
  // be stored at all. Which role this row carries is irrelevant to the rule under
  // test — #986 is precisely that the role is not read.
  await insertMembership(gymId, 'Dana Removed', 'nutritionist').then((id) =>
    insertStaff(gymId, {
      first: 'Dana', last: 'Removed', profile: 'Personal Trainer & Nutritionist',
      membershipId: id, deleted: true,
    }));

  // A coach login with no staff record behind it (legacy, or a grant that is
  // mid-repair). It is not an employment record, so it is not offered.
  legacyMembershipId = await insertMembership(gymId, 'Eli Legacy', 'trainer_performance');

  // An active employee with no login row: nothing to store as a trainer id.
  await insertStaff(gymId, { first: 'Fran', last: 'Nologin', profile: 'Personal Trainer', membershipId: null });

  otherGymId = await createTestGym('Trainers Other Gym');
  await createTestMembership(otherGymId, 'admin');
  const otherMembershipId = await insertMembership(otherGymId, 'Gil Elsewhere', 'trainer_performance');
  await insertStaff(otherGymId, { first: 'Gil', last: 'Elsewhere', profile: 'Personal Trainer', membershipId: otherMembershipId });
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('auth guard', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get(BASE).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a role with no ORGANIZATION access', async () => {
    const accountantGym = await createTestGym('Trainers Accountant Gym');
    await createTestMembership(accountantGym, 'accountant');
    const res = await request.get(BASE).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', accountantGym);
    expect(res.status).toBe(403);
  });
});

describe('GET /trainers', () => {
  it('offers every active staff member regardless of role', async () => {
    const res = await request.get(BASE).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.gym_membership_id);
    expect(ids).toContain(frontDeskMembershipId);
    expect(ids).toContain(coachMembershipId);
  });

  it('excludes inactive, soft-deleted and non-staff logins', async () => {
    const res = await request.get(BASE).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const ids = res.body.map((r: any) => r.gym_membership_id);
    expect(ids).not.toContain(inactiveMembershipId);
    expect(ids).not.toContain(legacyMembershipId);
    const names = res.body.map((r: any) => r.name);
    expect(names).not.toContain('Dana Removed');
    expect(names).not.toContain('Fran Nologin');
  });

  it('reports the staff record’s own name and sorts by first name (§5)', async () => {
    const res = await request.get(BASE).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const names = res.body.map((r: any) => r.name);
    expect(names).toEqual(['Ana Reception', 'Bruno Coach']);
  });

  it('is scoped to the gym', async () => {
    const res = await request.get(BASE).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGymId);
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.name)).toEqual(['Gil Elsewhere']);
  });
});
