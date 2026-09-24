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

async function createActivityType(
  gymId: string,
  maxCapacity: number,
  name = 'Test Class',
  waitlistMode: 'disabled' | 'open' | 'closed' = 'open',
): Promise<number> {
  // Insert into activity_types. On older DB schemas class_types still exists and
  // class_sessions.class_type_id FKs into it, so mirror the row there too.
  // waitlist_mode defaults to 'disabled' in the schema (#503 stage 2), so suites
  // exercising the waitlist ask for 'open' explicitly.
  const { insertId } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status, waitlist_mode) VALUES (?, ?, ?, 'active', ?)`,
    [gymId, name, maxCapacity, waitlistMode],
  );
  await db.query(
    `INSERT IGNORE INTO class_types (id, gym_id, name, max_capacity, status) VALUES (?, ?, ?, ?, 'active')`,
    [insertId, gymId, name, maxCapacity],
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
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, activity_type_id, starts_at, ends_at, status, capacity)
     VALUES (?, ?, 'Test Session', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 25 HOUR), 'scheduled', ?)`,
    [gymId, centerId, activityTypeId, maxCapacityOverride],
  );
  return insertId;
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
      `SELECT status, waitlist_position FROM calendar_event_bookings WHERE id = ?`,
      [waitlistedBooking.id],
    );
    expect(rows[0].status).toBe('booked');
    expect(rows[0].waitlist_position).toBeNull();
  });

  it('records attendance (mark as present)', async () => {
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
      .send({ status: 'present' });

    expect(res.status).toBe(200);
    expect(res.body.attendance_status).toBe('present');
    expect(res.body.status).toBe('booked'); // lifecycle status unchanged
  });
});

describe('Bookings — activity type eligibility (#481)', () => {
  let gymId: string;
  let centerId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Eligibility Gym');
    await createTestMembership(gymId, 'admin');
    centerId = await createCenter(gymId);
  });

  async function createPlan(name: string): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'staff_only')`,
      [gymId, name],
    );
    return insertId;
  }

  async function assignActivePlan(memberId: number, planId: number): Promise<void> {
    await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at) VALUES (?, ?, ?, 'active', CURDATE())`,
      [gymId, memberId, planId],
    );
  }

  it('rejects booking a non-public activity type with no eligible plans configured', async () => {
    const atId = await createActivityType(gymId, 5, 'Elig No Plan Class');
    await db.query('UPDATE activity_types SET public_event = 0 WHERE id = ?', [atId]);
    const sessionId = await createSession(gymId, atId, centerId);
    const memberId = await createMember(gymId, centerId, `elig-noplan-${Date.now()}@test.com`);

    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, class_session_id: sessionId });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('plan_not_eligible');
  });

  it('allows booking when the member is on an eligible plan', async () => {
    const atId = await createActivityType(gymId, 5, 'Elig Yes Plan Class');
    await db.query('UPDATE activity_types SET public_event = 0 WHERE id = ?', [atId]);
    const sessionId = await createSession(gymId, atId, centerId);
    const memberId = await createMember(gymId, centerId, `elig-yesplan-${Date.now()}@test.com`);

    const planId = await createPlan('Eligible Plan');
    await assignActivePlan(memberId, planId);
    await db.query(
      'INSERT INTO activity_type_eligible_plans (gym_id, activity_type_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, atId, planId],
    );
    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, class_session_id: sessionId });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('booked');
  });

  it('regression: a public activity type (default) allows booking regardless of plan', async () => {
    // No public_event set at all — proving the create-time default of true
    // preserves pre-existing (zero-configuration) booking behavior.
    const atId = await createActivityType(gymId, 5, 'Elig Public Class');
    const sessionId = await createSession(gymId, atId, centerId);
    const memberId = await createMember(gymId, centerId, `elig-public-${Date.now()}@test.com`);

    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, class_session_id: sessionId });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('booked');
  });

  it('staff override: an ineligible booking is rejected without override, then succeeds with override_eligibility', async () => {
    const atId = await createActivityType(gymId, 5, 'Elig Override Class');
    await db.query('UPDATE activity_types SET public_event = 0 WHERE id = ?', [atId]);
    const sessionId = await createSession(gymId, atId, centerId);
    const memberId = await createMember(gymId, centerId, `elig-override-${Date.now()}@test.com`);

    const rejected = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, class_session_id: sessionId });
    expect(rejected.status).toBe(403);
    expect(rejected.body.code).toBe('plan_not_eligible');

    const overridden = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, class_session_id: sessionId, override_eligibility: true });
    expect(overridden.status).toBe(201);
    expect(overridden.body.status).toBe('booked');
  });
});

describe('Bookings — explicit waitlist (#326)', () => {
  let gymId: string;
  let sessionId: number;
  let member1Id: number;
  let member2Id: number;

  beforeAll(async () => {
    gymId = await createTestGym('Waitlist Explicit Gym');
    await createTestMembership(gymId, 'admin');
    const centerId = await createCenter(gymId);
    const atId = await createActivityType(gymId, 5); // capacity 5 — plenty of room
    sessionId = await createSession(gymId, atId, centerId);
    member1Id = await createMember(gymId, centerId, `wl-m1-${Date.now()}@test.com`);
    member2Id = await createMember(gymId, centerId, `wl-m2-${Date.now()}@test.com`);
  });

  it('adds member to waitlist even when capacity is available (waitlist=true)', async () => {
    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: member1Id, class_session_id: sessionId, waitlist: true });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('waitlisted');
    expect(res.body.waitlist_position).toBe(1);
  });

  it('returns 409 on duplicate waiting-list entry for same member+session', async () => {
    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: member1Id, class_session_id: sessionId, waitlist: true });

    expect(res.status).toBe(409);
  });

  it('appends subsequent members at the correct FIFO position', async () => {
    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: member2Id, class_session_id: sessionId, waitlist: true });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('waitlisted');
    expect(res.body.waitlist_position).toBe(2);
  });
});

describe('Bookings — waitlist mode (#503 stage 2)', () => {
  let gymId: string;
  let centerId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Waitlist Mode Gym');
    await createTestMembership(gymId, 'admin');
    centerId = await createCenter(gymId);
  });

  async function fullSession(waitlistMode: 'disabled' | 'open' | 'closed', label: string) {
    const atId = await createActivityType(gymId, 1, `WM ${label} ${Date.now()}`, waitlistMode);
    const sessionId = await createSession(gymId, atId, centerId);
    const holder = await createMember(gymId, centerId, `wm-h-${label}-${Date.now()}@test.com`);
    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: holder, class_session_id: sessionId });
    expect(res.body.status).toBe('booked');
    return { atId, sessionId };
  }

  it('rejects an over-capacity booking with 409 when the waitlist is disabled', async () => {
    const { sessionId } = await fullSession('disabled', 'disabled');
    const memberId = await createMember(gymId, centerId, `wm-d-${Date.now()}@test.com`);

    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, class_session_id: sessionId });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('session_full_waitlist_not_open');

    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM calendar_event_bookings WHERE calendar_event_id = ? AND status = 'waitlisted'`,
      [sessionId],
    );
    expect(Number(rows[0].cnt)).toBe(0);
  });

  it('rejects an over-capacity booking when the waitlist is closed', async () => {
    const { sessionId } = await fullSession('closed', 'closed');
    const memberId = await createMember(gymId, centerId, `wm-c-${Date.now()}@test.com`);

    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, class_session_id: sessionId });

    expect(res.status).toBe(409);
  });

  it('rejects an explicit staff waitlist request when the waitlist is not open', async () => {
    const atId = await createActivityType(gymId, 5, `WM explicit ${Date.now()}`, 'disabled');
    const sessionId = await createSession(gymId, atId, centerId);
    const memberId = await createMember(gymId, centerId, `wm-e-${Date.now()}@test.com`);

    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, class_session_id: sessionId, waitlist: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('waitlist_not_open');
  });

  it('lets a per-event waitlist_mode override the activity type default', async () => {
    const { sessionId } = await fullSession('disabled', 'override');
    await db.query(`UPDATE calendar_events SET waitlist_mode = 'open' WHERE id = ?`, [sessionId]);
    const memberId = await createMember(gymId, centerId, `wm-o-${Date.now()}@test.com`);

    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, class_session_id: sessionId });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('waitlisted');
    expect(res.body.waitlist_position).toBe(1);
  });

  it('still books past capacity with force=true while the waitlist is disabled', async () => {
    const { sessionId } = await fullSession('disabled', 'force');
    const memberId = await createMember(gymId, centerId, `wm-f-${Date.now()}@test.com`);

    const res = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, class_session_id: sessionId, force: true });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('booked');
  });

  it('still promotes an existing waitlist entry after the waitlist is closed', async () => {
    const { atId, sessionId } = await fullSession('open', 'promote');
    const waiter = await createMember(gymId, centerId, `wm-p-${Date.now()}@test.com`);
    const joined = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: waiter, class_session_id: sessionId });
    expect(joined.body.status).toBe('waitlisted');

    await db.query(`UPDATE activity_types SET waitlist_mode = 'closed' WHERE id = ?`, [atId]);

    const { rows: bookedRows } = await db.query(
      `SELECT id FROM calendar_event_bookings WHERE calendar_event_id = ? AND status = 'booked' LIMIT 1`,
      [sessionId],
    );
    const cancelRes = await request
      .delete(`/bookings/${bookedRows[0].id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(cancelRes.status).toBe(204);

    const { rows } = await db.query(
      `SELECT status FROM calendar_event_bookings WHERE calendar_event_id = ? AND member_id = ?`,
      [sessionId, waiter],
    );
    expect(rows[0].status).toBe('booked');
  });
});
