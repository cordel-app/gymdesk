// #1391 — POST /class-sessions/:id/communications: recipients derived from
// booked bookings on the server, tenant isolation, the role gate, the feature
// flag and the Staff category on the member's read.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { invalidateFeatureFlagsCache } from '../infra/featureFlags';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

const FLAG = 'calendar.staff_communications';
let gymId: string;
let otherGymId: string;
let accountantGymId: string;
let nutritionistGymId: string;
let centerId: number;
let eventId: number;
let bookedMember: number;
let waitlistedMember: number;

const h = (gid: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gid });
const body = { title: 'Room change', message: 'We moved to Studio B.' };

async function rows(memberId: number) {
  const { rows: r } = await db.query(
    `SELECT type, payload FROM member_notifications WHERE gym_id = ? AND member_id = ? AND type = 'staff_message'`,
    [gymId, memberId],
  );
  return r;
}

async function seedEvent(gid: string, cid: number): Promise<number> {
  const { insertId: at } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, ?, 5, 'active')`,
    [gid, `Comm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`],
  );
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, activity_type_id, starts_at, ends_at, status)
     VALUES (?, ?, 'Class', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 6 HOUR), 'scheduled')`,
    [gid, cid, at],
  );
  return insertId;
}

async function seedMember(label: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
    [gymId, label, `${label}-${Date.now()}@test.com`],
  );
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('Comm Gym');
  otherGymId = await createTestGym('Comm Other Gym');
  accountantGymId = await createTestGym('Comm Accountant Gym');
  nutritionistGymId = await createTestGym('Comm Nutritionist Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  await createTestMembership(accountantGymId, 'accountant');
  await createTestMembership(nutritionistGymId, 'nutritionist');

  const mkCenter = async (gid: string) => (await db.query(
    `INSERT INTO centers (gym_id, name, status) VALUES (?, 'C', 'active')`, [gid],
  )).insertId as number;
  centerId = await mkCenter(gymId);
  eventId = await seedEvent(gymId, centerId);

  bookedMember = await seedMember('booked');
  waitlistedMember = await seedMember('waiting');
  await db.query(
    `INSERT INTO calendar_event_bookings (gym_id, center_id, member_id, calendar_event_id, status, attendance_status, booked_at)
     VALUES (?, ?, ?, ?, 'booked', 'pending', UTC_TIMESTAMP()), (?, ?, ?, ?, 'waitlisted', 'pending', UTC_TIMESTAMP())`,
    [gymId, centerId, bookedMember, eventId, gymId, centerId, waitlistedMember, eventId],
  );
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('POST /class-sessions/:id/communications', () => {
  it('401 when unauthenticated', async () => {
    const res = await request.post(`/class-sessions/${eventId}/communications`).set('x-gym-id', gymId).send(body);
    expect(res.status).toBe(401);
  });

  it('403 for a role without calendar-communication access', async () => {
    const res = await request.post(`/class-sessions/${eventId}/communications`).set(h(accountantGymId)).send(body);
    expect(res.status).toBe(403);
  });

  it('404 for another gym\'s event', async () => {
    const res = await request.post(`/class-sessions/${eventId}/communications`).set(h(otherGymId)).send(body);
    expect(res.status).toBe(404);
    expect((await rows(bookedMember)).length).toBe(0);
  });

  it('400 on a blank title or message', async () => {
    for (const b of [{ title: ' ', message: 'x' }, { title: 'x', message: '' }, {}]) {
      const res = await request.post(`/class-sessions/${eventId}/communications`).set(h(gymId)).send(b);
      expect(res.status).toBe(400);
    }
  });

  it('notifies booked members only and reports the count', async () => {
    const res = await request.post(`/class-sessions/${eventId}/communications`).set(h(gymId)).send(body);
    expect(res.status).toBe(200);
    expect(res.body.recipients).toBe(1);
    const got = await rows(bookedMember);
    expect(got.length).toBe(1);
    const payload = typeof got[0].payload === 'string' ? JSON.parse(got[0].payload) : got[0].payload;
    expect(payload.title).toBe('Room change');
    expect(payload.message).toBe('We moved to Studio B.');
    expect((await rows(waitlistedMember)).length).toBe(0);
  });

  it('answers 200 with no recipients for an event nobody booked', async () => {
    const empty = await seedEvent(gymId, centerId);
    const res = await request.post(`/class-sessions/${empty}/communications`).set(h(gymId)).send(body);
    expect(res.status).toBe(200);
    expect(res.body.recipients).toBe(0);
  });

  it('409 for a cancelled event', async () => {
    const ev = await seedEvent(gymId, centerId);
    await db.query(`UPDATE calendar_events SET status = 'cancelled' WHERE id = ?`, [ev]);
    const res = await request.post(`/class-sessions/${ev}/communications`).set(h(gymId)).send(body);
    expect(res.status).toBe(409);
  });

  it('is rejected when the feature flag is off', async () => {
    await db.query(
      `INSERT INTO feature_flags (feature_key, enabled, modified_at) VALUES (?, 0, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE enabled = 0`, [FLAG],
    );
    invalidateFeatureFlagsCache(); // flags are cached for 30 s
    try {
      const res = await request.post(`/class-sessions/${eventId}/communications`).set(h(gymId)).send(body);
      expect(res.status).toBe(403);
    } finally {
      await db.query(`UPDATE feature_flags SET enabled = 1 WHERE feature_key = ?`, [FLAG]);
      invalidateFeatureFlagsCache();
    }
  });
});

describe('nutritionist (read-only Calendar role) may send', () => {
  it('passes the gate and is not 403', async () => {
    const cid = (await db.query(`INSERT INTO centers (gym_id, name, status) VALUES (?, 'N', 'active')`, [nutritionistGymId])).insertId;
    const ev = await seedEvent(nutritionistGymId, cid);
    const res = await request.post(`/class-sessions/${ev}/communications`).set(h(nutritionistGymId)).send(body);
    expect(res.status).toBe(200);
  });
});
