// Tests for GET /staff/:id/clerk-status (staff.ts router)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function createStaff(
  gymId: string,
  overrides: { gym_membership_id?: number | null } = {},
): Promise<number> {
  const email = `clerk-status-staff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`;
  const { insertId } = await db.query(
    `INSERT INTO staff (gym_id, first_name, last_name, email, profile, hire_date,
       employment_status, current_status, gym_membership_id, created_at, updated_at)
     VALUES (?, 'Clerk', 'Status', ?, 'Trainer', '2025-01-01',
       'active', 'available', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [gymId, email, overrides.gym_membership_id ?? null],
  );
  return insertId as number;
}

/** Inserts a gym_memberships row with an 'invited_' user_id, which the endpoint
 *  treats as the 'invited' state without hitting Clerk. */
async function createInvitedMembership(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role, status)
     VALUES (?, ?, 'member', 'active')`,
    [`invited_staff_${Date.now()}`, gymId],
  );
  return insertId as number;
}

describe('GET /staff/:id/clerk-status', () => {
  let gymId: string;
  let gymBId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Staff Clerk Status Gym A');
    gymBId = await createTestGym('Staff Clerk Status Gym B');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 401 without auth', async () => {
    const staffId = await createStaff(gymId);
    const res = await request
      .get(`/staff/${staffId}/clerk-status`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in the requested gym', async () => {
    const staffId = await createStaff(gymBId);
    const res = await request
      .get(`/staff/${staffId}/clerk-status`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymBId);
    expect(res.status).toBe(403);
  });

  it('returns 404 when accessing a gym B staff member with gym A credentials (tenant isolation)', async () => {
    const staffBId = await createStaff(gymBId);
    const res = await request
      .get(`/staff/${staffBId}/clerk-status`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent staff id', async () => {
    const res = await request
      .get('/staff/9999999/clerk-status')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns { status: "not_enrolled", userId: null } when gym_membership_id is null', async () => {
    const staffId = await createStaff(gymId, { gym_membership_id: null });
    const res = await request
      .get(`/staff/${staffId}/clerk-status`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'not_enrolled', userId: null });
  });

  it('returns { status: "invited", userId: null } when gym_membership user_id starts with "invited_"', async () => {
    const membershipId = await createInvitedMembership(gymId);
    const staffId = await createStaff(gymId, { gym_membership_id: membershipId });
    const res = await request
      .get(`/staff/${staffId}/clerk-status`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'invited', userId: null });
  });

  it('returns 404 for a soft-deleted staff member', async () => {
    const staffId = await createStaff(gymId);
    await db.query(
      'UPDATE staff SET deleted_at = UTC_TIMESTAMP() WHERE id = ?',
      [staffId],
    );
    const res = await request
      .get(`/staff/${staffId}/clerk-status`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
