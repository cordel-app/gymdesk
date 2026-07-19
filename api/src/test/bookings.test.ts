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

async function createActivityType(gymId: string, maxCapacity: number): Promise<number> {
  // Insert into activity_types. On older DB schemas class_types still exists and
  // class_sessions.class_type_id FKs into it, so mirror the row there too.
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

async function createCenter(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO centers (gym_id, name) VALUES (?, ?)`,
    [gymId, `Center-${Date.now()}`],
  );
  return insertId;
}

async function createSession(gymId: string, activityTypeId: number, centerId: number, maxCapacityOverride: number | null = null): Promise<number> {
  // class_type_id is a legacy NOT NULL column present in older DB states (pre-059 drop).
  // Try with it first; if the column no longer exists, fall back without it.
  try {
    const { insertId } = await db.query(
      `INSERT INTO class_sessions (gym_id, activity_type_id, class_type_id, center_id, starts_at, ends_at, status, max_capacity_override)
       VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 25 HOUR), 'scheduled', ?)`,
      [gymId, activityTypeId, activityTypeId, centerId, maxCapacityOverride],
    );
    return insertId;
  } catch (err: any) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    const { insertId } = await db.query(
      `INSERT INTO class_sessions (gym_id, activity_type_id, center_id, starts_at, ends_at, status, max_capacity_override)
       VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 25 HOUR), 'scheduled', ?)`,
      [gymId, activityTypeId, centerId, maxCapacityOverride],
    );
    return insertId;
  }
}

async function createMember(gymId: string, centerId: number, email: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Test Member', ?)`,
    [gymId, email],
  );
  await db.query(
    `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at) VALUES (?, ?, ?, 1, UTC_TIMESTAMP())`,
    [gymId, insertId, centerId],
  );
  return insertId;
}

describe('Bookings', () => {
  let gymId: string;
  let activityTypeId: number;
  let centerId: number;
  let sessionId: number;
  let member1Id: number;
  let member2Id: number;

  beforeAll(async () => {
    gymId = await createTestGym('Bookings Gym');
    await createTestMembership(gymId, 'admin');
    centerId = await createCenter(gymId);
    activityTypeId = await createActivityType(gymId, 1); // capacity of 1 to test waitlist
    sessionId = await createSession(gymId, activityTypeId, centerId);
    member1Id = await createMember(gymId, centerId, `m1-${Date.now()}@test.com`);
    member2Id = await createMember(gymId, centerId, `m2-${Date.now()}@test.com`);
  });

  it('books a member when capacity is available', async () => {
    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: member1Id, class_session_id: sessionId });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('booked');
    expect(res.body.waitlist_position).toBeNull();
  });

  it('waitlists a member when capacity is full', async () => {
    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: member2Id, class_session_id: sessionId });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('waitlisted');
    expect(res.body.waitlist_position).toBe(1);
  });

  it('returns 409 on a duplicate active booking for the same member+session', async () => {
    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: member1Id, class_session_id: sessionId });

    expect(res.status).toBe(409);
  });

  it('promotes waitlisted member when booked slot is cancelled', async () => {
    // Find booking for member1 (the booked one)
    const listRes = await request
      .get(`/bookings?session_id=${sessionId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const bookedBooking = listRes.body.find((b: any) => b.member_id === member1Id && b.status === 'booked');
    const waitlistedBooking = listRes.body.find((b: any) => b.member_id === member2Id && b.status === 'waitlisted');
    expect(bookedBooking).toBeDefined();
    expect(waitlistedBooking).toBeDefined();

    // Cancel the booked booking
    const cancelRes = await request
      .delete(`/bookings/${bookedBooking.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(cancelRes.status).toBe(204);

    // Verify the waitlisted member was promoted
    const { rows } = await db.query(
      `SELECT status, waitlist_position FROM bookings WHERE id = ?`,
      [waitlistedBooking.id],
    );
    expect(rows[0].status).toBe('booked');
    expect(rows[0].waitlist_position).toBeNull();
  });

  it('records attendance (mark as attended)', async () => {
    // Get the now-booked member2 booking
    const listRes = await request
      .get(`/bookings?session_id=${sessionId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const booking = listRes.body.find((b: any) => b.member_id === member2Id && b.status === 'booked');
    expect(booking).toBeDefined();

    const res = await request
      .post(`/bookings/${booking.id}/attendance`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ status: 'attended' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('attended');
  });
});
