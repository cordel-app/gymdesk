// Tests for the `member_ids` assignment behavior on POST /class-sessions
// (classSessionsRouter in api/calendar-events.ts) — issue #366.
//
// Scoped specifically to the new `member_ids` field: validation, atomicity
// with the session INSERT, and the "capacity is advisory for staff" behavior
// (force=true never blocks or waitlists). General CRUD/auth-matrix coverage
// for POST /class-sessions is a pre-existing gap outside this ticket's scope.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let activityTypeId: number;      // max_capacity 5 — plenty of room
let lowCapActivityTypeId: number; // max_capacity 1 — used to prove capacity is advisory
let member1Id: number;
let member2Id: number;

function headers(gid = gymId) {
  return { Authorization: TEST_AUTH_HEADER, 'x-gym-id': gid };
}

async function createActivityType(maxCapacity: number, name: string): Promise<number> {
  const res = await request
    .post('/activity-types')
    .set(headers())
    .send({ name, duration_minutes: 45, max_capacity: maxCapacity, status: 'active' });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  gymId = await createTestGym('Class Sessions Member Assignment Gym');
  otherGymId = await createTestGym('Class Sessions Member Assignment Other Gym');
  await createTestMembership(gymId, 'admin');

  // classSessionsRouter's POST resolves center_id via resolveCenterId, which
  // falls back to the gym's sole center when none is given explicitly — so a
  // single center row is enough for every request below.
  await db.query(`INSERT INTO centers (gym_id, name) VALUES (?, ?)`, [gymId, 'Main Center']);

  activityTypeId = await createActivityType(5, 'Assignment Test Class');
  lowCapActivityTypeId = await createActivityType(1, 'Low Capacity Test Class');

  const { insertId: m1 } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Member One', ?)`,
    [gymId, `member1-${Date.now()}@test.com`],
  );
  member1Id = m1;
  const { insertId: m2 } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Member Two', ?)`,
    [gymId, `member2-${Date.now()}@test.com`],
  );
  member2Id = m2;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('POST /class-sessions — member_ids assignment (#366)', () => {
  it('books all given members onto the new session (happy path)', async () => {
    const res = await request
      .post('/class-sessions')
      .set(headers())
      .send({
        activity_type_id: activityTypeId,
        starts_at: '2026-01-05T09:00:00',
        ends_at: '2026-01-05T10:00:00',
        member_ids: [member1Id, member2Id],
      });

    expect(res.status).toBe(201);
    expect(res.body.booked_count).toBe(2);

    const { rows } = await db.query<{ member_id: number }>(
      `SELECT member_id FROM calendar_event_bookings WHERE calendar_event_id = ? AND status = 'booked'`,
      [res.body.id],
    );
    const bookedMemberIds = rows.map((r) => r.member_id).sort();
    expect(bookedMemberIds).toEqual([member1Id, member2Id].sort());
  });

  it('books every assigned member even over capacity — capacity is advisory, not blocking', async () => {
    const res = await request
      .post('/class-sessions')
      .set(headers())
      .send({
        activity_type_id: lowCapActivityTypeId, // max_capacity: 1
        starts_at: '2026-01-06T09:00:00',
        ends_at: '2026-01-06T10:00:00',
        member_ids: [member1Id, member2Id],
      });

    expect(res.status).toBe(201);
    expect(res.body.effective_capacity).toBe(1);
    // Both members landed as 'booked' (not waitlisted) despite capacity 1 —
    // proof that force=true bypassed the capacity check for both.
    expect(res.body.booked_count).toBe(2);

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM calendar_event_bookings WHERE calendar_event_id = ?`,
      [res.body.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'booked')).toBe(true);
  });

  it('returns 400 and creates no session when a member_id does not exist for this gym', async () => {
    const uniqueStartsAt = '2026-01-07T11:15:00';
    const res = await request
      .post('/class-sessions')
      .set(headers())
      .send({
        activity_type_id: activityTypeId,
        starts_at: uniqueStartsAt,
        ends_at: '2026-01-07T12:15:00',
        member_ids: [999999],
      });

    expect(res.status).toBe(400);

    const { rows } = await db.query(
      `SELECT id FROM calendar_events WHERE gym_id = ? AND starts_at = ?`,
      [gymId, uniqueStartsAt],
    );
    expect(rows).toHaveLength(0);
  });

  it('returns 400 when member_ids is not an array', async () => {
    const res = await request
      .post('/class-sessions')
      .set(headers())
      .send({
        activity_type_id: activityTypeId,
        starts_at: '2026-01-08T09:00:00',
        ends_at: '2026-01-08T10:00:00',
        member_ids: 'nope',
      });

    expect(res.status).toBe(400);
  });

  it('still creates a session with booked_count: 0 when member_ids is omitted (regression)', async () => {
    const res = await request
      .post('/class-sessions')
      .set(headers())
      .send({
        activity_type_id: activityTypeId,
        starts_at: '2026-01-09T09:00:00',
        ends_at: '2026-01-09T10:00:00',
      });

    expect(res.status).toBe(201);
    expect(res.body.booked_count).toBe(0);
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .post('/class-sessions')
      .set('x-gym-id', gymId)
      .send({
        activity_type_id: activityTypeId,
        starts_at: '2026-01-10T09:00:00',
        ends_at: '2026-01-10T10:00:00',
        member_ids: [member1Id],
      });

    expect(res.status).toBe(401);
  });

  it('returns 403 when creating a session in a gym the caller has no membership in', async () => {
    const res = await request
      .post('/class-sessions')
      .set(headers(otherGymId))
      .send({
        activity_type_id: activityTypeId,
        starts_at: '2026-01-11T09:00:00',
        ends_at: '2026-01-11T10:00:00',
        member_ids: [member1Id],
      });

    expect(res.status).toBe(403);
  });
});
