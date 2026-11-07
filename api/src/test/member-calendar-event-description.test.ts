// #2471: the Members App calendar reports the event's own description, else the Activity Type's.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
const ids: Record<string, number> = {};

async function insertEvent(activityId: number, description: string | null) {
  return (await db.query(
    `INSERT INTO calendar_events (gym_id, title, activity_type_id, starts_at, ends_at, status, capacity, description)
     VALUES (?, 'Ev', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 25 HOUR), 'scheduled', 10, ?)`,
    [gymId, activityId, description],
  )).insertId as number;
}

beforeAll(async () => {
  gymId = await createTestGym('Event Description Gym');
  await createTestMembership(gymId, 'member');
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'Me', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, `ed-${Date.now()}@test.com`, TEST_USER_ID],
  );
  await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, `Center-${Date.now()}`]);
  const withDesc = (await db.query(
    `INSERT INTO activity_types (gym_id, name, description) VALUES (?, 'Yoga', 'Activity text')`, [gymId])).insertId;
  const noDesc = (await db.query(
    `INSERT INTO activity_types (gym_id, name) VALUES (?, 'Pilates')`, [gymId])).insertId;
  ids.own = await insertEvent(withDesc, 'Event text');
  ids.blank = await insertEvent(withDesc, '   ');
  ids.none = await insertEvent(noDesc, null);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/schedule event_description', () => {
  it('prefers the event, falls back to the activity, else empty', async () => {
    const res = await request.get('/me/schedule').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const by = (id: number) => res.body.find((s: any) => s.id === id);
    expect(by(ids.own).event_description).toBe('Event text');
    expect(by(ids.blank).event_description).toBe('Activity text');
    expect(by(ids.none).event_description ?? null).toBeNull();
  });
});
