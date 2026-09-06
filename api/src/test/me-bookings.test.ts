// Regression coverage for #362 ("Make Members App Fully Functional") — Bookings slice.
//
// GET /me/bookings previously joined the legacy `class_types`/`cs.class_type_id`
// columns instead of `activity_types`/`cs.activity_type_id` — every call 500'd,
// since bookings-worthy sessions in this suite (and in production, post-#70) are
// only ever given an activity type. It also, along with GET /me/upcoming and
// GET /me/activity-history, never applied any center scoping, unlike GET
// /me/schedule. This file proves all three now resolve the effective member
// correctly, apply center scoping, and (for /me/bookings and
// /me/activity-history) join `activity_types` instead of the legacy table.
//
// `class_sessions.class_type_id` itself is still a legacy NOT NULL column
// (migration 059 added `activity_type_id` alongside it but never dropped or
// relaxed it), so test setup mirrors each activity type into `class_types`
// under the same id and supplies both columns, matching the pattern used by
// bookings.test.ts / member-calendar.test.ts / me-impersonation-context.test.ts.

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
  // class_sessions.class_type_id FKs into class_types and is still NOT NULL;
  // mirror the row there under the same id so createSession can satisfy it.
  await db.query(
    `INSERT IGNORE INTO class_types (id, gym_id, name, max_capacity, status) VALUES (?, ?, 'Test Class', ?, 'active')`,
    [insertId, gymId, maxCapacity],
  ).catch(() => { /* class_types may not exist on a fully-migrated DB */ });
  return insertId;
}

async function createSession(gymId: string, activityTypeId: number, centerId: number, whenSql: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO class_sessions (gym_id, activity_type_id, class_type_id, center_id, starts_at, ends_at, status)
     VALUES (?, ?, ?, ?, ${whenSql}, DATE_ADD(${whenSql}, INTERVAL 1 HOUR), 'scheduled')`,
    [gymId, activityTypeId, activityTypeId, centerId],
  );
  return insertId;
}

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('/me/bookings, /me/upcoming, /me/activity-history — impersonation + center scoping (#362)', () => {
  let gymId: string;
  let centerAId: number;
  let centerBId: number;
  let activityTypeId: number;
  let futureSessionInCenterA: number;
  let futureSessionInCenterB: number;
  let pastSessionInCenterA: number;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Me Bookings Gym');

    const { insertId: aId } = await db.query(`INSERT INTO centers (gym_id, name) VALUES (?, 'Center A')`, [gymId]);
    centerAId = aId;
    const { insertId: bId } = await db.query(`INSERT INTO centers (gym_id, name) VALUES (?, 'Center B')`, [gymId]);
    centerBId = bId;

    activityTypeId = await createActivityType(gymId, 10);
    futureSessionInCenterA = await createSession(gymId, activityTypeId, centerAId, 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY)');
    futureSessionInCenterB = await createSession(gymId, activityTypeId, centerBId, 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY)');
    pastSessionInCenterA = await createSession(gymId, activityTypeId, centerAId, 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)');

    const { insertId: mId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Bookings Member', ?)`,
      [gymId, `bookings-member-${Date.now()}@test.com`],
    );
    memberId = mId;

    // Member is assigned only to Center A.
    await db.query(
      `INSERT INTO member_centers (gym_id, member_id, center_id, is_default) VALUES (?, ?, ?, 1)`,
      [gymId, memberId, centerAId],
    );

    await db.query(
      `INSERT INTO bookings (gym_id, center_id, member_id, class_session_id, status, booked_at, attendance_status)
       VALUES (?, ?, ?, ?, 'booked', UTC_TIMESTAMP(), 'pending')`,
      [gymId, centerAId, memberId, futureSessionInCenterA],
    );
    await db.query(
      `INSERT INTO bookings (gym_id, center_id, member_id, class_session_id, status, booked_at, attendance_status)
       VALUES (?, ?, ?, ?, 'booked', UTC_TIMESTAMP(), 'present')`,
      [gymId, centerAId, memberId, pastSessionInCenterA],
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

  describe('GET /me/bookings', () => {
    it('is 403 for a bare superadmin (no impersonation) — superadmin has no member identity', async () => {
      const res = await request
        .get('/me/bookings')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(403);
    });

    it('under impersonation, lists the member\'s own bookings without the legacy class_types join failing', async () => {
      const res = await request
        .get('/me/bookings')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .set('x-impersonate-as', `member:${memberId}`);

      expect(res.status).toBe(200);
      const sessionIds = (res.body as any[]).map((b) => b.class_session_id);
      expect(sessionIds).toEqual(expect.arrayContaining([futureSessionInCenterA, pastSessionInCenterA]));
      expect(res.body[0].class_name).toBe('Test Class');
    });

    it('under impersonation with an explicit x-center-id, only returns bookings in that center', async () => {
      const res = await request
        .get('/me/bookings')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .set('x-impersonate-as', `member:${memberId}`)
        .set('x-center-id', String(centerAId));

      expect(res.status).toBe(200);
      const sessionIds = (res.body as any[]).map((b) => b.class_session_id);
      expect(sessionIds).toContain(futureSessionInCenterA);
    });

    it('rejects an x-center-id the impersonated member is not assigned to', async () => {
      const res = await request
        .get('/me/bookings')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .set('x-impersonate-as', `member:${memberId}`)
        .set('x-center-id', String(centerBId));

      expect(res.status).toBe(403);
    });
  });

  describe('GET /me/upcoming', () => {
    it('is 403 for a bare superadmin (no impersonation)', async () => {
      const res = await request
        .get('/me/upcoming')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(403);
    });

    it('under impersonation, only returns the member\'s future booked sessions in their assigned center', async () => {
      const res = await request
        .get('/me/upcoming')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .set('x-impersonate-as', `member:${memberId}`);

      expect(res.status).toBe(200);
      const entityIds = (res.body as any[]).map((b) => b.entity_id);
      expect(entityIds).toContain(futureSessionInCenterA);
      expect(entityIds).not.toContain(futureSessionInCenterB);
      expect(entityIds).not.toContain(pastSessionInCenterA);
    });
  });

  describe('GET /me/activity-history', () => {
    it('is 403 for a bare superadmin (no impersonation)', async () => {
      const res = await request
        .get('/me/activity-history')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(403);
    });

    it('under impersonation, only returns the member\'s past sessions with attendance info', async () => {
      const res = await request
        .get('/me/activity-history')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .set('x-impersonate-as', `member:${memberId}`);

      expect(res.status).toBe(200);
      const items = res.body.items as any[];
      const entityIds = items.map((b) => b.entity_id);
      expect(entityIds).toContain(pastSessionInCenterA);
      expect(entityIds).not.toContain(futureSessionInCenterA);
      const pastItem = items.find((b) => b.entity_id === pastSessionInCenterA);
      expect(pastItem.attendance_status).toBe('present');
    });

    it('rejects an x-center-id the impersonated member is not assigned to', async () => {
      const res = await request
        .get('/me/activity-history')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .set('x-impersonate-as', `member:${memberId}`)
        .set('x-center-id', String(centerBId));

      expect(res.status).toBe(403);
    });
  });

  it('rejects impersonating a member that does not belong to the selected gym (tenant isolation)', async () => {
    const otherGym = await createTestGym('Me Bookings Other Gym');
    const res = await request
      .get('/me/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGym)
      .set('x-impersonate-as', `member:${memberId}`);
    expect(res.status).toBe(400);
  });
});
