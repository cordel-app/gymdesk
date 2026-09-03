// Tests for #323+#324: /shared-training-requests admin router
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

async function createActivityType(gid: string, shareable = true, capacity = 10): Promise<number> {
  const name = `AT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { insertId } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status, is_shareable)
     VALUES (?, ?, ?, 'active', ?)`,
    [gid, name, capacity, shareable ? 1 : 0],
  );
  await db.query(
    `INSERT IGNORE INTO class_types (id, gym_id, name, max_capacity, status)
     VALUES (?, ?, ?, ?, 'active')`,
    [insertId, gid, name, capacity],
  ).catch(() => { /* class_types dropped on fully-migrated DBs */ });
  return insertId;
}

async function createSession(
  gid: string,
  atId: number,
  cid: number,
  allowsShared: 0 | 1 = 1,
  spaceId?: number,
  trainerMembershipId?: number,
): Promise<number> {
  try {
    const { insertId } = await db.query(
      `INSERT INTO class_sessions
         (gym_id, activity_type_id, class_type_id, center_id, space_id, trainer_membership_id,
          starts_at, ends_at, status, allows_shared_booking)
       VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY),
               DATE_ADD(UTC_TIMESTAMP(), INTERVAL 25 HOUR), 'scheduled', ?)`,
      [gid, atId, atId, cid, spaceId ?? null, trainerMembershipId ?? null, allowsShared],
    );
    return insertId;
  } catch (err: any) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    const { insertId } = await db.query(
      `INSERT INTO class_sessions
         (gym_id, activity_type_id, center_id, space_id, trainer_membership_id,
          starts_at, ends_at, status, allows_shared_booking)
       VALUES (?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY),
               DATE_ADD(UTC_TIMESTAMP(), INTERVAL 25 HOUR), 'scheduled', ?)`,
      [gid, atId, cid, spaceId ?? null, trainerMembershipId ?? null, allowsShared],
    );
    return insertId;
  }
}

async function createSharedRequest(gid: string, csId: number, membId: number, atId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO shared_training_requests
       (gym_id, class_session_id, requesting_member_id, activity_type_id, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', UTC_TIMESTAMP())`,
    [gid, csId, membId, atId],
  );
  return insertId;
}

async function createSpace(gid: string, maxGroups = 2): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO spaces (gym_id, name, capacity, max_concurrent_groups) VALUES (?, 'Studio', 20, ?)`,
    [gid, maxGroups],
  );
  return insertId;
}

async function createTrainerMembership(gid: string, maxGroups = 2): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role, status, max_concurrent_groups)
     VALUES (?, ?, 'trainer_performance', 'active', ?)`,
    [`trainer-${Date.now()}`, gid, maxGroups],
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

  activityTypeId = await createActivityType(gymId);
  sessionId = await createSession(gymId, activityTypeId, centerId, 1);

  const email = `str-member-${Date.now()}@test.com`;
  await db.query(
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
// Auth & tenant isolation
// ---------------------------------------------------------------------------

describe('GET /shared-training-requests — auth', () => {
  it('requires x-gym-id', async () => {
    const res = await request.get('/shared-training-requests').set("Authorization", TEST_AUTH_HEADER);
    expect(res.status).toBe(401);
  });

  it('returns 200 for admin', async () => {
    const res = await request
      .get('/shared-training-requests')
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('GET /shared-training-requests — tenant isolation', () => {
  it('returns 404 when accessing request from another gym', async () => {
    const res = await request
      .get(`/shared-training-requests/${pendingRequestId}`)
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymBId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET list
// ---------------------------------------------------------------------------

describe('GET /shared-training-requests', () => {
  it('lists requests for the gym', async () => {
    const res = await request
      .get('/shared-training-requests')
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain(pendingRequestId);
  });

  it('filters by status=pending', async () => {
    const res = await request
      .get('/shared-training-requests?status=pending')
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.every((r: any) => r.status === 'pending')).toBe(true);
  });

  it('rejects invalid status', async () => {
    const res = await request
      .get('/shared-training-requests?status=bogus')
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET single
// ---------------------------------------------------------------------------

describe('GET /shared-training-requests/:id', () => {
  it('returns a single request with joined fields', async () => {
    const res = await request
      .get(`/shared-training-requests/${pendingRequestId}`)
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(pendingRequestId);
    expect(res.body).toHaveProperty('requesting_member_name');
    expect(res.body).toHaveProperty('activity_type_name');
    expect(res.body).toHaveProperty('starts_at');
  });

  it('returns 404 for unknown id', async () => {
    const res = await request
      .get('/shared-training-requests/999999')
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST / (staff create)
// ---------------------------------------------------------------------------

describe('POST /shared-training-requests', () => {
  it('creates a request for a valid session', async () => {
    const at = await createActivityType(gymId);
    const cs = await createSession(gymId, at, centerId, 1);
    const { insertId: newMember } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'New Member', ?)`,
      [gymId, `staff-create-${Date.now()}@test.com`],
    );

    const res = await request
      .post('/shared-training-requests')
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ class_session_id: cs, requesting_member_id: newMember });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
  });

  it('rejects missing required fields', async () => {
    const res = await request
      .post('/shared-training-requests')
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ class_session_id: sessionId });
    expect(res.status).toBe(400);
  });

  it('rejects when activity type is not shareable', async () => {
    const nonShareAt = await createActivityType(gymId, false);
    const nonShareCs = await createSession(gymId, nonShareAt, centerId, 0);
    const { insertId: m2 } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'M2', ?)`,
      [gymId, `ns-member-${Date.now()}@test.com`],
    );
    const res = await request
      .post('/shared-training-requests')
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ class_session_id: nonShareCs, requesting_member_id: m2 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_shareable');
  });

  it('rejects when allows_shared_booking = false', async () => {
    const at2 = await createActivityType(gymId);
    const noSharedCs = await createSession(gymId, at2, centerId, 0);
    const { insertId: m3 } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'M3', ?)`,
      [gymId, `noshared-${Date.now()}@test.com`],
    );
    const res = await request
      .post('/shared-training-requests')
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ class_session_id: noSharedCs, requesting_member_id: m3 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('sharing_not_allowed');
  });
});

// ---------------------------------------------------------------------------
// POST /:id/approve
// ---------------------------------------------------------------------------

describe('POST /shared-training-requests/:id/approve', () => {
  it('approves a pending request and books the member', async () => {
    const at = await createActivityType(gymId);
    const cs = await createSession(gymId, at, centerId, 1);
    const { insertId: m } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Approve Me', ?)`,
      [gymId, `approve-${Date.now()}@test.com`],
    );
    const reqId = await createSharedRequest(gymId, cs, m, at);

    const res = await request
      .post(`/shared-training-requests/${reqId}/approve`)
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');

    const { rows: bookings } = await db.query(
      'SELECT id FROM bookings WHERE member_id = ? AND class_session_id = ? AND status = ?',
      [m, cs, 'booked'],
    );
    expect(bookings.length).toBe(1);
  });

  it('rejects approval of an already approved request', async () => {
    const at = await createActivityType(gymId);
    const cs = await createSession(gymId, at, centerId, 1);
    const { insertId: m } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Double Approve', ?)`,
      [gymId, `dbl-approve-${Date.now()}@test.com`],
    );
    const reqId = await createSharedRequest(gymId, cs, m, at);

    await request.post(`/shared-training-requests/${reqId}/approve`).set("Authorization", TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const res = await request
      .post(`/shared-training-requests/${reqId}/approve`)
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
  });

  it('enforces max_concurrent_groups from space (slot_fully_occupied)', async () => {
    const spaceId = await createSpace(gymId, 1);
    const trainerId = await createTrainerMembership(gymId, 1);
    const at = await createActivityType(gymId, true, 1); // capacity=1 so extra starts at 0
    const cs = await createSession(gymId, at, centerId, 1, spaceId, trainerId);

    // Fill to capacity
    const { insertId: bm } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Filler', ?)`,
      [gymId, `filler-cap-${Date.now()}@test.com`],
    );
    await db.query(
      `INSERT INTO bookings (gym_id, center_id, member_id, class_session_id, status, booked_at)
       VALUES (?, ?, ?, ?, 'booked', UTC_TIMESTAMP())`,
      [gymId, centerId, bm, cs],
    );

    const { insertId: m } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Over Cap', ?)`,
      [gymId, `over-cap-${Date.now()}@test.com`],
    );
    const reqId = await createSharedRequest(gymId, cs, m, at);

    const res = await request
      .post(`/shared-training-requests/${reqId}/approve`)
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('slot_fully_occupied');
  });

  it('returns 404 for unknown request', async () => {
    const res = await request
      .post('/shared-training-requests/999999/approve')
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/reject
// ---------------------------------------------------------------------------

describe('POST /shared-training-requests/:id/reject', () => {
  it('rejects a pending request', async () => {
    const at = await createActivityType(gymId);
    const cs = await createSession(gymId, at, centerId, 1);
    const { insertId: m } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Reject Me', ?)`,
      [gymId, `reject-${Date.now()}@test.com`],
    );
    const reqId = await createSharedRequest(gymId, cs, m, at);

    const res = await request
      .post(`/shared-training-requests/${reqId}/reject`)
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  it('rejects double-rejection', async () => {
    const at = await createActivityType(gymId);
    const cs = await createSession(gymId, at, centerId, 1);
    const { insertId: m } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Reject2', ?)`,
      [gymId, `reject2-${Date.now()}@test.com`],
    );
    const reqId = await createSharedRequest(gymId, cs, m, at);

    await request.post(`/shared-training-requests/${reqId}/reject`).set("Authorization", TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const res = await request
      .post(`/shared-training-requests/${reqId}/reject`)
      .set("Authorization", TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
  });
});
