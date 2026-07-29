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

// Admin gym — used for all staff-facing routes
let gymId: string;
let centerId: number;
let memberId: number;
let membershipId: number;

// Member gym — TEST_USER_ID has 'member' role here, used for /me routes
let meGymId: string;
let meCenterId: number;

beforeAll(async () => {
  // ----- admin gym setup -----
  gymId = await createTestGym('EventBookings Admin Gym');
  await createTestMembership(gymId, 'admin');

  const { rows: ms } = await db.query<{ id: number }>(
    "SELECT id FROM gym_memberships WHERE gym_id = ? AND user_id = ? AND role = 'admin'",
    [gymId, TEST_USER_ID],
  );
  membershipId = ms[0].id;

  const { insertId: cid } = await db.query(
    'INSERT INTO centers (gym_id, name) VALUES (?, ?)',
    [gymId, 'Main Center'],
  );
  centerId = cid;

  const { insertId: mid } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Alice', 'alice@test.com')`,
    [gymId],
  );
  memberId = mid;

  // ----- member gym setup -----
  // Use a second gym so TEST_USER_ID can have 'member' role without conflicting with admin above.
  meGymId = await createTestGym('EventBookings Member Gym');
  await createTestMembership(meGymId, 'member');

  const { insertId: meCid } = await db.query(
    'INSERT INTO centers (gym_id, name) VALUES (?, ?)',
    [meGymId, 'Member Center'],
  );
  meCenterId = meCid;

  // Need an admin membership id to set created_by on inserts; insert a dummy row with a fake user
  await db.query(
    "INSERT INTO gym_memberships (user_id, gym_id, role, status) VALUES ('setup-user', ?, 'admin', 'active')",
    [meGymId],
  );

  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'MemberAlice', 'malice@test.com', ?)`,
    [meGymId, TEST_USER_ID],
  );
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function createEvent(capacity: number | null = 2, status = 'scheduled'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO events (gym_id, center_id, name, starts_at, ends_at, capacity, status, created_by_membership_id)
     VALUES (?, ?, 'Test Event', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 3 DAY), ?, ?, ?)`,
    [gymId, centerId, capacity, status, membershipId],
  );
  return insertId;
}

async function createMeEvent(capacity: number | null = 5, hoursFromNow = 48): Promise<number> {
  const { rows: ms } = await db.query<{ id: number }>(
    "SELECT id FROM gym_memberships WHERE gym_id = ? AND user_id = 'setup-user'",
    [meGymId],
  );
  const { insertId } = await db.query(
    `INSERT INTO events (gym_id, center_id, name, starts_at, ends_at, capacity, status, created_by_membership_id)
     VALUES (?, ?, 'Me Event', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), ?, 'scheduled', ?)`,
    [meGymId, meCenterId, hoursFromNow, hoursFromNow + 1, capacity, ms[0].id],
  );
  return insertId;
}

// ---------------------------------------------------------------------------
// GET /event-bookings
// ---------------------------------------------------------------------------
describe('GET /event-bookings', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/event-bookings');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a different gym', async () => {
    const otherId = await createTestGym('Other');
    const res = await request.get('/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherId);
    expect(res.status).toBe(403);
  });

  it('returns 200 with empty array when no bookings exist yet', async () => {
    const res = await request.get('/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /event-bookings — book member (staff)
// ---------------------------------------------------------------------------
describe('POST /event-bookings', () => {
  it('books a member when capacity is available', async () => {
    const eventId = await createEvent(5);
    const res = await request.post('/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ event_id: eventId, member_id: memberId });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('booked');
  });

  it('waitlists a member when event is full (capacity = 0)', async () => {
    const eventId = await createEvent(0);
    const res = await request.post('/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ event_id: eventId, member_id: memberId });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('waitlisted');
    expect(res.body.waitlist_position).toBe(1);
  });

  it('books when event has no capacity limit (null)', async () => {
    const eventId = await createEvent(null);
    const res = await request.post('/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ event_id: eventId, member_id: memberId });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('booked');
  });

  it('returns 409 on duplicate active booking', async () => {
    const eventId = await createEvent(10);
    await request.post('/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ event_id: eventId, member_id: memberId });
    const res = await request.post('/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ event_id: eventId, member_id: memberId });
    expect(res.status).toBe(409);
  });

  it('returns 400 for missing member_id', async () => {
    const res = await request.post('/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ event_id: 999 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /event-bookings/:id — cancel and auto-promote
// ---------------------------------------------------------------------------
describe('DELETE /event-bookings/:id — auto-promote', () => {
  it('cancels a booked slot and promotes the first waitlisted member', async () => {
    const eventId = await createEvent(1);

    // Book Alice (fills the 1 slot)
    const book1 = await request.post('/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ event_id: eventId, member_id: memberId });
    expect(book1.body.status).toBe('booked');
    const firstBookingId = book1.body.id;

    // Add Bob and put him on waitlist
    const { insertId: member2Id } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Bob', 'bob-ap@test.com')`,
      [gymId],
    );
    const book2 = await request.post('/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ event_id: eventId, member_id: member2Id });
    expect(book2.body.status).toBe('waitlisted');
    const waitBookingId = book2.body.id;

    // Cancel Alice's booking
    const del = await request.delete(`/event-bookings/${firstBookingId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(del.status).toBe(204);

    // Bob should now be promoted to booked
    const promoted = await request.get(`/event-bookings/${waitBookingId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(promoted.body.status).toBe('booked');
    expect(promoted.body.waitlist_position).toBeNull();
  });

  it('returns 404 for unknown booking', async () => {
    const res = await request.delete('/event-bookings/999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /event-bookings/:id/promote — manual promote
// ---------------------------------------------------------------------------
describe('POST /event-bookings/:id/promote', () => {
  it('promotes a waitlisted booking when capacity allows', async () => {
    const eventId = await createEvent(0);
    const { insertId: m3Id } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Carol', 'carol@test.com')`,
      [gymId],
    );
    const wl = await request.post('/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ event_id: eventId, member_id: m3Id });
    expect(wl.body.status).toBe('waitlisted');

    // Open capacity so promote succeeds
    await db.query('UPDATE events SET capacity = 5 WHERE id = ?', [eventId]);

    const promote = await request.post(`/event-bookings/${wl.body.id}/promote`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(promote.status).toBe(200);
    expect(promote.body.status).toBe('booked');
  });

  it('returns 409 when event is at full capacity', async () => {
    const eventId = await createEvent(1);
    const { insertId: m4Id } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Dave', 'dave@test.com')`,
      [gymId],
    );
    // Fill the 1 slot with Alice
    await request.post('/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ event_id: eventId, member_id: memberId });
    // Force-insert a waitlisted row for Dave
    const { insertId: wlId } = await db.query(
      `INSERT INTO event_bookings (gym_id, center_id, event_id, member_id, status, waitlist_position, waitlisted_at)
       VALUES (?, ?, ?, ?, 'waitlisted', 1, UTC_TIMESTAMP())`,
      [gymId, centerId, eventId, m4Id],
    );

    const promote = await request.post(`/event-bookings/${wlId}/promote`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(promote.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------
describe('Tenant isolation', () => {
  it('cannot read a booking from another gym', async () => {
    const otherGymId = await createTestGym('Isolation Gym');
    await createTestMembership(otherGymId, 'admin');

    // Create a booking in the main gym
    const eventId = await createEvent(5);
    const book = await request.post('/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ event_id: eventId, member_id: memberId });
    const bookingId = book.body.id;

    // Attempt to read it using the other gym's credentials
    const res = await request.get(`/event-bookings/${bookingId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT /events/:id — capacity increase triggers auto-promote
// ---------------------------------------------------------------------------
describe('PUT /events/:id capacity increase auto-promotes', () => {
  it('promotes waitlisted members when capacity increases', async () => {
    const eventId = await createEvent(0);
    const { insertId: m5Id } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Eve', 'eve@test.com')`,
      [gymId],
    );
    const wl = await request.post('/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ event_id: eventId, member_id: m5Id });
    expect(wl.body.status).toBe('waitlisted');

    // Update event capacity from 0 to 5 — Eve should be auto-promoted
    const put = await request.put(`/events/${eventId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ capacity: 5 });
    expect(put.status).toBe(200);

    const promoted = await request.get(`/event-bookings/${wl.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(promoted.body.status).toBe('booked');
  });
});

// ---------------------------------------------------------------------------
// GET /me/events
// ---------------------------------------------------------------------------
describe('GET /me/events', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/me/events').set('x-gym-id', meGymId);
    expect(res.status).toBe(401);
  });

  it('returns upcoming events with booking status', async () => {
    const eventId = await createMeEvent(5);
    // Self-book
    await request.post('/me/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', meGymId)
      .send({ event_id: eventId });

    const res = await request.get('/me/events')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', meGymId);
    expect(res.status).toBe(200);
    const ev = res.body.find((e: any) => e.id === eventId);
    expect(ev).toBeDefined();
    expect(ev.my_booking_status).toBe('booked');
  });
});

// ---------------------------------------------------------------------------
// POST /me/event-bookings — member self-book
// ---------------------------------------------------------------------------
describe('POST /me/event-bookings', () => {
  it('books the authenticated member on the event', async () => {
    const eventId = await createMeEvent(10);
    const res = await request.post('/me/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', meGymId)
      .send({ event_id: eventId });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('booked');
  });

  it('returns 409 on duplicate booking', async () => {
    const eventId = await createMeEvent(10);
    await request.post('/me/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', meGymId)
      .send({ event_id: eventId });
    const res = await request.post('/me/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', meGymId)
      .send({ event_id: eventId });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// DELETE /me/event-bookings/:id — cancellation policy
// ---------------------------------------------------------------------------
describe('DELETE /me/event-bookings/:id', () => {
  it('allows cancellation within 4 hours of booking (event is 48h away)', async () => {
    const eventId = await createMeEvent(10, 48);
    const book = await request.post('/me/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', meGymId)
      .send({ event_id: eventId });
    const bookingId = book.body.id;

    // booked_at is right now → inside the 4h window
    const res = await request.delete(`/me/event-bookings/${bookingId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', meGymId);
    expect(res.status).toBe(204);
  });

  it('blocks cancellation when outside 24h window AND outside 4h booking window', async () => {
    const eventId = await createMeEvent(10, 48);
    const book = await request.post('/me/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', meGymId)
      .send({ event_id: eventId });
    const bookingId = book.body.id;

    // Simulate booking made 5h ago
    await db.query(
      'UPDATE event_bookings SET booked_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 HOUR) WHERE id = ?',
      [bookingId],
    );
    // Move event to 20h from now (inside 24h window)
    await db.query(
      'UPDATE events SET starts_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 20 HOUR) WHERE id = ?',
      [eventId],
    );

    const res = await request.delete(`/me/event-bookings/${bookingId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', meGymId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Cancellation is no longer available/);
  });

  it('allows cancellation when event is more than 24h away (booking age > 4h)', async () => {
    const eventId = await createMeEvent(10, 48);
    const book = await request.post('/me/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', meGymId)
      .send({ event_id: eventId });
    const bookingId = book.body.id;

    // Make booking old but event stays far in the future
    await db.query(
      'UPDATE event_bookings SET booked_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 HOUR) WHERE id = ?',
      [bookingId],
    );

    const res = await request.delete(`/me/event-bookings/${bookingId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', meGymId);
    expect(res.status).toBe(204);
  });

  it('waitlisted members can always cancel', async () => {
    const eventId = await createMeEvent(0, 1); // 0 capacity → always waitlisted; starts in 1h
    const book = await request.post('/me/event-bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', meGymId)
      .send({ event_id: eventId });
    expect(book.body.status).toBe('waitlisted');

    const res = await request.delete(`/me/event-bookings/${book.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', meGymId);
    expect(res.status).toBe(204);
  });

  it('returns 404 when booking belongs to another member', async () => {
    const eventId = await createMeEvent(10);
    // Insert a booking directly for a different member (not meMemberId)
    const { rows: ms } = await db.query<{ id: number }>(
      "SELECT id FROM gym_memberships WHERE gym_id = ? AND user_id = 'setup-user'",
      [meGymId],
    );
    const { insertId: otherMId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Other', 'other99@test.com')`,
      [meGymId],
    );
    const { insertId: otherBookingId } = await db.query(
      `INSERT INTO event_bookings (gym_id, center_id, event_id, member_id, status, booked_at)
       VALUES (?, ?, ?, ?, 'booked', UTC_TIMESTAMP())`,
      [meGymId, meCenterId, eventId, otherMId],
    );

    const res = await request.delete(`/me/event-bookings/${otherBookingId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', meGymId);
    expect(res.status).toBe(404);
  });
});
