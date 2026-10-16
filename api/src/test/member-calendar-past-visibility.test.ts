// #1667: the Members App calendar shows every future event, but a past event
// only to a member who was enrolled in it (whatever attendance / event status).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let memberId: number;
let otherMemberId: number;
const ids: Record<string, number> = {};

async function event(label: string, startOffsetHours: number, status: string, bookingStatus: string | null, bookedBy?: number) {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, title, activity_type_id, starts_at, ends_at, status)
     VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), ?)`,
    [gymId, label, ids.at, startOffsetHours, startOffsetHours + 1, status],
  );
  if (bookingStatus) {
    await db.query(
      `INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status) VALUES (?, ?, ?, ?)`,
      [gymId, insertId, bookedBy ?? memberId, bookingStatus],
    );
  }
  ids[label] = insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('Past Visibility Gym');
  await createTestMembership(gymId, 'member');
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'Me', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, `pv-${Date.now()}@test.com`, TEST_USER_ID],
  );
  memberId = (await db.query<{ id: number }>('SELECT id FROM members WHERE clerk_user_id = ?', [TEST_USER_ID])).rows[0].id;
  otherMemberId = (await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Other', ?)`,
    [gymId, `pv-other-${Date.now()}@test.com`],
  )).insertId;
  // A member of a gym with no center at all is scoped to nothing (empty schedule);
  // the sole-center fallback in centerContext.ts is what makes events visible.
  await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, `Center-${Date.now()}`]);
  ids.at = (await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, ?, 10, 'active')`,
    [gymId, `AT-${Date.now()}`],
  )).insertId;

  await event('future_unenrolled', 24, 'scheduled', null);
  await event('past_enrolled_completed', -48, 'completed', 'booked');
  await event('past_enrolled_cancelled', -47, 'cancelled', 'booked');
  await event('past_unenrolled', -46, 'completed', null);
  await event('past_other_member', -45, 'completed', 'booked', otherMemberId);
  await event('past_waitlisted', -44, 'completed', 'waitlisted');
  await event('past_member_cancelled', -43, 'completed', 'cancelled');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/schedule past visibility (#1667)', () => {
  it('shows all future events and only the past events the member was enrolled in', async () => {
    const from = new Date(Date.now() - 7 * 86400000).toISOString();
    const res = await request
      .get(`/me/schedule?from=${encodeURIComponent(from)}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const got = new Set<number>(res.body.map((s: any) => s.id));
    expect(got.has(ids.future_unenrolled)).toBe(true);
    expect(got.has(ids.past_enrolled_completed)).toBe(true);
    expect(got.has(ids.past_enrolled_cancelled)).toBe(true);
    expect(got.has(ids.past_unenrolled)).toBe(false);
    expect(got.has(ids.past_other_member)).toBe(false);
    expect(got.has(ids.past_waitlisted)).toBe(false);
    expect(got.has(ids.past_member_cancelled)).toBe(false);
  });
});
