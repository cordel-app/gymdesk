// Tests for #324: /shared-training-requests admin router
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
let gymBId: string;
let centerId: number;
let activityTypeId: number;
let sessionId: number;
let memberId: number;
let pendingRequestId: number;

async function createSharedRequest(gid: string, sessionId: number, membId: number, atId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO shared_training_requests
       (gym_id, class_session_id, requesting_member_id, activity_type_id, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', UTC_TIMESTAMP())`,
    [gid, sessionId, membId, atId],
  );
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('STR Admin Gym');
  await createTestMembership(gymId, 'admin');

  gymBId = await createTestGym('STR Other Gym');
  await createTestMembership(gymBId, 'admin');

  const { insertId: cid } = await db.query(
    `INSERT INTO centers (gym_id, name) VALUES (?, 'Main')`,
    [gymId],
  );
  centerId = cid;

  const { insertId: atId } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status, is_shareable)
     VALUES (?, 'Shared AT', 10, 'active', 1)`,
    [gymId],
  );
  activityTypeId = atId;

  const { insertId: sid } = await db.query(
    `INSERT INTO class_sessions (gym_id, activity_type_id, center_id, starts_at, ends_at, status, allows_shared_booking)
     VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 25 HOUR), 'scheduled', 1)`,
    [gymId, activityTypeId, centerId],
  );
  sessionId = sid;

  const email = `str-member-${Date.now()}@test.com`;
  const { insertId: mid } = await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id)
     VALUES (?, 'STR Member', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, email, TEST_USER_ID],
  );
  const { rows: mRows } = await db.query<{ id: number }>(
    'SELECT id FROM members WHERE clerk_user_id = ?',
    [TEST_USER_ID],
  );
  memberId = mRows[0].id;

  pendingRequestId = await createSharedRequest(gymId, sessionId, memberId, activityTypeId);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ---------------------------------------------------------------------------
// GET /shared-training-requests
// ---------------------------------------------------------------------------

describe('GET /shared-training-requests', () => {
  it('returns 401 without auth', async () => {
    const res = await request
      .get('/shared-training-requests')
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns requests for the gym', async () => {
    const res = await request
      .get('/shared-training-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((r: any) => r.id === pendingRequestId);
    expect(found).toBeDefined();
    expect(found.status).toBe('pending');
    expect(found.requesting_member_name).toBeDefined();
    expect(found.activity_type_name).toBeDefined();
  });

  it('tenant isolation: gym B cannot see gym A requests', async () => {
    const res = await request
      .get('/shared-training-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymBId);
    expect(res.status).toBe(200);
    const found = res.body.find((r: any) => r.id === pendingRequestId);
    expect(found).toBeUndefined();
  });

  it('filters by status', async () => {
    const res = await request
      .get('/shared-training-requests?status=pending')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const allPending = res.body.every((r: any) => r.status === 'pending');
    expect(allPending).toBe(true);
  });

  it('filters by class_session_id', async () => {
    const res = await request
      .get(`/shared-training-requests?class_session_id=${sessionId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const allForSession = res.body.every((r: any) => r.class_session_id === sessionId);
    expect(allForSession).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /shared-training-requests/:id/reject
// ---------------------------------------------------------------------------

describe('POST /shared-training-requests/:id/reject', () => {
  let rejectTargetId: number;

  beforeAll(async () => {
    const { insertId: atId2 } = await db.query(
      `INSERT INTO activity_types (gym_id, name, max_capacity, status, is_shareable)
       VALUES (?, 'Reject AT', 5, 'active', 1)`,
      [gymId],
    );
    const { insertId: sid2 } = await db.query(
      `INSERT INTO class_sessions (gym_id, activity_type_id, center_id, starts_at, ends_at, status, allows_shared_booking)
       VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 3 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 75 HOUR), 'scheduled', 1)`,
      [gymId, atId2, centerId],
    );
    rejectTargetId = await createSharedRequest(gymId, sid2, memberId, atId2);
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/shared-training-requests/${rejectTargetId}/reject`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 404 when request does not exist', async () => {
    const res = await request
      .post('/shared-training-requests/999999/reject')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('rejects a pending request and returns updated request', async () => {
    const res = await request
      .post(`/shared-training-requests/${rejectTargetId}/reject`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.reviewed_at).toBeDefined();
  });

  it('returns 409 when rejecting an already-rejected request', async () => {
    const res = await request
      .post(`/shared-training-requests/${rejectTargetId}/reject`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// POST /shared-training-requests/:id/approve
// ---------------------------------------------------------------------------

describe('POST /shared-training-requests/:id/approve', () => {
  let approveTargetId: number;
  let approveSessionId: number;

  beforeAll(async () => {
    const { insertId: atId3 } = await db.query(
      `INSERT INTO activity_types (gym_id, name, max_capacity, status, is_shareable)
       VALUES (?, 'Approve AT', 1, 'active', 1)`,
      [gymId],
    );
    const { insertId: sid3 } = await db.query(
      `INSERT INTO class_sessions (gym_id, activity_type_id, center_id, starts_at, ends_at, status, allows_shared_booking)
       VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 121 HOUR), 'scheduled', 1)`,
      [gymId, atId3, centerId],
    );
    approveSessionId = sid3;

    // Fill the one regular spot with another member
    const { insertId: otherMid } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Filler', ?)`,
      [gymId, `filler-${Date.now()}@test.com`],
    );
    await db.query(
      `INSERT INTO bookings (gym_id, center_id, member_id, class_session_id, status, booked_at)
       VALUES (?, ?, ?, ?, 'booked', UTC_TIMESTAMP())`,
      [gymId, centerId, otherMid, approveSessionId],
    );

    approveTargetId = await createSharedRequest(gymId, approveSessionId, memberId, atId3);
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/shared-training-requests/${approveTargetId}/approve`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 404 when request does not exist', async () => {
    const res = await request
      .post('/shared-training-requests/999999/approve')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('approves a pending request, creates a booking, and returns updated request', async () => {
    const res = await request
      .post(`/shared-training-requests/${approveTargetId}/approve`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.reviewed_at).toBeDefined();

    // Booking should have been inserted for the requesting member
    const { rows } = await db.query(
      `SELECT id, status FROM bookings WHERE class_session_id = ? AND member_id = ? AND status = 'booked'`,
      [approveSessionId, memberId],
    );
    expect(rows.length).toBe(1);
  });

  it('returns 409 when approving an already-approved request', async () => {
    const res = await request
      .post(`/shared-training-requests/${approveTargetId}/approve`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
  });
});
