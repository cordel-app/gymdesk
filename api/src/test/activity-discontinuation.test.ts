// #2324 — deactivating or deleting an Activity discontinues its future events.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

let gymId: string;
let otherGymId: string;
const auth = () => ({ Authorization: TEST_AUTH_HEADER });

async function member(gid: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Disc Member', ?)`,
    [gid, `disc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`],
  );
  return insertId;
}
async function activity(name: string): Promise<number> {
  const res = await request.post('/activity-types').set(auth()).set('x-gym-id', gymId)
    .send({ name, duration_minutes: 60, max_capacity: 10, status: 'active' });
  return res.body.id;
}
async function event(at: number, startsAt: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, title, activity_type_id, capacity, starts_at, ends_at)
     VALUES (?, 'E', ?, 10, ?, DATE_ADD(?, INTERVAL 1 HOUR))`,
    [gymId, at, startsAt, startsAt],
  );
  return insertId;
}
async function book(ev: number, m: number, status: 'booked' | 'waitlisted') {
  await db.query(
    `INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status) VALUES (?, ?, ?, ?)`,
    [gymId, ev, m, status],
  );
}
const alerts = async (m: number) =>
  (await db.query(`SELECT id FROM member_notifications WHERE member_id = ? AND type = 'activity_discontinued'`, [m])).rows;

beforeAll(async () => {
  gymId = await createTestGym('Discontinue Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('Discontinue Other Gym');
});
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('PUT status=inactive (#2324)', () => {
  it('asks for confirmation, then deletes unbooked events, cancels booked ones and alerts each member once', async () => {
    const at = await activity('Disc Yoga');
    const past = await event(at, '2020-01-01 10:00:00');
    const empty = await event(at, '2099-01-01 10:00:00');
    const withWaitOnly = await event(at, '2099-01-02 10:00:00');
    const booked1 = await event(at, '2099-01-03 10:00:00');
    const booked2 = await event(at, '2099-01-04 10:00:00');
    const m1 = await member(gymId); const m2 = await member(gymId);
    await book(booked1, m1, 'booked'); await book(booked2, m1, 'booked');
    await book(booked1, m2, 'waitlisted'); await book(withWaitOnly, m2, 'waitlisted');

    const refused = await request.put(`/activity-types/${at}`).set(auth()).set('x-gym-id', gymId).send({ status: 'inactive' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('activity_discontinue_confirmation_required');
    expect(refused.body.impacted_events).toBe(4);
    expect(refused.body.booked_events).toBe(2);
    expect((await db.query(`SELECT status FROM activity_types WHERE id = ?`, [at])).rows[0].status).toBe('active');

    const ok = await request.put(`/activity-types/${at}`).set(auth()).set('x-gym-id', gymId)
      .send({ status: 'inactive', confirm_discontinue: true });
    expect(ok.status).toBe(200);

    const left = (await db.query(`SELECT id, status FROM calendar_events WHERE activity_type_id = ? ORDER BY id`, [at])).rows;
    expect(left.map((r: any) => r.id)).toEqual([past, booked1, booked2]);
    expect(left.find((r: any) => r.id === booked1).status).toBe('cancelled');
    expect(left.find((r: any) => r.id === past).status).not.toBe('cancelled');
    const b = (await db.query(`SELECT member_id, status FROM calendar_event_bookings WHERE calendar_event_id = ? ORDER BY member_id`, [booked1])).rows;
    expect(b.map((r: any) => r.status)).toEqual(['booked', 'cancelled']);
    expect(await alerts(m1)).toHaveLength(1);
    expect(await alerts(m2)).toHaveLength(1);

    // Re-saving the already inactive activity raises nothing more.
    const again = await request.put(`/activity-types/${at}`).set(auth()).set('x-gym-id', gymId).send({ status: 'inactive' });
    expect(again.status).toBe(200);
    expect(await alerts(m1)).toHaveLength(1);
  });

  it('needs no confirmation when there are no future events', async () => {
    const at = await activity('Disc Empty');
    const res = await request.put(`/activity-types/${at}`).set(auth()).set('x-gym-id', gymId).send({ status: 'inactive' });
    expect(res.status).toBe(200);
  });

  it('does not touch another gym\'s events', async () => {
    const at = await activity('Disc Isolation');
    await event(at, '2099-03-01 10:00:00');
    const { insertId: otherAt } = await db.query(
      `INSERT INTO activity_types (gym_id, name, duration_minutes, max_capacity, status) VALUES (?, 'Other', 60, 5, 'active')`, [otherGymId]);
    const { insertId: otherEv } = await db.query(
      `INSERT INTO calendar_events (gym_id, title, activity_type_id, capacity, starts_at, ends_at)
       VALUES (?, 'O', ?, 5, '2099-03-01 10:00:00', '2099-03-01 11:00:00')`, [otherGymId, otherAt]);
    await request.put(`/activity-types/${at}`).set(auth()).set('x-gym-id', gymId).send({ status: 'inactive', confirm_discontinue: true });
    expect((await db.query(`SELECT id FROM calendar_events WHERE id = ?`, [otherEv])).rows).toHaveLength(1);
  });
});

describe('DELETE /activity-types/:id (#2324)', () => {
  it('requires confirmation, then discontinues and soft-deletes', async () => {
    const at = await activity('Disc Delete');
    const ev = await event(at, '2099-04-01 10:00:00');
    const m = await member(gymId);
    await book(ev, m, 'booked');

    const refused = await request.delete(`/activity-types/${at}`).set(auth()).set('x-gym-id', gymId);
    expect(refused.status).toBe(409);
    const ok = await request.delete(`/activity-types/${at}`).set(auth()).set('x-gym-id', gymId).send({ confirm_discontinue: true });
    expect(ok.status).toBe(204);
    expect((await db.query(`SELECT status FROM calendar_events WHERE id = ?`, [ev])).rows[0].status).toBe('cancelled');
    expect((await db.query(`SELECT deleted_at FROM activity_types WHERE id = ?`, [at])).rows[0].deleted_at).not.toBeNull();
    expect(await alerts(m)).toHaveLength(1);
  });
});
