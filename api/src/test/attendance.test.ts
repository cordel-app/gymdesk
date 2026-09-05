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

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function createActivityType(gymId: string, maxCapacity = 10): Promise<number> {
  const name = `AttClass-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { insertId } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, ?, ?, 'active')`,
    [gymId, name, maxCapacity],
  );
  // Mirror into class_types so class_sessions.class_type_id FK is satisfied on CI
  // (pre-migration-059 schema still has that column and constraint).
  await db.query(
    `INSERT IGNORE INTO class_types (id, gym_id, name, max_capacity, status) VALUES (?, ?, ?, ?, 'active')`,
    [insertId, gymId, name, maxCapacity],
  ).catch(() => { /* class_types may not exist on fully-migrated DBs */ });
  return insertId;
}

async function createCenter(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO centers (gym_id, name) VALUES (?, ?)`,
    [gymId, `AttCenter-${Date.now()}`],
  );
  return insertId;
}

async function createSession(gymId: string, activityTypeId: number, centerId: number, trainerId: number | null = null): Promise<number> {
  try {
    const { insertId } = await db.query(
      `INSERT INTO class_sessions (gym_id, activity_type_id, class_type_id, center_id, trainer_membership_id, starts_at, ends_at, status)
       VALUES (?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 25 HOUR), 'scheduled')`,
      [gymId, activityTypeId, activityTypeId, centerId, trainerId],
    );
    return insertId;
  } catch (err: any) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    const { insertId } = await db.query(
      `INSERT INTO class_sessions (gym_id, activity_type_id, center_id, trainer_membership_id, starts_at, ends_at, status)
       VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 25 HOUR), 'scheduled')`,
      [gymId, activityTypeId, centerId, trainerId],
    );
    return insertId;
  }
}

async function createMember(gymId: string, centerId: number): Promise<number> {
  const email = `att-member-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`;
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Att Member', ?)`,
    [gymId, email],
  );
  await db.query(
    `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at) VALUES (?, ?, ?, 1, UTC_TIMESTAMP())`,
    [gymId, insertId, centerId],
  );
  return insertId;
}

async function createBooking(gymId: string, centerId: number, memberId: number, sessionId: number, status: 'booked' | 'waitlisted' | 'cancelled' = 'booked'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO bookings (gym_id, center_id, member_id, class_session_id, status, booked_at)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [gymId, centerId, memberId, sessionId, status],
  );
  return insertId;
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('Attendance Management (#193)', () => {
  let gymId: string;
  let gymIdB: string; // for tenant isolation
  let centerId: number;
  let activityTypeId: number;
  let sessionId: number;
  let memberId: number;
  let trainerMembershipId: number;

  const TRAINER_USER_ID = 'att-trainer-user';

  beforeAll(async () => {
    gymId = await createTestGym('Attendance Gym A');
    gymIdB = await createTestGym('Attendance Gym B');

    // Admin (default TEST_USER_ID)
    await createTestMembership(gymId, 'admin');

    // Trainer
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status) VALUES (?, ?, 'trainer_performance', 'active')`,
      [TRAINER_USER_ID, gymId],
    );
    const { rows: trRows } = await db.query<{ id: number }>(
      `SELECT id FROM gym_memberships WHERE user_id = ? AND gym_id = ?`,
      [TRAINER_USER_ID, gymId],
    );
    trainerMembershipId = trRows[0].id;

    centerId = await createCenter(gymId);
    activityTypeId = await createActivityType(gymId, 5);
    sessionId = await createSession(gymId, activityTypeId, centerId, trainerMembershipId);
    memberId = await createMember(gymId, centerId);

    // Gym B: separate admin for tenant isolation
    await createTestMembership(gymIdB, 'admin');
  });

  // ── POST /bookings/:id/attendance ─────────────────────────────────────────

  describe('POST /bookings/:id/attendance', () => {
    it('returns 401 when unauthenticated', async () => {
      const bookingId = await createBooking(gymId, centerId, memberId, sessionId);
      const res = await request.post(`/bookings/${bookingId}/attendance`).send({ status: 'present' });
      expect(res.status).toBe(401);
    });

    it('returns 403 for member role', async () => {
      const memberGymId = await createTestGym('Attendance Member Gym');
      await createTestMembership(memberGymId, 'member');
      const res = await request
        .post(`/bookings/99999/attendance`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', memberGymId)
        .send({ status: 'present' });
      expect(res.status).toBe(403);
    });

    it('returns 400 for invalid status value', async () => {
      const bookingId = await createBooking(gymId, centerId, await createMember(gymId, centerId), sessionId);
      const res = await request
        .post(`/bookings/${bookingId}/attendance`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ status: 'attended' }); // old value, no longer valid
      expect(res.status).toBe(400);
    });

    it('marks a booked booking as present', async () => {
      const mid = await createMember(gymId, centerId);
      const bookingId = await createBooking(gymId, centerId, mid, sessionId);

      const res = await request
        .post(`/bookings/${bookingId}/attendance`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ status: 'present' });

      expect(res.status).toBe(200);
      expect(res.body.attendance_status).toBe('present');
      expect(res.body.status).toBe('booked'); // booking status unchanged
    });

    it('marks a booked booking as absent', async () => {
      const mid = await createMember(gymId, centerId);
      const bookingId = await createBooking(gymId, centerId, mid, sessionId);

      const res = await request
        .post(`/bookings/${bookingId}/attendance`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ status: 'absent' });

      expect(res.status).toBe(200);
      expect(res.body.attendance_status).toBe('absent');
    });

    it('allows correcting attendance from present to absent', async () => {
      const mid = await createMember(gymId, centerId);
      const bookingId = await createBooking(gymId, centerId, mid, sessionId);

      await request
        .post(`/bookings/${bookingId}/attendance`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ status: 'present' });

      const res = await request
        .post(`/bookings/${bookingId}/attendance`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ status: 'absent' });

      expect(res.status).toBe(200);
      expect(res.body.attendance_status).toBe('absent');
    });

    it('returns 404 for a waitlisted booking', async () => {
      const mid = await createMember(gymId, centerId);
      const bookingId = await createBooking(gymId, centerId, mid, sessionId, 'waitlisted');

      const res = await request
        .post(`/bookings/${bookingId}/attendance`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ status: 'present' });

      expect(res.status).toBe(404);
    });

    it('returns 404 for a cancelled booking', async () => {
      const mid = await createMember(gymId, centerId);
      const bookingId = await createBooking(gymId, centerId, mid, sessionId, 'cancelled');

      const res = await request
        .post(`/bookings/${bookingId}/attendance`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ status: 'present' });

      expect(res.status).toBe(404);
    });

    it('returns 404 (tenant isolation) for a booking from gym A accessed with gym B credentials', async () => {
      const mid = await createMember(gymId, centerId);
      const bookingId = await createBooking(gymId, centerId, mid, sessionId);

      const res = await request
        .post(`/bookings/${bookingId}/attendance`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymIdB)
        .send({ status: 'present' });

      expect(res.status).toBe(404);
    });
  });

  // ── POST /class-sessions/:id/bulk-present ─────────────────────────────────

  describe('POST /class-sessions/:id/bulk-present', () => {
    it('returns 403 for member role', async () => {
      const memberGymId = await createTestGym('Bulk Present Member Gym');
      await createTestMembership(memberGymId, 'member');
      const res = await request
        .post(`/class-sessions/${sessionId}/bulk-present`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', memberGymId);
      expect(res.status).toBe(403);
    });

    it('marks all pending booked bookings as present and leaves waitlisted untouched', async () => {
      const bulkSessionId = await createSession(gymId, activityTypeId, centerId);
      const m1 = await createMember(gymId, centerId);
      const m2 = await createMember(gymId, centerId);
      const m3 = await createMember(gymId, centerId);
      await createBooking(gymId, centerId, m1, bulkSessionId, 'booked');
      await createBooking(gymId, centerId, m2, bulkSessionId, 'booked');
      await createBooking(gymId, centerId, m3, bulkSessionId, 'waitlisted');

      const res = await request
        .post(`/class-sessions/${bulkSessionId}/bulk-present`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(2); // only the two booked ones

      // Verify waitlisted booking attendance_status is still pending
      const { rows } = await db.query(
        `SELECT attendance_status FROM bookings WHERE class_session_id = ? AND status = 'waitlisted'`,
        [bulkSessionId],
      );
      expect(rows[0].attendance_status).toBe('pending');
    });

    it('does not re-mark already-present bookings', async () => {
      const bulkSessionId = await createSession(gymId, activityTypeId, centerId);
      const m1 = await createMember(gymId, centerId);
      const m2 = await createMember(gymId, centerId);
      const b1 = await createBooking(gymId, centerId, m1, bulkSessionId, 'booked');
      await createBooking(gymId, centerId, m2, bulkSessionId, 'booked');

      // Mark b1 as present first
      await db.query(`UPDATE bookings SET attendance_status = 'present' WHERE id = ?`, [b1]);

      const res = await request
        .post(`/class-sessions/${bulkSessionId}/bulk-present`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(1); // only the still-pending one
    });
  });

  // ── PUT /class-sessions/:id/effective-trainer ─────────────────────────────

  describe('PUT /class-sessions/:id/effective-trainer', () => {
    it('sets the effective trainer on a session', async () => {
      const res = await request
        .put(`/class-sessions/${sessionId}/effective-trainer`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ trainer_membership_id: trainerMembershipId });

      expect(res.status).toBe(200);
      expect(res.body.effective_trainer_membership_id).toBe(trainerMembershipId);
      expect(res.body.effective_trainer_confirmed_at).not.toBeNull();
      // #352: assigned trainer_name must be returned alongside effective_trainer_name
      // so the calendar can fall back to it when no effective trainer is confirmed yet.
      expect(res.body.trainer_name).toBeTruthy();
    });

    it('returns 404 for a non-trainer membership id', async () => {
      // Admin membership is not a trainer role
      const { rows } = await db.query<{ id: number }>(
        `SELECT id FROM gym_memberships WHERE user_id = ? AND gym_id = ?`,
        [TEST_USER_ID, gymId],
      );
      const adminMembershipId = rows[0].id;

      const res = await request
        .put(`/class-sessions/${sessionId}/effective-trainer`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ trainer_membership_id: adminMembershipId });

      expect(res.status).toBe(404);
    });

    it('clears the effective trainer when null is sent', async () => {
      const res = await request
        .put(`/class-sessions/${sessionId}/effective-trainer`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ trainer_membership_id: null });

      expect(res.status).toBe(200);
      expect(res.body.effective_trainer_membership_id).toBeNull();
    });
  });

  // ── POST /class-sessions/:id/complete ────────────────────────────────────

  describe('POST /class-sessions/:id/complete', () => {
    it('blocks completion when pending attendance exists', async () => {
      const complSessionId = await createSession(gymId, activityTypeId, centerId, trainerMembershipId);
      const mid = await createMember(gymId, centerId);
      await createBooking(gymId, centerId, mid, complSessionId, 'booked');
      // attendance_status is 'pending' by default

      const res = await request
        .post(`/class-sessions/${complSessionId}/complete`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(400);
      expect(res.body.pending_count).toBeGreaterThan(0);
    });

    it('blocks completion when no trainer is set', async () => {
      // Session with no trainer_membership_id and no effective_trainer_membership_id
      const complSessionId = await createSession(gymId, activityTypeId, centerId, null);
      const mid = await createMember(gymId, centerId);
      const bookingId = await createBooking(gymId, centerId, mid, complSessionId, 'booked');
      await db.query(`UPDATE bookings SET attendance_status = 'present' WHERE id = ?`, [bookingId]);

      const res = await request
        .post(`/class-sessions/${complSessionId}/complete`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(400);
      expect(res.body.missing_trainer).toBe(true);
    });

    it('completes successfully when all attendance is marked and trainer is set', async () => {
      const complSessionId = await createSession(gymId, activityTypeId, centerId, trainerMembershipId);
      const m1 = await createMember(gymId, centerId);
      const m2 = await createMember(gymId, centerId);
      const b1 = await createBooking(gymId, centerId, m1, complSessionId, 'booked');
      const b2 = await createBooking(gymId, centerId, m2, complSessionId, 'booked');
      // Waitlisted booking — should not block completion
      const m3 = await createMember(gymId, centerId);
      await createBooking(gymId, centerId, m3, complSessionId, 'waitlisted');

      await db.query(`UPDATE bookings SET attendance_status = 'present' WHERE id = ?`, [b1]);
      await db.query(`UPDATE bookings SET attendance_status = 'absent'  WHERE id = ?`, [b2]);

      const res = await request
        .post(`/class-sessions/${complSessionId}/complete`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
    });

    it('returns 400 if session is already completed', async () => {
      const complSessionId = await createSession(gymId, activityTypeId, centerId, trainerMembershipId);
      await db.query(`UPDATE class_sessions SET status = 'completed' WHERE id = ?`, [complSessionId]);

      const res = await request
        .post(`/class-sessions/${complSessionId}/complete`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(400);
    });

    it('returns 404 (tenant isolation) for a session from gym A accessed with gym B credentials', async () => {
      const res = await request
        .post(`/class-sessions/${sessionId}/complete`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymIdB);

      expect(res.status).toBe(404);
    });
  });

  // ── force booking (over-capacity walk-in) ─────────────────────────────────

  describe('POST /bookings with force=true', () => {
    it('adds a member as booked even when session is at capacity', async () => {
      const tinySessionId = await createSession(gymId, await createActivityType(gymId, 1), centerId);
      const m1 = await createMember(gymId, centerId);
      const m2 = await createMember(gymId, centerId);

      // Fill the single slot
      await request
        .post('/bookings')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ member_id: m1, class_session_id: tinySessionId });

      // Force-add a second member
      const res = await request
        .post('/bookings')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ member_id: m2, class_session_id: tinySessionId, force: true });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('booked');
      expect(res.body.over_capacity).toBe(true);
    });
  });
});
