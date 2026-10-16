// #1666 — an event that has already ended is only re-statused to Cancelled:
// no reason is required and no member is notified. Future events keep the
// existing workflow. The rule is the event's end time, not its start.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let centerId: number;
let activityTypeId: number;
let memberId: number;

const headers = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });

async function session(startsHours: number, endsHours: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, activity_type_id, starts_at, ends_at, status)
     VALUES (?, ?, 'Past cancel', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR),
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), 'scheduled')`,
    [gymId, centerId, activityTypeId, startsHours, endsHours],
  );
  await db.query(
    `INSERT INTO calendar_event_bookings (gym_id, center_id, member_id, calendar_event_id, status, attendance_status, booked_at)
     VALUES (?, ?, ?, ?, 'booked', 'present', UTC_TIMESTAMP())`,
    [gymId, centerId, memberId, insertId],
  );
  return insertId;
}

async function alerts(eventId: number) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS cnt FROM member_notifications WHERE gym_id = ? AND entity_id = ? AND type = 'event_cancelled'`,
    [gymId, eventId],
  );
  return Number(rows[0].cnt);
}

beforeAll(async () => {
  gymId = await createTestGym('Past Cancel Gym');
  await createTestMembership(gymId, 'admin');
  centerId = (await db.query(`INSERT INTO centers (gym_id, name, status) VALUES (?, 'PC Center', 'active')`, [gymId])).insertId;
  activityTypeId = (await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, ?, 4, 'active')`,
    [gymId, `PastCancel-${Date.now()}`],
  )).insertId;
  memberId = (await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'PC Member', ?)`,
    [gymId, `pc-${Date.now()}@test.com`],
  )).insertId;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('POST /class-sessions/:id/cancel — past events (#1666)', () => {
  it('marks an ended event Cancelled without a reason and without notifying members', async () => {
    const id = await session(-3, -2);
    const res = await request.post(`/class-sessions/${id}/cancel`).set(headers()).send({});
    expect(res.status).toBe(204);
    const { rows } = await db.query(`SELECT status, cancellation_reason FROM calendar_events WHERE id = ?`, [id]);
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].cancellation_reason).toBeNull();
    expect(await alerts(id)).toBe(0);
    const { rows: b } = await db.query(
      `SELECT status, attendance_status FROM calendar_event_bookings WHERE calendar_event_id = ?`, [id]);
    expect(b[0]).toMatchObject({ status: 'booked', attendance_status: 'present' });
  });

  it('keeps the reason required and notifies for a future event', async () => {
    const id = await session(2, 3);
    const noReason = await request.post(`/class-sessions/${id}/cancel`).set(headers()).send({});
    expect(noReason.status).toBe(400);
    const ok = await request.post(`/class-sessions/${id}/cancel`).set(headers()).send({ cancellation_reason: 'Ill' });
    expect(ok.status).toBe(204);
    expect(await alerts(id)).toBe(1);
  });

  it('treats an event in progress as not past (start passed, end not)', async () => {
    const id = await session(-1, 1);
    const res = await request.post(`/class-sessions/${id}/cancel`).set(headers()).send({});
    expect(res.status).toBe(400);
  });
});
