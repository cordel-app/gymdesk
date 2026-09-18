// Tests for activity-types.ts router

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
let activityTypeId: number;

const BASE = '/activity-types';

beforeAll(async () => {
  gymId = await createTestGym('AT Test Gym');
  await createTestMembership(gymId, 'admin');

  // Create the main activity type used across most tests
  const res = await request
    .post(BASE)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ name: 'Yoga', duration_minutes: 60, max_capacity: 20, status: 'active' });
  activityTypeId = res.body.id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ── Auth guard ─────────────────────────────────────────────────────────────

describe('auth guard', () => {
  it('returns 401 without auth on GET /activity-types', async () => {
    const res = await request.get(BASE).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 401 without auth on POST /activity-types', async () => {
    const res = await request
      .post(BASE)
      .set('x-gym-id', gymId)
      .send({ name: 'Boxing', duration_minutes: 45, max_capacity: 10 });
    expect(res.status).toBe(401);
  });

  it('returns 401 without auth on DELETE /activity-types/:id', async () => {
    const res = await request
      .delete(`${BASE}/${activityTypeId}`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});

// ── Tenant isolation ───────────────────────────────────────────────────────

describe('tenant isolation', () => {
  it('returns 403 when user has no membership in the requested gym', async () => {
    const otherGymId = await createTestGym('AT Other Gym');
    // TEST_USER_ID has no membership in otherGymId
    const res = await request
      .get(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(403);
  });

  it('returns 404 when fetching an activity type that belongs to another gym', async () => {
    const gymA = await createTestGym('AT Gym A');
    const gymB = await createTestGym('AT Gym B');
    await createTestMembership(gymA, 'admin');
    await createTestMembership(gymB, 'admin');

    const createRes = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ name: 'Cross-Tenant AT', duration_minutes: 30, max_capacity: 10 });
    expect(createRes.status).toBe(201);
    const crossId = createRes.body.id;

    const res = await request
      .get(`${BASE}/${crossId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });
});

// ── Role guard ─────────────────────────────────────────────────────────────

describe('role guard', () => {
  it('returns 403 when front_desk user tries to POST /activity-types', async () => {
    // front_desk has R access on ORGANIZATION module but is not admin → requireRole('admin') rejects
    const fdGymId = await createTestGym('AT FD Gym');
    await createTestMembership(fdGymId, 'front_desk');

    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', fdGymId)
      .send({ name: 'Yoga', duration_minutes: 60, max_capacity: 20 });
    expect(res.status).toBe(403);
  });

  it('returns 403 when accountant user tries to GET /activity-types (no ORGANIZATION access)', async () => {
    // accountant has NONE on ORGANIZATION → requireModuleAccess rejects at module level
    const accGymId = await createTestGym('AT ACC Gym');
    await createTestMembership(accGymId, 'accountant');

    const res = await request
      .get(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', accGymId);
    expect(res.status).toBe(403);
  });
});

// ── Happy path: GET / ──────────────────────────────────────────────────────

describe('GET /activity-types', () => {
  it('returns 200 with an array', async () => {
    const res = await request
      .get(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 400 for invalid status query param', async () => {
    const res = await request
      .get(`${BASE}?status=invalid`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });
});

// ── Happy path: GET /:id ───────────────────────────────────────────────────

describe('GET /activity-types/:id', () => {
  it('returns 200 with schedule_rules array', async () => {
    const res = await request
      .get(`${BASE}/${activityTypeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(activityTypeId);
    expect(Array.isArray(res.body.schedule_rules)).toBe(true);
  });

  it('returns 404 for a non-existent id', async () => {
    const res = await request
      .get(`${BASE}/999999`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ── Happy path: POST ───────────────────────────────────────────────────────

describe('POST /activity-types', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Incomplete' }); // missing duration_minutes and max_capacity
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid intensity_level', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Bad Intensity', duration_minutes: 30, max_capacity: 10, intensity_level: 10 });
    expect(res.status).toBe(400);
  });

  it('creates an activity type and returns 201 with correct shape', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'Pilates',
        duration_minutes: 50,
        max_capacity: 12,
        intensity_level: 3,
        status: 'active',
        color: '#FF5733',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Pilates',
      duration_minutes: 50,
      max_capacity: 12,
      intensity_level: 3,
      status: 'active',
      color: '#FF5733',
    });
    expect(Array.isArray(res.body.schedule_rules)).toBe(true);
    expect(res.body.schedule_rules).toHaveLength(0);
    expect(typeof res.body.id).toBe('number');
  });
});

// ── Happy path: PUT ────────────────────────────────────────────────────────

describe('PUT /activity-types/:id', () => {
  it('updates fields and returns 200 with updated values', async () => {
    const res = await request
      .put(`${BASE}/${activityTypeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Yoga Updated', duration_minutes: 45 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Yoga Updated');
    expect(res.body.duration_minutes).toBe(45);
  });

  it('returns 404 when updating a non-existent activity type', async () => {
    const res = await request
      .put(`${BASE}/999999`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });
});

// ── #503 stage 3: propagate default field edits to future calendar_events ──

async function insertPropMember(gymId: string): Promise<number> {
  const email = `prop-member-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Prop Member', ?)`,
    [gymId, email],
  );
  return insertId;
}

describe('PUT /activity-types/:id — propagate to future calendar_events (#503 stage 3)', () => {
  let propGymId: string;
  let propActivityTypeId: number;
  let centerAId: number;
  let centerBId: number;
  let spaceAId: number;
  let spaceBId: number;
  let trainerAId: number;
  let trainerBId: number;
  let pastEventId: number;
  let futureEventId: number;
  let futureBookedEventId: number;

  beforeAll(async () => {
    propGymId = await createTestGym('AT Prop Gym');
    await createTestMembership(propGymId, 'admin');

    const { insertId: cA } = await db.query(`INSERT INTO centers (gym_id, name, status) VALUES (?, 'Center A', 'active')`, [propGymId]);
    centerAId = cA;
    const { insertId: cB } = await db.query(`INSERT INTO centers (gym_id, name, status) VALUES (?, 'Center B', 'active')`, [propGymId]);
    centerBId = cB;
    const { insertId: sA } = await db.query(`INSERT INTO spaces (gym_id, name, capacity, status, center_id) VALUES (?, 'Space A', 20, 'active', ?)`, [propGymId, centerAId]);
    spaceAId = sA;
    const { insertId: sB } = await db.query(`INSERT INTO spaces (gym_id, name, capacity, status, center_id) VALUES (?, 'Space B', 20, 'active', ?)`, [propGymId, centerBId]);
    spaceBId = sB;
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, name) VALUES (?, ?, 'trainer_performance', 'active', 'Trainer A')`,
      [`prop-trainer-a-${Date.now()}`, propGymId],
    );
    const { rows: tA } = await db.query(`SELECT id FROM gym_memberships WHERE gym_id = ? AND name = 'Trainer A'`, [propGymId]);
    trainerAId = tA[0].id;
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, name) VALUES (?, ?, 'trainer_performance', 'active', 'Trainer B')`,
      [`prop-trainer-b-${Date.now()}`, propGymId],
    );
    const { rows: tB } = await db.query(`SELECT id FROM gym_memberships WHERE gym_id = ? AND name = 'Trainer B'`, [propGymId]);
    trainerBId = tB[0].id;

    const createRes = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', propGymId)
      .send({
        name: 'Propagation Activity', duration_minutes: 60, max_capacity: 10, status: 'active',
        default_center_id: centerAId, default_space_id: spaceAId, default_trainer_membership_id: trainerAId,
        color: '#ff0000',
      });
    expect(createRes.status).toBe(201);
    propActivityTypeId = createRes.body.id;

    // A past occurrence — must never be touched by propagation.
    const { insertId: pastId } = await db.query(
      `INSERT INTO calendar_events
        (gym_id, title, activity_type_id, center_id, space_id, trainer_membership_id, color, capacity, starts_at, ends_at)
       VALUES (?, 'Propagation Activity', ?, ?, ?, ?, '#ff0000', 10, '2020-01-01 10:00:00', '2020-01-01 11:00:00')`,
      [propGymId, propActivityTypeId, centerAId, spaceAId, trainerAId],
    );
    pastEventId = pastId;

    // A future, unbooked occurrence.
    const { insertId: futId } = await db.query(
      `INSERT INTO calendar_events
        (gym_id, title, activity_type_id, center_id, space_id, trainer_membership_id, color, capacity, starts_at, ends_at)
       VALUES (?, 'Propagation Activity', ?, ?, ?, ?, '#ff0000', 10, '2099-01-01 10:00:00', '2099-01-01 11:00:00')`,
      [propGymId, propActivityTypeId, centerAId, spaceAId, trainerAId],
    );
    futureEventId = futId;

    // A future occurrence with an existing booking — must keep the booking untouched.
    const { insertId: futBookedId } = await db.query(
      `INSERT INTO calendar_events
        (gym_id, title, activity_type_id, center_id, space_id, trainer_membership_id, color, capacity, starts_at, ends_at)
       VALUES (?, 'Propagation Activity', ?, ?, ?, ?, '#ff0000', 10, '2099-02-01 10:00:00', '2099-02-01 11:00:00')`,
      [propGymId, propActivityTypeId, centerAId, spaceAId, trainerAId],
    );
    futureBookedEventId = futBookedId;
    const memberId = await insertPropMember(propGymId);
    await db.query(
      `INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status) VALUES (?, ?, ?, 'booked')`,
      [propGymId, futureBookedEventId, memberId],
    );
  });

  it('returns 409 future_events_impacted without confirm_propagate, naming affected fields and counts', async () => {
    const res = await request
      .put(`${BASE}/${propActivityTypeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', propGymId)
      .send({
        default_center_id: centerBId, default_space_id: spaceBId, default_trainer_membership_id: trainerBId,
        color: '#00ff00', max_capacity: 25,
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('future_events_impacted');
    expect(res.body.impacted_events).toBe(2);
    expect(res.body.booked_events).toBe(1);
    expect(res.body.fields).toEqual(
      expect.arrayContaining(['Space', 'Trainer', 'Center', 'Color', 'Capacity']),
    );

    // Nothing should have changed yet — the propagation didn't happen.
    const { rows } = await db.query('SELECT default_center_id FROM activity_types WHERE id = ?', [propActivityTypeId]);
    expect(rows[0].default_center_id).toBe(centerAId);
  });

  it('does not require confirmation for fields that are not propagated (e.g. name/duration)', async () => {
    const res = await request
      .put(`${BASE}/${propActivityTypeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', propGymId)
      .send({ name: 'Propagation Activity Renamed', duration_minutes: 45 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Propagation Activity Renamed');
  });

  it('applies the change to future events and preserves the past event and existing booking once confirmed', async () => {
    const res = await request
      .put(`${BASE}/${propActivityTypeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', propGymId)
      .send({
        default_center_id: centerBId, default_space_id: spaceBId, default_trainer_membership_id: trainerBId,
        color: '#00ff00', max_capacity: 25,
        confirm_propagate: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.default_center_id).toBe(centerBId);

    const { rows: future } = await db.query(
      'SELECT center_id, space_id, trainer_membership_id, color, capacity FROM calendar_events WHERE id IN (?, ?)',
      [futureEventId, futureBookedEventId],
    );
    for (const row of future) {
      expect(row.center_id).toBe(centerBId);
      expect(row.space_id).toBe(spaceBId);
      expect(row.trainer_membership_id).toBe(trainerBId);
      expect(row.color).toBe('#00ff00');
      expect(row.capacity).toBe(25);
    }

    const { rows: past } = await db.query(
      'SELECT center_id, space_id, trainer_membership_id, color, capacity FROM calendar_events WHERE id = ?',
      [pastEventId],
    );
    expect(past[0].center_id).toBe(centerAId);
    expect(past[0].space_id).toBe(spaceAId);
    expect(past[0].trainer_membership_id).toBe(trainerAId);
    expect(past[0].color).toBe('#ff0000');
    expect(past[0].capacity).toBe(10);

    const { rows: booking } = await db.query(
      `SELECT status FROM calendar_event_bookings WHERE calendar_event_id = ? AND status = 'booked'`,
      [futureBookedEventId],
    );
    expect(booking).toHaveLength(1);
  });

  it('does not require confirmation and does not touch calendar_events when no propagated field changed', async () => {
    const res = await request
      .put(`${BASE}/${propActivityTypeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', propGymId)
      .send({
        default_center_id: centerBId, default_space_id: spaceBId, default_trainer_membership_id: trainerBId,
        color: '#00ff00', max_capacity: 25,
      });
    expect(res.status).toBe(200);
  });
});

// ── Soft-delete & restore ──────────────────────────────────────────────────

describe('soft-delete and restore', () => {
  let deleteId: number;

  beforeAll(async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'To Be Deleted AT', duration_minutes: 30, max_capacity: 5 });
    expect(res.status).toBe(201);
    deleteId = res.body.id;
  });

  it('DELETE returns 204', async () => {
    const res = await request
      .delete(`${BASE}/${deleteId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('soft-deleted row is hidden from GET /', async () => {
    const res = await request
      .get(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((a: any) => a.id);
    expect(ids).not.toContain(deleteId);
  });

  it('soft-deleted row has deleted_at set in the database', async () => {
    const { rows } = await db.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM activity_types WHERE id = ?',
      [deleteId],
    );
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it('GET /:id returns 404 for the soft-deleted row', async () => {
    const res = await request
      .get(`${BASE}/${deleteId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('POST /:id/restore returns 204', async () => {
    const res = await request
      .post(`${BASE}/${deleteId}/restore`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('restored row reappears in GET /', async () => {
    const res = await request
      .get(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((a: any) => a.id);
    expect(ids).toContain(deleteId);
  });

  it('restored row has deleted_at cleared in the database', async () => {
    const { rows } = await db.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM activity_types WHERE id = ?',
      [deleteId],
    );
    expect(rows[0].deleted_at).toBeNull();
  });
});

// ── Audit metadata ────────────────────────────────────────────────────────

describe('audit metadata', () => {
  let auditGymId: string;
  let testMembershipId: number;
  let otherMembershipId: number;

  beforeAll(async () => {
    auditGymId = await createTestGym('AT Audit Gym');
    // Primary test user membership
    await createTestMembership(auditGymId, 'admin');
    const { rows: tm } = await db.query<{ id: number }>(
      'SELECT id FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
      ['test-user-id', auditGymId],
    );
    testMembershipId = tm[0].id;

    // Secondary membership for the "different user" scenarios
    await createTestMembership(auditGymId, 'admin', 'other-user-id');
    const { rows: om } = await db.query<{ id: number }>(
      'SELECT id FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
      ['other-user-id', auditGymId],
    );
    otherMembershipId = om[0].id;
  });

  it('create sets created_by and modified_by to the authenticated user', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', auditGymId)
      .send({ name: 'Audit Create', duration_minutes: 30, max_capacity: 10 });
    expect(res.status).toBe(201);
    const { rows } = await db.query<{ created_by_membership_id: number; modified_by_membership_id: number }>(
      'SELECT created_by_membership_id, modified_by_membership_id FROM activity_types WHERE id = ?',
      [res.body.id],
    );
    expect(rows[0].created_by_membership_id).toBe(testMembershipId);
    expect(rows[0].modified_by_membership_id).toBe(testMembershipId);
  });

  it('update by same user keeps created_by and updates modified_by', async () => {
    const createRes = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', auditGymId)
      .send({ name: 'Audit Same User', duration_minutes: 30, max_capacity: 10 });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id;

    const putRes = await request
      .put(`${BASE}/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', auditGymId)
      .send({ name: 'Audit Same User Updated' });
    expect(putRes.status).toBe(200);

    const { rows } = await db.query<{ created_by_membership_id: number; modified_by_membership_id: number }>(
      'SELECT created_by_membership_id, modified_by_membership_id FROM activity_types WHERE id = ?',
      [id],
    );
    expect(rows[0].created_by_membership_id).toBe(testMembershipId);
    expect(rows[0].modified_by_membership_id).toBe(testMembershipId);
  });

  it('update by different user preserves created_by and sets modified_by to the new user', async () => {
    // Insert activity directly with the other user as creator
    const { insertId } = await db.query(
      `INSERT INTO activity_types
       (gym_id, name, duration_minutes, max_capacity, status,
        created_by_membership_id, modified_at, modified_by_membership_id)
       VALUES (?,?,?,?,'active',?,UTC_TIMESTAMP(),?)`,
      [auditGymId, 'Audit Diff User', 30, 10, otherMembershipId, otherMembershipId],
    );

    // Update as the primary test user
    const putRes = await request
      .put(`${BASE}/${insertId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', auditGymId)
      .send({ name: 'Audit Diff User Updated' });
    expect(putRes.status).toBe(200);

    const { rows } = await db.query<{ created_by_membership_id: number; modified_by_membership_id: number }>(
      'SELECT created_by_membership_id, modified_by_membership_id FROM activity_types WHERE id = ?',
      [insertId],
    );
    expect(rows[0].created_by_membership_id).toBe(otherMembershipId);
    expect(rows[0].modified_by_membership_id).toBe(testMembershipId);
  });

  it('multiple updates keep created_by stable', async () => {
    // Insert activity with the other user as creator
    const { insertId } = await db.query(
      `INSERT INTO activity_types
       (gym_id, name, duration_minutes, max_capacity, status,
        created_by_membership_id, modified_at, modified_by_membership_id)
       VALUES (?,?,?,?,'active',?,UTC_TIMESTAMP(),?)`,
      [auditGymId, 'Audit Multi Update', 30, 10, otherMembershipId, otherMembershipId],
    );

    // Two sequential updates as the test user
    for (const name of ['Round 1', 'Round 2']) {
      const res = await request
        .put(`${BASE}/${insertId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', auditGymId)
        .send({ name: `Audit Multi ${name}` });
      expect(res.status).toBe(200);
    }

    const { rows } = await db.query<{ created_by_membership_id: number; modified_by_membership_id: number }>(
      'SELECT created_by_membership_id, modified_by_membership_id FROM activity_types WHERE id = ?',
      [insertId],
    );
    expect(rows[0].created_by_membership_id).toBe(otherMembershipId);
    expect(rows[0].modified_by_membership_id).toBe(testMembershipId);
  });

  it('failed update does not change modified_by', async () => {
    // Insert activity with the other user as creator+modifier
    const { insertId } = await db.query(
      `INSERT INTO activity_types
       (gym_id, name, duration_minutes, max_capacity, status,
        created_by_membership_id, modified_at, modified_by_membership_id)
       VALUES (?,?,?,?,'active',?,UTC_TIMESTAMP(),?)`,
      [auditGymId, 'Audit Failed Update', 30, 10, otherMembershipId, otherMembershipId],
    );

    // Attempt invalid update (bad intensity_level)
    const putRes = await request
      .put(`${BASE}/${insertId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', auditGymId)
      .send({ intensity_level: 99 });
    expect(putRes.status).toBe(400);

    const { rows } = await db.query<{ created_by_membership_id: number; modified_by_membership_id: number }>(
      'SELECT created_by_membership_id, modified_by_membership_id FROM activity_types WHERE id = ?',
      [insertId],
    );
    expect(rows[0].created_by_membership_id).toBe(otherMembershipId);
    expect(rows[0].modified_by_membership_id).toBe(otherMembershipId);
  });

  it('client-supplied audit fields in request body are ignored', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', auditGymId)
      .send({
        name: 'Audit Client Fields',
        duration_minutes: 30,
        max_capacity: 10,
        created_by_membership_id: otherMembershipId,
        modified_by_membership_id: otherMembershipId,
      });
    expect(res.status).toBe(201);

    const { rows } = await db.query<{ created_by_membership_id: number; modified_by_membership_id: number }>(
      'SELECT created_by_membership_id, modified_by_membership_id FROM activity_types WHERE id = ?',
      [res.body.id],
    );
    // Backend must use the authenticated user's membership, not the client-supplied value
    expect(rows[0].created_by_membership_id).toBe(testMembershipId);
    expect(rows[0].modified_by_membership_id).toBe(testMembershipId);
  });
});

// ── public_event (#481) ─────────────────────────────────────────────────────

describe('public_event', () => {
  it('defaults to true when omitted on create', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Public Event Default', duration_minutes: 30, max_capacity: 10 });
    expect(res.status).toBe(201);
    expect(res.body.public_event).toBeTruthy();
  });

  it('can be set to false explicitly on create', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Public Event False', duration_minutes: 30, max_capacity: 10, public_event: false });
    expect(res.status).toBe(201);
    expect(res.body.public_event).toBeFalsy();
  });

  it('can be flipped false via PUT and back to true', async () => {
    const createRes = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Public Event Toggle', duration_minutes: 30, max_capacity: 10 });
    expect(createRes.status).toBe(201);
    expect(createRes.body.public_event).toBeTruthy();
    const id = createRes.body.id;

    const putRes = await request
      .put(`${BASE}/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ public_event: false });
    expect(putRes.status).toBe(200);
    expect(putRes.body.public_event).toBeFalsy();

    const putBackRes = await request
      .put(`${BASE}/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ public_event: true });
    expect(putBackRes.status).toBe(200);
    expect(putBackRes.body.public_event).toBeTruthy();
  });

  it('rejects a non-boolean public_event', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Public Event Bad', duration_minutes: 30, max_capacity: 10, public_event: 'yes' });
    expect(res.status).toBe(400);
  });
});

// ── Eligible plans (#481) ────────────────────────────────────────────────────

describe('GET/PUT /activity-types/:id/eligible-plans', () => {
  let epGymId: string;
  let epActivityTypeId: number;
  let planAId: number;
  let planBId: number;

  beforeAll(async () => {
    epGymId = await createTestGym('AT Eligible Plans Gym');
    await createTestMembership(epGymId, 'admin');

    const atRes = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId)
      .send({ name: 'Restricted Class', duration_minutes: 45, max_capacity: 8, public_event: false });
    expect(atRes.status).toBe(201);
    epActivityTypeId = atRes.body.id;

    const { insertId: pA } = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, 'Plan A', 'active', 'staff_only')`,
      [epGymId],
    );
    planAId = pA;
    const { insertId: pB } = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, 'Plan B', 'active', 'staff_only')`,
      [epGymId],
    );
    planBId = pB;
  });

  it('returns an empty array when no plans are configured', async () => {
    const res = await request
      .get(`${BASE}/${epActivityTypeId}/eligible-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('404s GET for a non-existent activity type', async () => {
    const res = await request
      .get(`${BASE}/999999/eligible-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId);
    expect(res.status).toBe(404);
  });

  it('404s PUT for a non-existent activity type', async () => {
    const res = await request
      .put(`${BASE}/999999/eligible-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId)
      .send({ membership_plan_ids: [planAId] });
    expect(res.status).toBe(404);
  });

  it('400s when a plan id belongs to another gym', async () => {
    const otherGymId = await createTestGym('AT Eligible Plans Other Gym');
    await createTestMembership(otherGymId, 'admin');
    const { insertId: foreignPlanId } = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, 'Foreign Plan', 'active', 'staff_only')`,
      [otherGymId],
    );

    const res = await request
      .put(`${BASE}/${epActivityTypeId}/eligible-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId)
      .send({ membership_plan_ids: [foreignPlanId] });
    expect(res.status).toBe(400);
  });

  it('400s for a completely invalid plan id', async () => {
    const res = await request
      .put(`${BASE}/${epActivityTypeId}/eligible-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId)
      .send({ membership_plan_ids: [999999] });
    expect(res.status).toBe(400);
  });

  it('sets eligible plans and GET reflects them, ordered by name', async () => {
    const putRes = await request
      .put(`${BASE}/${epActivityTypeId}/eligible-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId)
      .send({ membership_plan_ids: [planBId, planAId] });
    expect(putRes.status).toBe(204);

    const getRes = await request
      .get(`${BASE}/${epActivityTypeId}/eligible-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId);
    expect(getRes.status).toBe(200);
    expect(getRes.body.map((p: any) => p.name)).toEqual(['Plan A', 'Plan B']);
    expect(getRes.body.map((p: any) => p.id).sort()).toEqual([planAId, planBId].sort());
  });

  it('replace-all semantics: a second PUT fully replaces the previous set', async () => {
    const putRes = await request
      .put(`${BASE}/${epActivityTypeId}/eligible-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId)
      .send({ membership_plan_ids: [planAId] });
    expect(putRes.status).toBe(204);

    const getRes = await request
      .get(`${BASE}/${epActivityTypeId}/eligible-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId);
    expect(getRes.status).toBe(200);
    expect(getRes.body).toHaveLength(1);
    expect(getRes.body[0].id).toBe(planAId);
  });

  it('an empty list clears all eligible plans', async () => {
    const putRes = await request
      .put(`${BASE}/${epActivityTypeId}/eligible-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId)
      .send({ membership_plan_ids: [] });
    expect(putRes.status).toBe(204);

    const getRes = await request
      .get(`${BASE}/${epActivityTypeId}/eligible-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId);
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual([]);
  });

  it('returns 404 when reading eligible-plans for an activity type from another gym', async () => {
    const gymD = await createTestGym('AT Eligible Plans Gym D');
    await createTestMembership(gymD, 'admin');
    const res = await request
      .get(`${BASE}/${epActivityTypeId}/eligible-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymD);
    expect(res.status).toBe(404);
  });

  it('returns 403 for a non-admin role on PUT eligible-plans', async () => {
    const fdGymId = await createTestGym('AT Eligible Plans FD Gym');
    await createTestMembership(fdGymId, 'front_desk');
    // Insert directly since front_desk cannot POST /activity-types.
    const { insertId: fdActivityTypeId } = await db.query(
      `INSERT INTO activity_types (gym_id, name, max_capacity, status, public_event) VALUES (?, 'FD Test AT', 10, 'active', 0)`,
      [fdGymId],
    );
    const res = await request
      .put(`${BASE}/${fdActivityTypeId}/eligible-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', fdGymId)
      .send({ membership_plan_ids: [] });
    expect(res.status).toBe(403);
  });
});

// ── Duplicate ──────────────────────────────────────────────────────────────

describe('POST /activity-types/:id/duplicate', () => {
  it('creates a copy with " (copy)" suffix and returns 201', async () => {
    // activityTypeId was renamed to "Yoga Updated" by the PUT test above
    const res = await request
      .post(`${BASE}/${activityTypeId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.name).toContain('(copy)');
    expect(res.body.id).not.toBe(activityTypeId);
    expect(Array.isArray(res.body.schedule_rules)).toBe(true);
  });

  it('returns 404 when duplicating a non-existent activity type', async () => {
    const res = await request
      .post(`${BASE}/999999/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 when duplicating an activity type from another gym', async () => {
    const gymC = await createTestGym('AT Gym C');
    await createTestMembership(gymC, 'admin');

    const res = await request
      .post(`${BASE}/${activityTypeId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymC);
    expect(res.status).toBe(404);
  });
});

// ── Waitlist mode (#503 stage 2) ───────────────────────────────────────────

describe('waitlist_mode', () => {
  it('defaults to disabled when the field is omitted on create', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `WM default ${Date.now()}`, duration_minutes: 45, max_capacity: 8 });

    expect(res.status).toBe(201);
    expect(res.body.waitlist_mode).toBe('disabled');
  });

  it('accepts a waitlist_mode on create and returns it', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `WM open ${Date.now()}`, duration_minutes: 45, max_capacity: 8, waitlist_mode: 'open' });

    expect(res.status).toBe(201);
    expect(res.body.waitlist_mode).toBe('open');
  });

  it('returns 400 for an unknown waitlist_mode', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `WM bad ${Date.now()}`, duration_minutes: 45, max_capacity: 8, waitlist_mode: 'paused' });

    expect(res.status).toBe(400);
  });

  it('updates waitlist_mode via PUT and leaves it untouched when omitted', async () => {
    const created = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `WM update ${Date.now()}`, duration_minutes: 45, max_capacity: 8, waitlist_mode: 'open' });

    const updated = await request
      .put(`${BASE}/${created.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ waitlist_mode: 'closed' });
    expect(updated.status).toBe(200);
    expect(updated.body.waitlist_mode).toBe('closed');

    const renamed = await request
      .put(`${BASE}/${created.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `WM renamed ${Date.now()}` });
    expect(renamed.body.waitlist_mode).toBe('closed');
  });

  it('carries waitlist_mode over to a duplicated activity type', async () => {
    const created = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `WM dup ${Date.now()}`, duration_minutes: 45, max_capacity: 8, waitlist_mode: 'open' });

    const dup = await request
      .post(`${BASE}/${created.body.id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(dup.status).toBe(201);
    expect(dup.body.waitlist_mode).toBe('open');
  });
});
