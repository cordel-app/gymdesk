// #1698 — a 2-hour training reminder is shown only while its session is
// upcoming or in progress (GET /me/notifications and /count).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
let memberId: number;
let centerId: number;

async function event(startMin: number, endMin: number, status = 'scheduled'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, starts_at, ends_at, status)
     VALUES (?, ?, 'Spin', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE),
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?)`,
    [gymId, centerId, startMin, endMin, status],
  );
  return insertId;
}

async function reminder(eventId: number, type = 'booking_reminder_2h'): Promise<void> {
  await db.query(
    `INSERT INTO member_notifications (gym_id, member_id, type, entity_type, entity_id, payload)
     VALUES (?, ?, ?, 'session', ?, '{"title":"Spin"}')`,
    [gymId, memberId, type, eventId],
  );
}

async function visibleEntityIds(): Promise<number[]> {
  const res = await request.get('/me/notifications')
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
  expect(res.status).toBe(200);
  return res.body.items.map((i: any) => i.entity_id);
}

beforeAll(async () => {
  gymId = await createTestGym('Reminder Expiry Gym');
  await createTestMembership(gymId, 'member');
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'Expiry Member', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, `reminder-expiry-${Date.now()}@test.com`, TEST_USER_ID],
  );
  const { rows } = await db.query<{ id: number }>('SELECT id FROM members WHERE clerk_user_id = ?', [TEST_USER_ID]);
  memberId = rows[0].id;
  const { insertId } = await db.query(
    `INSERT INTO centers (gym_id, name, status) VALUES (?, 'Expiry Center', 'active')`, [gymId]);
  centerId = insertId;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('training reminder expiry (#1698)', () => {
  it('hides a reminder once its session has ended, keeps upcoming and in-progress ones', async () => {
    const upcoming = await event(60, 120);
    const inProgress = await event(-30, 30);
    const ended = await event(-120, -1);
    for (const id of [upcoming, inProgress, ended]) await reminder(id);

    const ids = await visibleEntityIds();
    expect(ids).toContain(upcoming);
    expect(ids).toContain(inProgress);
    expect(ids).not.toContain(ended);
  });

  it('hides the reminder of a cancelled session and follows a rescheduled one', async () => {
    const cancelled = await event(60, 120, 'cancelled');
    const moved = await event(-120, -60);
    await reminder(cancelled);
    await reminder(moved);
    expect(await visibleEntityIds()).not.toContain(moved);

    await db.query(
      `UPDATE calendar_events SET starts_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 60 MINUTE),
              ends_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 120 MINUTE) WHERE id = ?`, [moved]);
    const ids = await visibleEntityIds();
    expect(ids).toContain(moved);
    expect(ids).not.toContain(cancelled);
  });

  it('leaves other alert types alone and excludes expired reminders from the unread count', async () => {
    const ended = await event(-300, -240);
    await reminder(ended, 'booking_confirmed');
    expect(await visibleEntityIds()).toContain(ended);

    const before = await request.get('/me/notifications/count')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const list = await request.get('/me/notifications')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(before.body.unread).toBe(list.body.unread);
    expect(list.body.items.filter((i: any) => i.read_at === null).length).toBe(before.body.unread);
  });
});
