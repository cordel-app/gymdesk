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
let otherGymId: string;
let fdGymId: string;  // gym where TEST_USER_ID is front_desk
let spaceId: number;
let trainerMembershipId: number;

const BASE = '/calendar-events';
const FROM = '2025-01-01T00:00:00';
const TO   = '2025-12-31T23:59:59';

function headers(gid = gymId) {
  return { Authorization: TEST_AUTH_HEADER, 'x-gym-id': gid };
}

beforeAll(async () => {
  gymId      = await createTestGym('Calendar Test Gym');
  otherGymId = await createTestGym('Calendar Other Gym');
  fdGymId    = await createTestGym('Calendar FD Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(fdGymId, 'front_desk');

  // Space for conflict tests
  const { insertId: sid } = await db.query(
    `INSERT INTO spaces (gym_id, name, capacity, status) VALUES (?, 'Studio A', 20, 'active')`,
    [gymId],
  );
  spaceId = sid;

  // Trainer for conflict tests
  await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role, status, name) VALUES (?, ?, 'trainer_performance', 'active', 'Coach T')`,
    [`trainer-user-${Date.now()}`, gymId],
  );
  const { rows: tm } = await db.query(
    `SELECT id FROM gym_memberships WHERE gym_id = ? AND role = 'trainer_performance' ORDER BY id DESC LIMIT 1`,
    [gymId],
  );
  trainerMembershipId = tm[0].id;

});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ── Auth & Tenant guards ─────────────────────────────────────────────────────

describe('GET /calendar-events — guards', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get(BASE).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in the requested gym', async () => {
    const res = await request.get(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(403);
  });
});

// ── Happy-path GET ────────────────────────────────────────────────────────────

describe('GET /calendar-events', () => {
  it('returns 200 with an empty array initially', async () => {
    const res = await request.get(`${BASE}?from=${FROM}&to=${TO}`).set(headers());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── POST — create event ───────────────────────────────────────────────────────

describe('POST /calendar-events', () => {
  it('returns 403 for front_desk (no write on TRAINING module)', async () => {
    const res = await request.post(BASE)
      .set({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': fdGymId })
      .send({ title: 'FD Test', starts_at: '2025-03-01T10:00:00', ends_at: '2025-03-01T11:00:00' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when title is missing', async () => {
    const res = await request.post(BASE).set(headers())
      .send({ starts_at: '2025-03-01T10:00:00', ends_at: '2025-03-01T11:00:00' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when ends_at <= starts_at', async () => {
    const res = await request.post(BASE).set(headers())
      .send({ title: 'Bad Times', starts_at: '2025-03-01T11:00:00', ends_at: '2025-03-01T10:00:00' });
    expect(res.status).toBe(400);
  });

  it('creates a standalone event (no activity type)', async () => {
    const res = await request.post(BASE).set(headers()).send({
      title: 'Open Day',
      starts_at: '2025-06-01T09:00:00',
      ends_at:   '2025-06-01T17:00:00',
      status: 'scheduled',
    });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Open Day');
    expect(res.body.status).toBe('scheduled');
    expect(res.body.gym_id).toBe(gymId);
  });

  it('creates an event with a space', async () => {
    const res = await request.post(BASE).set(headers()).send({
      title: 'Hyrox',
      space_id: spaceId,
      starts_at: '2025-07-01T08:00:00',
      ends_at:   '2025-07-01T09:00:00',
    });
    expect(res.status).toBe(201);
    expect(res.body.space_id).toBe(spaceId);
    expect(res.body.space_name).toBe('Studio A');
  });
});

// ── Space conflict validation ─────────────────────────────────────────────────

describe('Space conflict validation', () => {
  it('returns 409 when a second event overlaps in the same space', async () => {
    // First event: 10:00–11:00
    await request.post(BASE).set(headers()).send({
      title: 'First', space_id: spaceId,
      starts_at: '2025-08-01T10:00:00', ends_at: '2025-08-01T11:00:00',
    });
    // Second event: 10:30–11:30 (overlaps)
    const res = await request.post(BASE).set(headers()).send({
      title: 'Overlap', space_id: spaceId,
      starts_at: '2025-08-01T10:30:00', ends_at: '2025-08-01T11:30:00',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/space/i);
  });

  it('does NOT conflict with a cancelled event in the same space', async () => {
    // Create and then cancel
    const c1 = await request.post(BASE).set(headers()).send({
      title: 'To Cancel', space_id: spaceId,
      starts_at: '2025-09-01T10:00:00', ends_at: '2025-09-01T11:00:00',
    });
    await request.put(`${BASE}/${c1.body.id}`).set(headers()).send({ status: 'cancelled' });

    // New event in the same slot should succeed
    const res = await request.post(BASE).set(headers()).send({
      title: 'After Cancel', space_id: spaceId,
      starts_at: '2025-09-01T10:00:00', ends_at: '2025-09-01T11:00:00',
    });
    expect(res.status).toBe(201);
  });
});

// ── Trainer conflict validation ───────────────────────────────────────────────

describe('Trainer conflict validation', () => {
  it('returns 409 when a trainer is double-booked', async () => {
    await request.post(BASE).set(headers()).send({
      title: 'Session 1', trainer_membership_id: trainerMembershipId,
      starts_at: '2025-10-01T09:00:00', ends_at: '2025-10-01T10:00:00',
    });
    const res = await request.post(BASE).set(headers()).send({
      title: 'Session 2', trainer_membership_id: trainerMembershipId,
      starts_at: '2025-10-01T09:30:00', ends_at: '2025-10-01T10:30:00',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/trainer/i);
  });
});

// ── PUT ───────────────────────────────────────────────────────────────────────

describe('PUT /calendar-events/:id', () => {
  it('updates an event title and reflects in GET', async () => {
    const created = await request.post(BASE).set(headers()).send({
      title: 'Before',
      starts_at: '2025-04-01T10:00:00',
      ends_at:   '2025-04-01T11:00:00',
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const updated = await request.put(`${BASE}/${id}`).set(headers()).send({ title: 'After' });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe('After');
  });

  it('returns 404 for an event from another gym', async () => {
    await createTestMembership(otherGymId, 'admin', TEST_USER_ID);
    const other = await request.post(BASE).set(headers(otherGymId)).send({
      title: 'Other Gym Event',
      starts_at: '2025-04-02T10:00:00',
      ends_at:   '2025-04-02T11:00:00',
    });
    expect(other.status).toBe(201);

    const res = await request.put(`${BASE}/${other.body.id}`).set(headers(gymId)).send({ title: 'Try' });
    expect(res.status).toBe(404);
  });

  it('returns 409 on drag/drop when the target slot conflicts', async () => {
    // Two events in same space at non-overlapping times
    const a = await request.post(BASE).set(headers()).send({
      title: 'A', space_id: spaceId,
      starts_at: '2025-11-01T09:00:00', ends_at: '2025-11-01T10:00:00',
    });
    await request.post(BASE).set(headers()).send({
      title: 'B', space_id: spaceId,
      starts_at: '2025-11-01T11:00:00', ends_at: '2025-11-01T12:00:00',
    });
    // Move A into B's slot
    const res = await request.put(`${BASE}/${a.body.id}`).set(headers()).send({
      starts_at: '2025-11-01T11:30:00', ends_at: '2025-11-01T12:30:00',
    });
    expect(res.status).toBe(409);
  });
});

// ── DELETE (soft) ─────────────────────────────────────────────────────────────

describe('DELETE /calendar-events/:id', () => {
  it('soft-deletes an event so it no longer appears in the list', async () => {
    const created = await request.post(BASE).set(headers()).send({
      title: 'To Delete',
      starts_at: '2025-05-01T10:00:00',
      ends_at:   '2025-05-01T11:00:00',
    });
    const id = created.body.id;

    const del = await request.delete(`${BASE}/${id}`).set(headers());
    expect(del.status).toBe(204);

    // Confirm it's gone from the list
    const list = await request.get(`${BASE}?from=${FROM}&to=${TO}`).set(headers());
    expect(list.body.find((e: any) => e.id === id)).toBeUndefined();

    // But still exists in the DB with deleted_at set
    const { rows } = await db.query('SELECT deleted_at FROM calendar_events WHERE id = ?', [id]);
    expect(rows[0].deleted_at).not.toBeNull();
  });
});
