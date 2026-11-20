// #3085 — "Apply to future events": PUT /activity-types/:id with apply_to_future_events

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

let gymId: string;
let activityId: number;
let serviceId: number;
let divergedId: number;
let bookedDivergedId: number;
let pastId: number;
let memberId: number;

const put = (body: Record<string, unknown>) => request
  .put(`/activity-types/${activityId}`)
  .set('Authorization', TEST_AUTH_HEADER)
  .set('x-gym-id', gymId)
  .send({ name: 'Apply Activity', ...body });

async function event(start: string, extra = '') {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, title, activity_type_id, color, capacity, starts_at, ends_at${extra ? ', ' + extra.split('=')[0] : ''})
     VALUES (?, 'Apply Activity', ?, '#00ff00', 3, ?, DATE_ADD(?, INTERVAL 1 HOUR)${extra ? ', ' + extra.split('=')[1] : ''})`,
    [gymId, activityId, start, start],
  );
  return insertId as number;
}

beforeAll(async () => {
  gymId = await createTestGym('Apply Future Gym');
  await createTestMembership(gymId, 'admin');
  const res = await request.post('/activity-types').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
    .send({ name: 'Apply Activity', duration_minutes: 60, max_capacity: 12, status: 'active', color: '#ff0000' });
  activityId = res.body.id;
  const { insertId } = await db.query(
    `INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, 'Apply PT', 0, NULL)`, [gymId]);
  serviceId = insertId;
  await db.query(
    `INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`, [gymId, serviceId]);
  const m = await db.query(`INSERT INTO members (gym_id, name, email) VALUES (?, 'Apply M', ?)`, [gymId, `apply-${Date.now()}@test.com`]);
  memberId = m.insertId;
  pastId = await event('2020-01-01 10:00:00');
  divergedId = await event('2099-03-01 10:00:00', "image_url='https://x.test/a.webp'");
  bookedDivergedId = await event('2099-03-02 10:00:00');
  await db.query(
    `INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status) VALUES (?, ?, ?, 'booked')`,
    [gymId, bookedDivergedId, memberId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('apply_to_future_events', () => {
  it('asks for confirmation when a Professional Service change would cancel bookings, and changes nothing', async () => {
    const res = await put({ professional_service_id: serviceId, apply_to_future_events: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('booking_cancellation_required');
    expect(res.body.impacted_events).toBe(1);
    expect(res.body.cancelled_bookings).toBe(1);
    const { rows } = await db.query('SELECT professional_service_id FROM activity_types WHERE id = ?', [activityId]);
    expect(rows[0].professional_service_id).toBeNull();
    const { rows: b } = await db.query('SELECT status FROM calendar_event_bookings WHERE calendar_event_id = ?', [bookedDivergedId]);
    expect(b[0].status).toBe('booked');
  });

  it('applies the whole configuration to future events, clears overrides, cancels bookings, leaves past events', async () => {
    const res = await put({ professional_service_id: serviceId, apply_to_future_events: true, confirm_cancel_bookings: true });
    expect(res.status).toBe(200);
    const { rows } = await db.query(
      'SELECT id, color, capacity, professional_service_id, image_url FROM calendar_events WHERE id IN (?, ?, ?)',
      [pastId, divergedId, bookedDivergedId],
    );
    const by = Object.fromEntries(rows.map((r: any) => [r.id, r]));
    expect(by[divergedId].color).toBe('#ff0000');
    expect(Number(by[divergedId].capacity)).toBe(12);
    expect(by[divergedId].professional_service_id).toBe(serviceId);
    expect(by[divergedId].image_url).toBeNull();
    expect(by[bookedDivergedId].professional_service_id).toBe(serviceId);
    expect(by[pastId].color).toBe('#00ff00');
    expect(Number(by[pastId].capacity)).toBe(3);
    const { rows: b } = await db.query('SELECT status FROM calendar_event_bookings WHERE calendar_event_id = ?', [bookedDivergedId]);
    expect(b[0].status).toBe('cancelled');
  });

  it('a normal save does not touch diverged events', async () => {
    await db.query("UPDATE calendar_events SET color = '#123456' WHERE id = ?", [divergedId]);
    const res = await put({ description: 'edited' });
    expect(res.status).toBe(200);
    const { rows } = await db.query('SELECT color FROM calendar_events WHERE id = ?', [divergedId]);
    expect(rows[0].color).toBe('#123456');
  });

  it('is admin only and tenant scoped', async () => {
    const res = await request.put(`/activity-types/${activityId}`).set('x-gym-id', gymId)
      .send({ apply_to_future_events: true });
    expect(res.status).toBe(401);
  });
});
