// #1984 stage 2b-4 — the waiting list is per Professional Service: a waitlisted
// row keeps the service the member asked for, and a freed place is offered to
// the first entry that can use it. A full service's queue is skipped, not emptied.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

let gymId: string;
let centerId: number;
let activityId: number;
let svcA: number;
let svcB: number;

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const headers = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function createService(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO professional_services (gym_id, name, is_system, system_key, max_capacity) VALUES (?, ?, 0, NULL, 1)`,
    [gymId, `${name} ${uniq()}`],
  );
  await db.query(
    `INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`,
    [gymId, insertId],
  );
  return insertId;
}
async function createMember(): Promise<number> {
  const { insertId } = await db.query(`INSERT INTO members (gym_id, name, email) VALUES (?, 'WL Member', ?)`, [gymId, `wl-${uniq()}@test.com`]);
  await db.query(
    `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at) VALUES (?, ?, ?, 1, UTC_TIMESTAMP())`,
    [gymId, insertId, centerId],
  );
  return insertId;
}
async function createSession(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, activity_type_id, starts_at, ends_at, capacity, status)
     VALUES (?, ?, 'WL Class', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 48 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 49 HOUR), 10, 'scheduled')`,
    [gymId, centerId, activityId],
  );
  return insertId;
}
const book = (memberId: number, sessionId: number, serviceId: number, waitlist = false) =>
  request.post('/bookings').set(headers()).send({
    member_id: memberId, class_session_id: sessionId, professional_service_id: serviceId, override_eligibility: true, waitlist,
  });
const status = async (id: number) =>
  (await db.query('SELECT status, professional_service_id FROM calendar_event_bookings WHERE id = ?', [id])).rows[0];

beforeAll(async () => {
  gymId = await createTestGym('SvcWL Gym');
  await createTestMembership(gymId, 'admin');
  centerId = (await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, `C-${uniq()}`])).insertId;
  activityId = (await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status, waitlist_mode, public_event) VALUES (?, 'WL Activity', 10, 'active', 'open', 0)`,
    [gymId],
  )).insertId;
  svcA = await createService('A');
  svcB = await createService('B');
  const res = await request.put(`/activity-types/${activityId}/eligible-professional-services`).set(headers())
    .send({ professional_service_ids: [svcA, svcB] });
  expect(res.status).toBe(204);
});

describe('waiting list per Professional Service', () => {
  it('keeps the chosen service on the waitlist row and promotes only an entry whose service has room', async () => {
    const s = await createSession();
    const [a1, a2, b1, b2] = [await createMember(), await createMember(), await createMember(), await createMember()];
    const bookedA = await book(a1, s, svcA);
    const bookedB = await book(b1, s, svcB);
    expect(bookedA.body.status).toBe('booked');
    expect(bookedB.body.status).toBe('booked');
    const waitA = await book(a2, s, svcA, true);
    const waitB = await book(b2, s, svcB, true);
    expect(waitA.body.status).toBe('waitlisted');
    expect((await status(waitA.body.id)).professional_service_id).toBe(svcA);
    expect((await status(waitB.body.id)).professional_service_id).toBe(svcB);

    // The first in the queue asked for A, but B's place is the one that frees up.
    const cancel = await request.delete(`/bookings/${bookedB.body.id}`).set(headers());
    expect(cancel.status).toBeLessThan(300);
    expect((await status(waitA.body.id)).status).toBe('waitlisted');
    expect((await status(waitB.body.id)).status).toBe('booked');
  });
});
