// #2686: a Private event is hidden from the Members App and cannot be
// self-booked; a Member staff added to it sees it, and nobody else does.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let memberId: number;
let otherMemberId: number;
const ids: Record<string, number> = {};

async function activity(label: string, publicEvent: boolean, serviceId?: number) {
  ids[label] = (await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status, public_event) VALUES (?, ?, 10, 'active', ?)`,
    [gymId, `${label}-${Date.now()}`, publicEvent ? 1 : 0],
  )).insertId;
  if (serviceId) {
    await db.query(
      'INSERT INTO activity_type_eligible_professional_services (gym_id, activity_type_id, professional_service_id) VALUES (?, ?, ?)',
      [gymId, ids[label], serviceId],
    );
  }
}

async function occurrence(label: string, activityLabel: string | null, extra: { eventType?: string; override?: boolean } = {}) {
  ids[label] = (await db.query(
    `INSERT INTO calendar_events (gym_id, title, activity_type_id, starts_at, ends_at, status, event_type, capacity, eligible_services_override)
     VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 25 HOUR), 'scheduled', ?, ?, ?)`,
    [gymId, label, activityLabel ? ids[activityLabel] : null, extra.eventType ?? null, extra.eventType ? 10 : null, extra.override ? 1 : 0],
  )).insertId;
}

async function asRole(role: string) {
  await db.query('UPDATE gym_memberships SET role = ? WHERE gym_id = ? AND user_id = ?', [role, gymId, TEST_USER_ID]);
}

async function scheduleIds(): Promise<Set<number>> {
  const res = await request
    .get(`/me/schedule?from=${encodeURIComponent(new Date().toISOString())}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);
  expect(res.status).toBe(200);
  return new Set<number>(res.body.map((s: any) => s.id));
}

beforeAll(async () => {
  gymId = await createTestGym('Private Event Visibility Gym');
  await createTestMembership(gymId, 'member');
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'Me', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, `pev-${Date.now()}@test.com`, TEST_USER_ID],
  );
  memberId = (await db.query<{ id: number }>('SELECT id FROM members WHERE clerk_user_id = ?', [TEST_USER_ID])).rows[0].id;
  otherMemberId = (await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Other', ?)`,
    [gymId, `pev-other-${Date.now()}@test.com`],
  )).insertId;
  await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, `Center-${Date.now()}`]);
  const serviceId = (await db.query(
    `INSERT INTO professional_services (gym_id, name, is_system) VALUES (?, ?, 0)`,
    [gymId, `PS-${Date.now()}`],
  )).insertId;

  await activity('at_public', true);
  await activity('at_private', false);
  await activity('at_services', false, serviceId);

  await occurrence('public_session', 'at_public');
  await occurrence('private_session', 'at_private');
  await occurrence('private_session_other', 'at_private');
  await occurrence('services_session', 'at_services');
  await occurrence('private_with_override', 'at_private', { override: true });
  await occurrence('manual_private', null, { eventType: 'private' });
  await occurrence('manual_public', null, { eventType: 'public' });
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('Private events in the Members App (#2686)', () => {
  it('hides Private events by default and keeps the others visible', async () => {
    const got = await scheduleIds();
    expect(got.has(ids.public_session)).toBe(true);
    expect(got.has(ids.services_session)).toBe(true);
    expect(got.has(ids.manual_public)).toBe(true);
    expect(got.has(ids.private_with_override)).toBe(true);
    expect(got.has(ids.private_session)).toBe(false);
    expect(got.has(ids.private_session_other)).toBe(false);
    expect(got.has(ids.manual_private)).toBe(false);
  });

  it('refuses a self-booking of a Private event as if it did not exist', async () => {
    const res = await request
      .post('/me/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ class_session_id: ids.private_session });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('private_event');
    const { rows } = await db.query('SELECT id FROM calendar_event_bookings WHERE calendar_event_id = ?', [ids.private_session]);
    expect(rows).toHaveLength(0);
  });

  it('still lets a member self-book a public event', async () => {
    const res = await request
      .post('/me/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ class_session_id: ids.public_session });
    expect(res.status).toBe(201);
  });

  it('shows a Private event to the member staff added, and to nobody else', async () => {
    await asRole('admin');
    try {
      const res = await request
        .post('/bookings')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ member_id: memberId, class_session_id: ids.private_session });
      expect(res.status).toBe(201);
      const other = await request
        .post('/bookings')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ member_id: otherMemberId, class_session_id: ids.private_session_other });
      expect(other.status).toBe(201);
    } finally {
      await asRole('member');
    }

    const got = await scheduleIds();
    expect(got.has(ids.private_session)).toBe(true);
    // Added by staff to a different member: still hidden from this one.
    expect(got.has(ids.private_session_other)).toBe(false);

    // The event stays Private: adding a member changed no configuration.
    const { rows } = await db.query<{ public_event: number }>('SELECT public_event FROM activity_types WHERE id = ?', [ids.at_private]);
    expect(Number(rows[0].public_event)).toBe(0);
  });
});
