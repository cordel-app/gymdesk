// Regression coverage for #362: /me/schedule and /me/membership must resolve
// the *effective* member identity — the superadmin's own (non-member) identity
// must never leak through, and an impersonated member's data must be returned.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  request,
} from './helpers';

const mockGetUser = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin',
    firstName: 'Super',
    lastName: 'Admin',
  }),
);

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: mockGetUser,
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: {
        createInvitation: vi.fn().mockResolvedValue({ id: 'inv-test-id' }),
        revokeInvitation: vi.fn().mockResolvedValue({}),
      },
      emailAddresses: {
        getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 'test@example.com' }),
      },
    })),
  };
});

async function createActivityType(gymId: string, maxCapacity: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, 'Test Class', ?, 'active')`,
    [gymId, maxCapacity],
  );
  await db.query(
    `INSERT IGNORE INTO class_types (id, gym_id, name, max_capacity, status) VALUES (?, ?, 'Test Class', ?, 'active')`,
    [insertId, gymId, maxCapacity],
  ).catch(() => { /* class_types may not exist on fully-migrated DBs */ });
  return insertId;
}

async function createSession(gymId: string, activityTypeId: number, centerId: number): Promise<number> {
  try {
    const { insertId } = await db.query(
      `INSERT INTO class_sessions (gym_id, activity_type_id, class_type_id, center_id, starts_at, ends_at, status)
       VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 25 HOUR), 'scheduled')`,
      [gymId, activityTypeId, activityTypeId, centerId],
    );
    return insertId;
  } catch (err: any) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    const { insertId } = await db.query(
      `INSERT INTO class_sessions (gym_id, activity_type_id, center_id, starts_at, ends_at, status)
       VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 25 HOUR), 'scheduled')`,
      [gymId, activityTypeId, centerId],
    );
    return insertId;
  }
}

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('/me/schedule and /me/membership — superadmin member impersonation (#362)', () => {
  let gymId: string;
  let centerId: number;
  let sessionId: number;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Impersonation Context Gym');

    const { insertId: cId } = await db.query(
      `INSERT INTO centers (gym_id, name) VALUES (?, 'Main Center')`,
      [gymId],
    );
    centerId = cId;

    const activityTypeId = await createActivityType(gymId, 10);
    sessionId = await createSession(gymId, activityTypeId, centerId);

    const { insertId: mId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Impersonated Member', ?)`,
      [gymId, `impersonated-${Date.now()}@test.com`],
    );
    memberId = mId;

    await db.query(
      `INSERT INTO bookings (gym_id, center_id, member_id, class_session_id, status, booked_at)
       VALUES (?, ?, ?, ?, 'booked', UTC_TIMESTAMP())`,
      [gymId, centerId, memberId, sessionId],
    );

    await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, status, starts_at) VALUES (?, ?, 'active', CURDATE())`,
      [gymId, memberId],
    );
  });

  beforeEach(() => {
    mockGetUser.mockClear();
    mockGetUser.mockResolvedValue({
      publicMetadata: { platform_role: 'superadmin' },
      fullName: 'Super Admin',
      firstName: 'Super',
      lastName: 'Admin',
    });
  });

  it('GET /me/schedule as a bare superadmin (no impersonation) is 403 — superadmin has no member identity', async () => {
    const res = await request
      .get('/me/schedule')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
  });

  it('GET /me/schedule under impersonation resolves the impersonated member, not the superadmin', async () => {
    const res = await request
      .get('/me/schedule')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('x-impersonate-as', `member:${memberId}`);

    expect(res.status).toBe(200);
    const booking = (res.body as any[]).find((s) => s.id === sessionId);
    expect(booking).toBeDefined();
    expect(booking.my_booking_status).toBe('booked');
  });

  it('GET /me/membership as a bare superadmin (no impersonation) is 403', async () => {
    const res = await request
      .get('/me/membership')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
  });

  it('GET /me/membership under impersonation resolves the impersonated member\'s membership', async () => {
    const res = await request
      .get('/me/membership')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('x-impersonate-as', `member:${memberId}`);

    expect(res.status).toBe(200);
    expect(res.body.membership).not.toBeNull();
    expect(res.body.membership.member_id).toBe(memberId);
    expect(res.body.membership.status).toBe('active');
  });

  it('rejects impersonating a member that does not belong to the selected gym (tenant isolation)', async () => {
    const otherGym = await createTestGym('Impersonation Context Other Gym');
    const res = await request
      .get('/me/schedule')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGym)
      .set('x-impersonate-as', `member:${memberId}`);
    expect(res.status).toBe(400);
  });

  it('GET /me/schedule with x-center-id under impersonation resolves the impersonated member\'s own centers, not the superadmin\'s', async () => {
    await db.query(
      `INSERT INTO member_centers (gym_id, member_id, center_id, is_default) VALUES (?, ?, ?, true)`,
      [gymId, memberId, centerId],
    );

    const res = await request
      .get('/me/schedule')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('x-center-id', String(centerId))
      .set('x-impersonate-as', `member:${memberId}`);

    expect(res.status).toBe(200);
    const booking = (res.body as any[]).find((s) => s.id === sessionId);
    expect(booking).toBeDefined();
  });

  it('GET /me/schedule with an x-center-id the impersonated member is not assigned to is 403', async () => {
    const { insertId: otherCenterId } = await db.query(
      `INSERT INTO centers (gym_id, name) VALUES (?, 'Other Center')`,
      [gymId],
    );

    const res = await request
      .get('/me/schedule')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('x-center-id', String(otherCenterId))
      .set('x-impersonate-as', `member:${memberId}`);

    expect(res.status).toBe(403);
  });
});
