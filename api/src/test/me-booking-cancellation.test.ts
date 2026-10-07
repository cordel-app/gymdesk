import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  request,
} from './helpers';

// #1162 — the member's own cancellation, enforced server-side (§9) and
// reported by the reads from the one `booked_at`, which both apps show as
// *Booked on* (§6–§8). Each scenario is a session at a chosen distance plus a
// booking of a chosen age, written straight into the tables.

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

async function createSession(gymId: string, activityTypeId: number, startsInMinutes: number, extra: Record<string, number | null> = {}): Promise<number> {
  const cols = ['gym_id', 'center_id', 'title', 'activity_type_id', 'starts_at', 'ends_at', 'status', ...Object.keys(extra)];
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (${cols.join(', ')})
     VALUES (?, NULL, 'Test Session', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE),
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), 'scheduled'${Object.keys(extra).map(() => ', ?').join('')})`,
    [gymId, activityTypeId, startsInMinutes, startsInMinutes + 60, ...Object.values(extra)],
  );
  return insertId;
}

async function createBooking(gymId: string, memberId: number, sessionId: number, bookedMinutesAgo: number | null, status = 'booked'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_event_bookings (gym_id, center_id, member_id, calendar_event_id, status, waitlist_position, booked_at, waitlisted_at)
     VALUES (?, NULL, ?, ?, ?, ?, ${bookedMinutesAgo === null ? 'NULL' : 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)'},
             ${status === 'waitlisted' ? 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 180 MINUTE)' : 'NULL'})`,
    [gymId, memberId, sessionId, status, status === 'waitlisted' ? 1 : null, ...(bookedMinutesAgo === null ? [] : [bookedMinutesAgo])],
  );
  return insertId;
}

// One pool for both describe blocks: closing it in the first block's afterAll
// would leave the second with no connection.
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const asMember = (memberId: number) => ({
  Authorization: TEST_AUTH_HEADER,
  'x-impersonate-as': `member:${memberId}`,
});

describe('DELETE /me/bookings/:id — the 24-hour window and the 2-hour grace period (#1162)', () => {
  let gymId: string;
  let activityTypeId: number;
  let memberId: number;
  let serviceId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Cancellation Grace Gym');
    const { insertId: at } = await db.query(
      `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, 'Grace Class', 10, 'active')`,
      [gymId],
    );
    activityTypeId = at;
    const { insertId: m } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Grace Member', ?)`,
      [gymId, `grace-member-${Date.now()}@test.com`],
    );
    memberId = m;
    const { insertId: ps } = await db.query(
      `INSERT INTO professional_services (gym_id, name, is_system) VALUES (?, 'Personal Training', 0)`,
      [gymId],
    );
    serviceId = ps;
  });

  async function remove(bookingId: number) {
    return request.delete(`/me/bookings/${bookingId}`).set(asMember(memberId)).set('x-gym-id', gymId);
  }

  it('Example 1 — a same-day booking made 30 minutes ago can be cancelled (grace period)', async () => {
    const session = await createSession(gymId, activityTypeId, 60);
    const booking = await createBooking(gymId, memberId, session, 30);
    expect((await remove(booking)).status).toBe(204);
  });

  it('Example 2 — a same-day booking made 2h30 ago cannot (409, with the code and the flag)', async () => {
    const session = await createSession(gymId, activityTypeId, 90);
    const booking = await createBooking(gymId, memberId, session, 150);
    const res = await remove(booking);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('cancellation_window_closed');
    expect(res.body.professional_service).toBe(false);
    expect(res.body.notice_hours).toBe(24);
    expect(res.body.grace_hours).toBe(2);
    // Still booked — nothing was cancelled or promoted.
    const { rows } = await db.query('SELECT status FROM calendar_event_bookings WHERE id = ?', [booking]);
    expect(rows[0].status).toBe('booked');
  });

  it('Example 3 — an event 30 hours away can be cancelled whenever it was booked', async () => {
    const session = await createSession(gymId, activityTypeId, 30 * 60);
    const booking = await createBooking(gymId, memberId, session, 10 * 60);
    expect((await remove(booking)).status).toBe(204);
  });

  it('names the restriction for a booking linked to a Professional Service', async () => {
    const session = await createSession(gymId, activityTypeId, 180, { professional_service_id: serviceId });
    const booking = await createBooking(gymId, memberId, session, 180);
    const res = await remove(booking);
    expect(res.status).toBe(409);
    expect(res.body.professional_service).toBe(true);
  });

  it('lets a waiting-list place be left until the event starts — it is not a booking', async () => {
    const session = await createSession(gymId, activityTypeId, 60);
    const booking = await createBooking(gymId, memberId, session, null, 'waitlisted');
    expect((await remove(booking)).status).toBe(204);
  });

  it('still refuses a booking whose event has started', async () => {
    const session = await createSession(gymId, activityTypeId, -10);
    const booking = await createBooking(gymId, memberId, session, 5);
    const res = await remove(booking);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('already_started');
  });

  it('gives a legacy booking with no booked_at no grace period', async () => {
    const session = await createSession(gymId, activityTypeId, 120);
    const booking = await createBooking(gymId, memberId, session, null);
    expect((await remove(booking)).status).toBe(409);
  });
});

describe('booked_on and the decision on the reads (#1162 §6–§8)', () => {
  let gymId: string;
  let activityTypeId: number;
  let memberId: number;
  let closedSession: number;
  let closedBooking: number;
  let openSession: number;

  beforeAll(async () => {
    gymId = await createTestGym('Cancellation Reads Gym');
    const { insertId: at } = await db.query(
      `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, 'Reads Class', 10, 'active')`,
      [gymId],
    );
    activityTypeId = at;
    const { insertId: m } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Reads Member', ?)`,
      [gymId, `reads-member-${Date.now()}@test.com`],
    );
    memberId = m;
    // The member reads are center-scoped: a member with no center at all sees
    // nothing, so give them one; a NULL-center session stays visible (#478).
    const { insertId: centerId } = await db.query(`INSERT INTO centers (gym_id, name) VALUES (?, 'Reads Center')`, [gymId]);
    await db.query(
      `INSERT INTO member_centers (gym_id, member_id, center_id, is_default) VALUES (?, ?, ?, 1)`,
      [gymId, memberId, centerId],
    );
    closedSession = await createSession(gymId, activityTypeId, 90);
    closedBooking = await createBooking(gymId, memberId, closedSession, 150);
    openSession = await createSession(gymId, activityTypeId, 90);
    await createBooking(gymId, memberId, openSession, 30);
  });

  it('GET /me/schedule reports can_cancel, the block and booked_on from the one booked_at', async () => {
    const to = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const res = await request.get(`/me/schedule?to=${to}`).set(asMember(memberId)).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const closed = res.body.find((s: any) => s.id === closedSession);
    const open = res.body.find((s: any) => s.id === openSession);
    expect(closed.can_cancel).toBe(false);
    expect(closed.cancellation_block).toBe('window_closed');
    expect(closed.professional_service).toBe(false);
    expect(typeof closed.booked_on).toBe('string');
    expect(open.can_cancel).toBe(true);
    expect(open.cancellation_block).toBeNull();
    // The helper numbers never reach the client.
    expect(closed.seconds_until_start).toBeUndefined();
    expect(closed.seconds_since_booked).toBeUndefined();
    const { rows } = await db.query('SELECT booked_at FROM calendar_event_bookings WHERE id = ?', [closedBooking]);
    expect(new Date(closed.booked_on).getTime()).toBe(new Date(rows[0].booked_at).getTime());
  });

  it('GET /me/bookings reports the same three fields', async () => {
    const res = await request.get('/me/bookings').set(asMember(memberId)).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const closed = res.body.find((b: any) => b.id === closedBooking);
    expect(closed.can_cancel).toBe(false);
    expect(closed.cancellation_block).toBe('window_closed');
    expect(typeof closed.booked_on).toBe('string');
    expect(closed.booked_at).toBeUndefined();
    expect(closed.seconds_until_start).toBeUndefined();
  });

  it('the staff GET /bookings reports booked_on for the Admin calendar', async () => {
    const res = await request.get(`/bookings?session_id=${closedSession}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(typeof res.body[0].booked_on).toBe('string');
    expect(res.body[0].booked_on).toBe(new Date(res.body[0].booked_at).toISOString());
  });
});
