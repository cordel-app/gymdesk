// #2500 — the Members App sees each Professional Service an event accepts,
// with its own effective capacity (never the event's total), and never one the
// gym has switched off.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, request, TEST_AUTH_HEADER } from './helpers';

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
let gymId: string;
let memberId: number;
let sessionId: number;
let duo: number;
let single: number;
let off: number;

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const asMember = () => ({ Authorization: TEST_AUTH_HEADER, 'x-impersonate-as': `member:${memberId}`, 'x-gym-id': gymId });

async function service(name: string, status: 'active' | 'inactive' = 'active'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO professional_services (gym_id, name, description, image_url, is_system) VALUES (?, ?, 'About', 'https://img.test/x.webp', 0)`,
    [gymId, `${name} ${uniq()}`],
  );
  await db.query(`INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, ?)`, [gymId, insertId, status]);
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('EventSvc Gym');
  const { insertId: at } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status, public_event) VALUES (?, 'EventSvc Activity', 10, 'active', 1)`,
    [gymId],
  );
  duo = await service('Duo');
  single = await service('Single');
  off = await service('Off', 'inactive');
  for (const [id, cap] of [[duo, 2], [single, 1], [off, 3]] as const) {
    await db.query(
      `INSERT INTO activity_type_eligible_professional_services (gym_id, activity_type_id, professional_service_id, capacity) VALUES (?, ?, ?, ?)`,
      [gymId, at, id, cap],
    );
  }
  const { insertId: m } = await db.query(`INSERT INTO members (gym_id, name, email) VALUES (?, 'EventSvc Member', ?)`, [gymId, `es-${uniq()}@test.com`]);
  memberId = m;
  const { insertId: s } = await db.query(
    `INSERT INTO calendar_events (gym_id, title, activity_type_id, starts_at, ends_at, capacity, status)
     VALUES (?, 'EventSvc', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 72 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 73 HOUR), 10, 'scheduled')`,
    [gymId, at],
  );
  sessionId = s;
  await db.query(
    `INSERT INTO calendar_event_bookings (gym_id, member_id, calendar_event_id, status, booked_at) VALUES (?, ?, ?, 'booked', UTC_TIMESTAMP())`,
    [gymId, memberId, sessionId],
  );
});

describe('professional_services on the member reads (#2500)', () => {
  const check = (list: any[]) => {
    expect(list.map((s) => [s.id, s.capacity]).sort()).toEqual([[duo, 2], [single, 1]].sort());
    expect(list.find((s) => s.id === duo)).toMatchObject({ description: 'About', image_url: 'https://img.test/x.webp' });
  };

  it('GET /me/bookings lists each accepted service with its own capacity, without the switched-off one', async () => {
    const res = await request.get('/me/bookings').set(asMember());
    expect(res.status).toBe(200);
    check(res.body.find((b: any) => b.class_session_id === sessionId).professional_services);
  });

  it('GET /me/schedule reports the same list', async () => {
    const res = await request.get('/me/schedule').set(asMember());
    expect(res.status).toBe(200);
    check(res.body.find((s: any) => s.id === sessionId).professional_services);
  });

  it('is 401 without credentials', async () => {
    expect((await request.get('/me/bookings').set('x-gym-id', gymId)).status).toBe(401);
  });
});
