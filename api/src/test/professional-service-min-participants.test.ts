// #2293 — Minimum Participants and Unlimited capacity on Professional Services,
// for a gym's own services and Cordel's Base ones, and the completion rule.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let centerId: number;
let activityTypeId: number;

const h = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });
const uname = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

beforeAll(async () => {
  gymId = await createTestGym('PS Min Gym');
  await createTestMembership(gymId, 'admin');
  centerId = (await db.query(`INSERT INTO centers (gym_id, name, status) VALUES (?, 'C', 'active')`, [gymId])).insertId;
  activityTypeId = (await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, ?, 4, 'active')`, [gymId, uname('AT')],
  )).insertId;
  await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role, status, name) VALUES (?, ?, 'trainer_performance', 'active', 'Coach')`,
    [uname('trainer'), gymId],
  );
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('gym-based Professional Service min_participants (#2293)', () => {
  it('stores and reports it; absent keeps; null clears', async () => {
    const created = await request.post('/professional-services').set(h())
      .send({ name: uname('S'), max_capacity: 6, min_participants: 3 });
    expect(created.status).toBe(201);
    expect(created.body.min_participants).toBe(3);
    const id = created.body.id;

    const renamed = await request.put(`/professional-services/${id}`).set(h()).send({ name: uname('S2') });
    expect(renamed.body.min_participants).toBe(3);
    expect(renamed.body.max_capacity).toBe(6);

    const cleared = await request.put(`/professional-services/${id}`).set(h()).send({ min_participants: null });
    expect(cleared.body.min_participants).toBeNull();
  });

  it('rejects non-positive, non-integer and above-capacity values', async () => {
    for (const bad of [0, -1, 1.5, 'abc']) {
      const r = await request.post('/professional-services').set(h()).send({ name: uname('S'), min_participants: bad });
      expect(r.status).toBe(400);
    }
    const over = await request.post('/professional-services').set(h())
      .send({ name: uname('S'), max_capacity: 2, min_participants: 3 });
    expect(over.status).toBe(400);
  });

  it('judges the pair as it will be stored on update, and allows any minimum when unlimited', async () => {
    const { body } = await request.post('/professional-services').set(h())
      .send({ name: uname('S'), max_capacity: 5, min_participants: 4 });
    const lower = await request.put(`/professional-services/${body.id}`).set(h()).send({ max_capacity: 3 });
    expect(lower.status).toBe(400);
    const unlimited = await request.put(`/professional-services/${body.id}`).set(h()).send({ max_capacity: null, min_participants: 50 });
    expect(unlimited.status).toBe(200);
    expect(unlimited.body.max_capacity).toBeNull();
    expect(unlimited.body.min_participants).toBe(50);
  });

  it('existing services without the field stay compatible (null)', async () => {
    const { insertId } = await db.query(
      `INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)`, [gymId, uname('Legacy')],
    );
    await db.query(`INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`, [gymId, insertId]);
    const r = await request.get(`/professional-services/${insertId}`).set(h());
    expect(r.status).toBe(200);
    expect(r.body.min_participants).toBeNull();
  });
});

describe('completing an event below its service minimum (#2293)', () => {
  async function eventWith(serviceId: number, booked: number): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO calendar_events (gym_id, center_id, activity_type_id, professional_service_id,
         trainer_membership_id, title, starts_at, ends_at, status)
       VALUES (?, ?, ?, ?, (SELECT id FROM gym_memberships WHERE gym_id = ? AND role = 'trainer_performance' LIMIT 1),
         'Session', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 HOUR), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR), 'scheduled')`,
      [gymId, centerId, activityTypeId, serviceId, gymId],
    );
    for (let i = 0; i < booked; i++) {
      const m = (await db.query(`INSERT INTO members (gym_id, name, email) VALUES (?, 'M', ?)`, [gymId, `${uname('m')}@test.com`])).insertId;
      await db.query(
        `INSERT INTO calendar_event_bookings (gym_id, center_id, member_id, calendar_event_id, status, attendance_status, booked_at)
         VALUES (?, ?, ?, ?, 'booked', 'present', UTC_TIMESTAMP())`, [gymId, centerId, m, insertId]);
    }
    return insertId;
  }
  async function service(min: number | null) {
    const r = await request.post('/professional-services').set(h()).send({ name: uname('S'), min_participants: min });
    return r.body.id as number;
  }

  it('refuses with 409 below the minimum, allows at it, and is unchanged with no minimum', async () => {
    const below = await eventWith(await service(2), 1);
    const refused = await request.post(`/class-sessions/${below}/complete`).set(h());
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('minimum_participants_not_met');

    const met = await eventWith(await service(2), 2);
    expect((await request.post(`/class-sessions/${met}/complete`).set(h())).status).toBe(200);

    const none = await eventWith(await service(null), 0);
    expect((await request.post(`/class-sessions/${none}/complete`).set(h())).status).toBe(200);
  });
});
