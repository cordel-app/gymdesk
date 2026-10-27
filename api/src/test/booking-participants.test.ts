// #1984 stage 2b — a member books a place for a linked member beside their own.
//
// Pinned here: who counts as linked (a shared active Membership, never a
// stranger), that eligibility is judged per participant, that every participant
// is a booking row of their own counted once toward the service's capacity,
// that a place for the whole group is all-or-nothing, that independent members
// fill the same service, and that the participant — who did not act — is told.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  legacyAssignmentQuery,
  legacyChildQuery,
  request,
} from './helpers';

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockResolvedValue({
          publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
        }),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
    })),
  };
});

let gymId: string;
let centerId: number;
let activityId: number;
let single: number;
let duo: number;
let planId: number;
let john: number;   // owns the Duo plan
let jane: number;   // covered by it
let dana: number;   // covered by it, holds no sessions
let stranger: number;
let alone: number;  // not linked to anyone

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const as = (memberId: number) => ({
  Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId, 'x-impersonate-as': `member:${memberId}`,
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function createService(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)`,
    [gymId, `${name} ${uniq()}`],
  );
  await db.query(
    `INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`,
    [gymId, insertId],
  );
  return insertId;
}

async function createMember(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
    [gymId, name, `${name.toLowerCase()}-${uniq()}@test.com`],
  );
  await db.query(
    `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at) VALUES (?, ?, ?, 1, UTC_TIMESTAMP())`,
    [gymId, insertId, centerId],
  );
  return insertId;
}

async function grantSessions(memberId: number, serviceId: number, sessions = 5): Promise<void> {
  const name = `BP Package ${uniq()}`;
  const { insertId: classPackageId } = await db.query(
    `INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status) VALUES (?, ?, ?, 50, 180, 'active')`,
    [gymId, name, sessions],
  );
  const { insertId: productId } = await db.query(
    `INSERT INTO products (gym_id, name, type, units, amount, currency, billing_frequency, status, availability, is_system, class_package_id)
     VALUES (?, ?, 'sessions', ?, 50.00, 'EUR', NULL, 'active', 'available', 0, ?)`,
    [gymId, name, sessions, classPackageId],
  );
  await db.query(
    `INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)`,
    [gymId, productId, serviceId],
  );
  await db.query(
    `INSERT INTO user_class_packages (gym_id, member_id, class_package_id, purchased_at, expires_at, sessions_remaining, status)
     VALUES (?, ?, ?, UTC_TIMESTAMP(), DATE_ADD(UTC_DATE(), INTERVAL 180 DAY), ?, 'active')`,
    [gymId, memberId, classPackageId, sessions],
  );
}

async function createSession(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, activity_type_id, starts_at, ends_at, capacity, status)
     VALUES (?, ?, 'BP Class', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 72 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 73 HOUR), 10, 'scheduled')`,
    [gymId, centerId, activityId],
  );
  return insertId;
}

const book = (memberId: number, sessionId: number, body: Record<string, unknown> = {}) =>
  request.post('/me/bookings').set(as(memberId)).send({ class_session_id: sessionId, professional_service_id: duo, ...body });
const bookingRow = async (memberId: number, sessionId: number) =>
  (await db.query(
    `SELECT status, professional_service_id, booked_by_member_id FROM calendar_event_bookings
      WHERE member_id = ? AND calendar_event_id = ? AND status <> 'cancelled'`,
    [memberId, sessionId],
  )).rows[0];

beforeAll(async () => {
  gymId = await createTestGym('BP Gym');
  await createTestMembership(gymId, 'admin');
  const { insertId: c } = await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, `BP Center ${uniq()}`]);
  centerId = c;
  single = await createService('Personal Training');
  duo = await createService('Personal Training Duo');
  const { insertId: at } = await db.query(
    `INSERT INTO activity_types (gym_id, name, duration_minutes, max_capacity, status, public_event, waitlist_mode)
     VALUES (?, ?, 60, 10, 'active', 0, 'disabled')`,
    [gymId, `BP Activity ${uniq()}`],
  );
  activityId = at;
  await request.put(`/activity-types/${activityId}/eligible-professional-services`)
    .set({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId })
    .send({ professional_service_ids: [single, duo], capacities: { [single]: 1, [duo]: 2 } });

  john = await createMember('John');
  jane = await createMember('Jane');
  dana = await createMember('Dana');
  stranger = await createMember('Stranger');
  alone = await createMember('Alone');
  for (const m of [john, jane, stranger, alone]) await grantSessions(m, duo);
  await grantSessions(john, single);

  const plan = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, 'Family', 'active', 'public', 'family')`,
    [gymId],
  );
  planId = plan.insertId;
  const um = await legacyAssignmentQuery(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', CURDATE(), 29.99)`,
    [gymId, john, planId],
  );
  await legacyChildQuery(
    'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1), (?, ?, ?, 0), (?, ?, ?, 0)',
    [gymId, um.insertId, john, gymId, um.insertId, jane, gymId, um.insertId, dana],
  );
});

describe('GET /me/bookings/linked-participants', () => {
  it('lists only linked members who could use the service, never strangers', async () => {
    const sessionId = await createSession();
    const res = await request.get(`/me/bookings/linked-participants?calendar_event_id=${sessionId}&professional_service_id=${duo}`).set(as(john));
    expect(res.status).toBe(200);
    // Jane is covered and holds sessions; Dana is covered but holds none; the others are not linked.
    expect(res.body.map((m: any) => m.name)).toEqual(['Jane']);
  });

  it('works from a covered member to the owner and to the other covered members', async () => {
    const sessionId = await createSession();
    const res = await request.get(`/me/bookings/linked-participants?calendar_event_id=${sessionId}&professional_service_id=${duo}`).set(as(jane));
    expect(res.body.map((m: any) => m.name)).toEqual(['John']);
  });

  it('is empty for a member linked to nobody, and requires the event', async () => {
    const sessionId = await createSession();
    const none = await request.get(`/me/bookings/linked-participants?calendar_event_id=${sessionId}`).set(as(alone));
    expect(none.body).toEqual([]);
    const bad = await request.get('/me/bookings/linked-participants').set(as(john));
    expect(bad.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await request.get('/me/bookings/linked-participants?calendar_event_id=1');
    expect(res.status).toBe(401);
  });
});

describe('POST /me/bookings with participants', () => {
  it('books the member and the linked participant, each a row of their own, and tells only the participant', async () => {
    const sessionId = await createSession();
    const res = await book(john, sessionId, { participant_member_ids: [jane] });
    expect(res.status).toBe(201);
    expect(res.body.participants).toHaveLength(1);
    expect(res.body.service).toMatchObject({ id: duo, capacity: 2, occupied: 2, remaining: 0, status: 'full' });

    expect(await bookingRow(john, sessionId)).toMatchObject({ status: 'booked', professional_service_id: duo, booked_by_member_id: null });
    expect(await bookingRow(jane, sessionId)).toMatchObject({ status: 'booked', professional_service_id: duo, booked_by_member_id: john });

    const { rows } = await db.query(
      `SELECT member_id, type FROM member_notifications WHERE entity_id = ? AND type = 'participant_booked'`, [sessionId]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].member_id)).toBe(jane);
  });

  it('leaves the service incomplete without a participant and lets an unrelated member fill it', async () => {
    const sessionId = await createSession();
    const first = await book(john, sessionId);
    expect(first.status).toBe(201);
    expect(first.body.participants).toEqual([]);
    expect(first.body.service).toMatchObject({ occupied: 1, remaining: 1, status: 'incomplete' });

    const second = await book(stranger, sessionId);
    expect(second.status).toBe(201);
    expect(second.body.service).toMatchObject({ occupied: 2, status: 'full' });

    const third = await book(alone, sessionId);
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('service_full');
  });

  it('refuses a participant who is not linked, and books nothing', async () => {
    const sessionId = await createSession();
    const res = await book(john, sessionId, { participant_member_ids: [stranger] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('participant_not_available');
    expect(await bookingRow(john, sessionId)).toBeUndefined();
  });

  it('refuses a linked participant who holds no sessions for the service', async () => {
    const sessionId = await createSession();
    const res = await book(john, sessionId, { participant_member_ids: [dana] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('participant_not_available');
    expect(await bookingRow(john, sessionId)).toBeUndefined();
  });

  it('refuses a participant who is already on the event', async () => {
    const sessionId = await createSession();
    expect((await book(jane, sessionId)).status).toBe(201);
    const res = await book(john, sessionId, { participant_member_ids: [jane] });
    expect(res.status).toBe(400);
    expect(await bookingRow(john, sessionId)).toBeUndefined();
  });

  it('gives the whole group a place or none: a one-place service cannot take a participant', async () => {
    const sessionId = await createSession();
    const res = await book(john, sessionId, { professional_service_id: single, participant_member_ids: [jane] });
    expect(res.status).toBe(400); // jane holds no sessions for the single-place service
    expect(await bookingRow(john, sessionId)).toBeUndefined();

    await grantSessions(jane, single, 1);
    const again = await book(john, sessionId, { professional_service_id: single, participant_member_ids: [jane] });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('service_full');
    expect(await bookingRow(john, sessionId)).toBeUndefined();
    expect(await bookingRow(jane, sessionId)).toBeUndefined();
  });

  it('rejects malformed participant lists and the booker naming themselves', async () => {
    const sessionId = await createSession();
    for (const bad of ['x', [0], [-1], ['a'], [john]]) {
      const res = await book(john, sessionId, { participant_member_ids: bad });
      expect(res.status).toBe(400);
    }
  });

  it('does not let a participant of another gym through', async () => {
    const other = await createTestGym('BP Other Gym');
    const { insertId: foreign } = await db.query(`INSERT INTO members (gym_id, name, email) VALUES (?, 'Foreign', ?)`, [other, `f-${uniq()}@test.com`]);
    const sessionId = await createSession();
    const res = await book(john, sessionId, { participant_member_ids: [foreign] });
    expect(res.status).toBe(400);
    expect(await bookingRow(john, sessionId)).toBeUndefined();
  });
});

describe('GET /me/schedule', () => {
  it('reports each offered service with its places', async () => {
    const sessionId = await createSession();
    await book(john, sessionId);
    const from = new Date(Date.now() + 71 * 3600e3).toISOString();
    const to = new Date(Date.now() + 75 * 3600e3).toISOString();
    const res = await request.get(`/me/schedule?from=${from}&to=${to}`).set(as(john));
    expect(res.status).toBe(200);
    const row = res.body.find((s: any) => s.id === sessionId);
    const svc = row.services.find((s: any) => s.id === duo);
    expect(svc).toMatchObject({ capacity: 2, occupied: 1, status: 'incomplete' });
  });
});
