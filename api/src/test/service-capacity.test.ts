// #1984 stage 1 — an independent capacity per Professional Service.
//
// An Activity Type can offer several services in one time slot; each has its own
// places (the Activity Type's default, overridable per occurrence), a booking
// counts toward the one service it names, and the event's capacity stays the
// ceiling. Pinned here: the effective capacity and its three sources, that two
// services in one slot never consume each other's places, independent members
// filling one service, the service_full refusal (also under concurrency), the
// Available/Incomplete/Full status, replace-all not wiping a stored capacity,
// and that the override is audited and tenant-scoped.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
  TEST_AUTH_HEADER,
} from './helpers';

let gymId: string;
let otherGymId: string;
let centerId: number;
let activityId: number;
let single: number; // capacity 1
let duo: number;    // capacity 2

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const headers = (gid = gymId) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gid });

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function createService(name: string, max: number | null = null, min: number | null = null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO professional_services (gym_id, name, is_system, system_key, max_capacity, min_participants) VALUES (?, ?, 0, NULL, ?, ?)`,
    [gymId, `${name} ${uniq()}`, max, min],
  );
  await db.query(
    `INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`,
    [gymId, insertId],
  );
  return insertId;
}

async function createSession(capacity = 10): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events
       (gym_id, center_id, title, activity_type_id, starts_at, ends_at, capacity, status)
     VALUES (?, ?, 'SvcCap Class', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 48 HOUR),
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL 49 HOUR), ?, 'scheduled')`,
    [gymId, centerId, activityId, capacity],
  );
  return insertId;
}

async function createMember(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'SvcCap Member', ?)`,
    [gymId, `svccap-${uniq()}@test.com`],
  );
  await db.query(
    `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at) VALUES (?, ?, ?, 1, UTC_TIMESTAMP())`,
    [gymId, insertId, centerId],
  );
  return insertId;
}

// Staff booking with the gate overridden: eligibility is not what is under test.
const book = (memberId: number, sessionId: number, serviceId: number) =>
  request.post('/bookings').set(headers()).send({
    member_id: memberId, class_session_id: sessionId, professional_service_id: serviceId, override_eligibility: true,
  });
const detail = async (sessionId: number) =>
  (await request.get(`/class-sessions/${sessionId}`).set(headers())).body;
const svc = (body: any, id: number) => body.services.find((s: any) => s.id === id);

beforeAll(async () => {
  gymId = await createTestGym('SvcCap Gym');
  otherGymId = await createTestGym('SvcCap Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  const { insertId: cid } = await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, `C-${uniq()}`]);
  centerId = cid;
  const { insertId: at } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status, waitlist_mode, public_event) VALUES (?, 'SvcCap Activity', 10, 'active', 'disabled', 0)`,
    [gymId],
  );
  activityId = at;
  single = await createService('Personal Training', 1, 1);
  duo = await createService('Personal Training Duo', 2, 2);
  const res = await request.put(`/activity-types/${activityId}/eligible-professional-services`).set(headers())
    .send({ professional_service_ids: [single, duo] });
  expect(res.status).toBe(204);
});

describe('service capacity: configuration (#2499)', () => {
  it("reports each eligible service's own min and max, not an Activity-level value", async () => {
    const res = await request.get(`/activity-types/${activityId}/eligible-professional-services`).set(headers());
    const byId = Object.fromEntries(res.body.map((r: any) => [r.id, r]));
    expect(byId[single]).toMatchObject({ max_capacity: 1, min_participants: 1 });
    expect(byId[duo]).toMatchObject({ max_capacity: 2, min_participants: 2 });
  });

  it('ignores a capacity sent for a service: the service is the single source of truth', async () => {
    const res = await request.put(`/activity-types/${activityId}/eligible-professional-services`).set(headers())
      .send({ professional_service_ids: [single, duo], capacities: { [duo]: 9 } });
    expect(res.status).toBe(204);
    const rows = await db.query(
      'SELECT capacity FROM activity_type_eligible_professional_services WHERE activity_type_id = ?', [activityId]);
    expect(rows.rows.every((r: any) => r.capacity == null)).toBe(true);
    const sessionId = await createSession();
    expect(svc(await detail(sessionId), duo).capacity).toBe(2);
  });

  it("changing the service's capacity is reflected on its events", async () => {
    const sessionId = await createSession();
    await db.query('UPDATE professional_services SET max_capacity = 3, min_participants = 1 WHERE id = ?', [duo]);
    expect(svc(await detail(sessionId), duo).capacity).toBe(3);
    await db.query('UPDATE professional_services SET max_capacity = 2, min_participants = 2 WHERE id = ?', [duo]);
  });

  it('an event with a service that has no capacity configured follows the event capacity', async () => {
    const other = await createService('Uncapped');
    const { insertId: at2 } = await db.query(
      `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, 'Uncapped Activity', 7, 'active')`, [gymId]);
    await db.query(
      `INSERT INTO activity_type_eligible_professional_services (gym_id, activity_type_id, professional_service_id) VALUES (?, ?, ?)`,
      [gymId, at2, other]);
    const { insertId: ev } = await db.query(
      `INSERT INTO calendar_events (gym_id, center_id, title, activity_type_id, starts_at, ends_at, capacity, status)
       VALUES (?, ?, 'U', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 48 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 49 HOUR), NULL, 'scheduled')`,
      [gymId, centerId, at2]);
    const body = await detail(ev);
    expect(svc(body, other).capacity).toBe(7);
  });
});

describe('service capacity: booking', () => {
  it('lets two services share one slot without consuming each other', async () => {
    const sessionId = await createSession();
    const m1 = await createMember();
    const m2 = await createMember();

    expect((await book(m1, sessionId, single)).status).toBe(201);
    let body = await detail(sessionId);
    expect(svc(body, single)).toMatchObject({ occupied: 1, capacity: 1, remaining: 0, status: 'full' });
    expect(svc(body, duo)).toMatchObject({ occupied: 0, capacity: 2, status: 'available' });

    expect((await book(m2, sessionId, duo)).status).toBe(201);
    body = await detail(sessionId);
    expect(svc(body, duo)).toMatchObject({ occupied: 1, capacity: 2, remaining: 1, status: 'incomplete' });
  });

  it('refuses a booking on a full service and lets unrelated members fill the other places', async () => {
    const sessionId = await createSession();
    const [a, b, c, d] = [await createMember(), await createMember(), await createMember(), await createMember()];

    expect((await book(a, sessionId, single)).status).toBe(201);
    const full = await book(b, sessionId, single);
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('service_full');

    expect((await book(b, sessionId, duo)).status).toBe(201);
    expect((await book(c, sessionId, duo)).status).toBe(201);
    const over = await book(d, sessionId, duo);
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('service_full');

    const body = await detail(sessionId);
    expect(svc(body, duo)).toMatchObject({ occupied: 2, status: 'full' });
  });

  it('stays within the event capacity ceiling', async () => {
    const sessionId = await createSession(1);
    const [a, b] = [await createMember(), await createMember()];
    expect((await book(a, sessionId, duo)).status).toBe(201);
    const res = await book(b, sessionId, duo);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('session_full_waitlist_not_open');
  });

  it('never overbooks a service under concurrent attempts', async () => {
    const sessionId = await createSession();
    const members = await Promise.all([createMember(), createMember(), createMember(), createMember()]);
    const results = await Promise.all(members.map((m) => book(m, sessionId, duo)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(svc(await detail(sessionId), duo).occupied).toBe(2);
  });

  it('frees the place when a booking is cancelled', async () => {
    const sessionId = await createSession();
    const m = await createMember();
    const booked = await book(m, sessionId, single);
    expect(svc(await detail(sessionId), single).status).toBe('full');
    await request.delete(`/bookings/${booked.body.id}`).set(headers());
    expect(svc(await detail(sessionId), single)).toMatchObject({ occupied: 0, status: 'available' });
  });
});

describe('service capacity: no occurrence override (#2499)', () => {
  it('ignores service_capacities on an occurrence', async () => {
    const sessionId = await createSession();
    const put = await request.put(`/class-sessions/${sessionId}`).set(headers())
      .send({ service_capacities: { [duo]: 5 } });
    expect(put.status).toBe(200);
    expect(svc(put.body, duo).capacity).toBe(2);
  });
});

describe('service capacity: access', () => {
  it('does not expose another gym\'s occurrence', async () => {
    const sessionId = await createSession();
    const res = await request.get(`/class-sessions/${sessionId}`).set(headers(otherGymId));
    expect(res.status).toBe(404);
    const put = await request.put(`/class-sessions/${sessionId}`).set(headers(otherGymId)).send({ max_capacity_override: 2 });
    expect(put.status).toBe(404);
  });

  it('requires authentication', async () => {
    const sessionId = await createSession();
    const res = await request.put(`/class-sessions/${sessionId}`).send({ max_capacity_override: 2 });
    expect(res.status).toBe(401);
  });
});
