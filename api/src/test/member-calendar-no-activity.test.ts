// #1985 follow-up: an event without an Activity Type is still on the Members App calendar.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let eventId: number;

beforeAll(async () => {
  gymId = await createTestGym('No Activity Gym');
  await createTestMembership(gymId, 'member');
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'Me', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, `na-${Date.now()}@test.com`, TEST_USER_ID],
  );
  await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, `Center-${Date.now()}`]);
  eventId = (await db.query(
    `INSERT INTO calendar_events (gym_id, title, activity_type_id, starts_at, ends_at, status, capacity)
     VALUES (?, 'Open day', NULL, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 25 HOUR), 'scheduled', 10)`,
    [gymId],
  )).insertId;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/schedule without an Activity Type', () => {
  it('lists an event that has no activity_type_id', async () => {
    const res = await request.get('/me/schedule').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const row = res.body.find((s: any) => s.id === eventId);
    expect(row).toBeTruthy();
    expect(row.availability_state).toBe('AVAILABLE');
  });
});
