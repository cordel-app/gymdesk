// #614: Calendar is its own permission module (#247). /calendar-events and
// /class-sessions are gated on CALENDAR instead of TRAINING: front desk can create,
// edit and delete events; nutritionist can read but not write; accountant has no
// access. Each role gets its own gym so the caller's single test user id can hold
// a different role per gym.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

type Role = 'front_desk' | 'nutritionist' | 'accountant' | 'trainer_performance';
const gyms = {} as Record<Role, string>;
const activityTypes = {} as Record<Role, number>;
const centers = {} as Record<Role, number>;

const as = (role: Role) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gyms[role] });
const EVENT = { title: 'Perm Test', starts_at: '2026-03-02T10:00:00', ends_at: '2026-03-02T11:00:00' };

beforeAll(async () => {
  for (const role of ['front_desk', 'nutritionist', 'accountant', 'trainer_performance'] as Role[]) {
    gyms[role] = await createTestGym(`Calendar Perm ${role}`);
    await createTestMembership(gyms[role], role);
    const { insertId } = await db.query(
      `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, 'Perm Class', 10, 'active')`,
      [gyms[role]],
    );
    activityTypes[role] = insertId as number;
    const { insertId: centerId } = await db.query(
      `INSERT INTO centers (gym_id, name, status) VALUES (?, 'Perm Center', 'active')`, [gyms[role]],
    );
    centers[role] = centerId as number;
  }
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('Calendar permissions (#614)', () => {
  it('front desk can create, edit and delete a calendar event', async () => {
    const created = await request.post('/calendar-events').set(as('front_desk')).send(EVENT);
    expect(created.status).toBe(201);

    const updated = await request.put(`/calendar-events/${created.body.id}`).set(as('front_desk'))
      .send({ ...EVENT, title: 'Edited by front desk' });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe('Edited by front desk');

    const deleted = await request.delete(`/calendar-events/${created.body.id}`).set(as('front_desk'));
    expect([200, 204]).toContain(deleted.status);
  });

  it('front desk can create and edit a class session', async () => {
    const created = await request.post('/class-sessions').set(as('front_desk')).send({
      activity_type_id: activityTypes.front_desk, center_id: centers.front_desk,
      starts_at: '2026-03-03T09:00:00', ends_at: '2026-03-03T10:00:00',
    });
    expect(created.status).toBe(201);

    const updated = await request.put(`/class-sessions/${created.body.id}`).set(as('front_desk'))
      .send({ starts_at: '2026-03-03T09:30:00', ends_at: '2026-03-03T10:30:00' });
    expect(updated.status).toBe(200);
  });

  it('nutritionist can read the calendar but not write to it', async () => {
    expect((await request.get('/calendar-events?from=2026-01-01T00:00:00&to=2026-12-31T23:59:59').set(as('nutritionist'))).status).toBe(200);
    expect((await request.post('/calendar-events').set(as('nutritionist')).send(EVENT)).status).toBe(403);
    expect((await request.post('/class-sessions').set(as('nutritionist')).send({
      activity_type_id: activityTypes.nutritionist, center_id: centers.nutritionist,
      starts_at: '2026-03-04T09:00:00', ends_at: '2026-03-04T10:00:00',
    })).status).toBe(403);
  });

  it('accountant has no calendar access', async () => {
    expect((await request.get('/calendar-events?from=2026-01-01T00:00:00&to=2026-12-31T23:59:59').set(as('accountant'))).status).toBe(403);
    expect((await request.post('/calendar-events').set(as('accountant')).send(EVENT)).status).toBe(403);
  });

  it('trainers keep full calendar write access', async () => {
    expect((await request.post('/calendar-events').set(as('trainer_performance')).send(EVENT)).status).toBe(201);
  });
});
