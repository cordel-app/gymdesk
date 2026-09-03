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

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

async function createShareableActivityType(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status, shareable) VALUES (?, ?, 20, 'active', 1)`,
    [gymId, name],
  );
  return insertId;
}

async function createNonShareableActivityType(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status, shareable) VALUES (?, 'NonShare', 20, 'active', 0)`,
    [gymId],
  );
  return insertId;
}

async function createSpace(gymId: string, maxGroups = 2): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO spaces (gym_id, name, capacity, max_concurrent_groups) VALUES (?, 'Studio A', 20, ?)`,
    [gymId, maxGroups],
  );
  return insertId;
}

async function createCenter(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO centers (gym_id, name) VALUES (?, 'Main Center')`,
    [gymId],
  );
  return insertId;
}

async function createTrainerMembership(gymId: string, maxGroups = 2): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role, status, max_concurrent_groups) VALUES (?, ?, 'trainer_performance', 'active', ?)`,
    [`trainer-${Date.now()}`, gymId, maxGroups],
  );
  return insertId;
}

async function createSession(
  gymId: string,
  centerId: number,
  activityTypeId: number,
  trainerMembershipId: number,
  spaceId: number,
  dayOffset = 1,
): Promise<number> {
  // class_type_id is a legacy NOT NULL column present in older DB states; try without it first.
  try {
    const { insertId } = await db.query(
      `INSERT INTO class_sessions
       (gym_id, center_id, activity_type_id, trainer_membership_id, space_id,
        starts_at, ends_at, status)
       VALUES (?, ?, ?, ?, ?,
         DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY),
         DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR),
         'scheduled')`,
      [gymId, centerId, activityTypeId, trainerMembershipId, spaceId, dayOffset, dayOffset * 24 + 1],
    );
    return insertId;
  } catch (err: any) {
    if (err.code !== 'ER_NO_DEFAULT_FOR_FIELD') throw err;
    const { insertId } = await db.query(
      `INSERT INTO class_sessions
       (gym_id, center_id, activity_type_id, class_type_id, trainer_membership_id, space_id,
        starts_at, ends_at, status)
       VALUES (?, ?, ?, ?, ?, ?,
         DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY),
         DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR),
         'scheduled')`,
      [gymId, centerId, activityTypeId, activityTypeId, trainerMembershipId, spaceId, dayOffset, dayOffset * 24 + 1],
    );
    return insertId;
  }
}

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Test Member', ?)`,
    [gymId, `member-${Date.now()}@test.com`],
  );
  return insertId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Shared Training Requests', () => {
  let gymId: string;
  let gymId2: string;
  let centerId: number;
  let spaceId: number;
  let trainerMembershipId: number;
  let hostActivityTypeId: number;
  let requestedActivityTypeId: number;
  let nonShareableActivityTypeId: number;
  let hostSessionId: number;
  let memberId: number;
  let requestId: number;

  beforeAll(async () => {
    gymId = await createTestGym('STR Gym');
    gymId2 = await createTestGym('STR Gym 2');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(gymId2, 'admin');

    centerId = await createCenter(gymId);
    spaceId = await createSpace(gymId, 2);
    trainerMembershipId = await createTrainerMembership(gymId, 2);
    hostActivityTypeId = await createShareableActivityType(gymId, 'Yoga');
    requestedActivityTypeId = await createShareableActivityType(gymId, 'Pilates');
    nonShareableActivityTypeId = await createNonShareableActivityType(gymId);
    hostSessionId = await createSession(gymId, centerId, hostActivityTypeId, trainerMembershipId, spaceId);
    memberId = await createMember(gymId);

    // Pre-create one pending request for read/approve/reject tests.
    const { insertId } = await db.query(
      `INSERT INTO shared_training_requests
       (gym_id, host_session_id, requested_activity_type_id, requesting_member_id)
       VALUES (?, ?, ?, ?)`,
      [gymId, hostSessionId, requestedActivityTypeId, memberId],
    );
    requestId = insertId;
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('returns 401 without auth token', async () => {
    const res = await request.get('/shared-training-requests').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('requires x-gym-id header', async () => {
    const res = await request.get('/shared-training-requests').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // GET / — list
  // -------------------------------------------------------------------------

  it('lists requests for the gym', async () => {
    const res = await request
      .get('/shared-training-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((r: any) => r.id === requestId);
    expect(found).toBeDefined();
    expect(found.status).toBe('pending');
  });

  it('filters by status', async () => {
    const res = await request
      .get('/shared-training-requests?status=pending')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    expect(res.body.every((r: any) => r.status === 'pending')).toBe(true);
  });

  it('rejects invalid status filter', async () => {
    const res = await request
      .get('/shared-training-requests?status=nonsense')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(400);
  });

  it('filters by host_session_id', async () => {
    const res = await request
      .get(`/shared-training-requests?host_session_id=${hostSessionId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    expect(res.body.every((r: any) => r.host_session_id === hostSessionId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // GET /:id — single
  // -------------------------------------------------------------------------

  it('returns a single request by id', async () => {
    const res = await request
      .get(`/shared-training-requests/${requestId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(requestId);
    expect(res.body.host_activity_name).toBe('Yoga');
    expect(res.body.requested_activity_name).toBe('Pilates');
  });

  it('returns 404 for unknown id', async () => {
    const res = await request
      .get('/shared-training-requests/999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  it('returns 404 when fetching a request from another gym', async () => {
    const res = await request
      .get(`/shared-training-requests/${requestId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId2);

    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // POST / — create
  // -------------------------------------------------------------------------

  it('creates a shared training request (staff)', async () => {
    const member2 = await createMember(gymId);
    const res = await request
      .post('/shared-training-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        host_session_id: hostSessionId,
        requested_activity_type_id: requestedActivityTypeId,
        requesting_member_id: member2,
        notes: 'Please accommodate',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.host_activity_name).toBe('Yoga');
  });

  it('rejects missing required fields', async () => {
    const res = await request
      .post('/shared-training-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ host_session_id: hostSessionId });

    expect(res.status).toBe(400);
  });

  it('rejects request for non-shareable host session', async () => {
    const nonShareSession = await createSession(gymId, centerId, nonShareableActivityTypeId, trainerMembershipId, spaceId, 2);
    const m = await createMember(gymId);
    const res = await request
      .post('/shared-training-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        host_session_id: nonShareSession,
        requested_activity_type_id: requestedActivityTypeId,
        requesting_member_id: m,
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('host_not_shareable');
  });

  it('rejects request for non-shareable requested activity', async () => {
    const m = await createMember(gymId);
    const res = await request
      .post('/shared-training-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        host_session_id: hostSessionId,
        requested_activity_type_id: nonShareableActivityTypeId,
        requesting_member_id: m,
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('activity_not_shareable');
  });

  it('rejects duplicate pending request for same slot+member', async () => {
    // requestId is already pending for memberId / hostSessionId / requestedActivityTypeId
    const res = await request
      .post('/shared-training-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        host_session_id: hostSessionId,
        requested_activity_type_id: requestedActivityTypeId,
        requesting_member_id: memberId,
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('duplicate_request');
  });

  // -------------------------------------------------------------------------
  // POST /:id/reject
  // -------------------------------------------------------------------------

  it('rejects a pending request', async () => {
    const m = await createMember(gymId);
    const { insertId } = await db.query(
      `INSERT INTO shared_training_requests
       (gym_id, host_session_id, requested_activity_type_id, requesting_member_id)
       VALUES (?, ?, ?, ?)`,
      [gymId, hostSessionId, requestedActivityTypeId, m],
    );

    const res = await request
      .post(`/shared-training-requests/${insertId}/reject`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.resolved_at).not.toBeNull();
  });

  it('returns 409 when rejecting an already-rejected request', async () => {
    const m = await createMember(gymId);
    const { insertId } = await db.query(
      `INSERT INTO shared_training_requests
       (gym_id, host_session_id, requested_activity_type_id, requesting_member_id, status)
       VALUES (?, ?, ?, ?, 'rejected')`,
      [gymId, hostSessionId, requestedActivityTypeId, m],
    );

    const res = await request
      .post(`/shared-training-requests/${insertId}/reject`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(409);
  });

  // -------------------------------------------------------------------------
  // POST /:id/approve
  // -------------------------------------------------------------------------

  it('approves a pending request and creates a concurrent session + booking', async () => {
    const m = await createMember(gymId);
    const { insertId } = await db.query(
      `INSERT INTO shared_training_requests
       (gym_id, host_session_id, requested_activity_type_id, requesting_member_id)
       VALUES (?, ?, ?, ?)`,
      [gymId, hostSessionId, requestedActivityTypeId, m],
    );

    const res = await request
      .post(`/shared-training-requests/${insertId}/approve`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.resolved_class_session_id).not.toBeNull();
    expect(res.body.resolved_at).not.toBeNull();

    // The host session should now have sharing_authorized = true.
    const { rows } = await db.query<{ sharing_authorized: number }>(
      'SELECT sharing_authorized FROM class_sessions WHERE id = ?',
      [hostSessionId],
    );
    expect(rows[0].sharing_authorized).toBe(1);

    // The member should have a booking for the new concurrent session.
    const { rows: bookings } = await db.query(
      'SELECT * FROM bookings WHERE member_id = ? AND class_session_id = ?',
      [m, res.body.resolved_class_session_id],
    );
    expect(bookings.length).toBeGreaterThan(0);
    expect(bookings[0].status).toBe('booked');
  });

  it('returns 409 when approving an already-approved request', async () => {
    // Find the most-recently-approved one from the previous test.
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM shared_training_requests WHERE gym_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1`,
      [gymId],
    );
    const approvedId = rows[0].id;

    const res = await request
      .post(`/shared-training-requests/${approvedId}/approve`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(409);
  });
});
