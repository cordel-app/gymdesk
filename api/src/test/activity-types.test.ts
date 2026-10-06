// Tests for activity-types.ts router

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  createTestStaffForMembership,
  request,
  TEST_AUTH_HEADER,
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
    // #986: a Default Trainer is an active Staff record, not a coach role on
    // the login row, and `POST`/`PUT /activity-types` validate that now.
    await createTestStaffForMembership(propGymId, trainerAId, 'Trainer', 'A');
    await createTestStaffForMembership(propGymId, trainerBId, 'Trainer', 'B');

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

// ── Eligible Professional Services (#481 → #973 stage 1) ────────────────────

describe('GET/PUT /activity-types/:id/eligible-professional-services', () => {
  let epGymId: string;
  let epActivityTypeId: number;
  let serviceAId: number;
  let serviceBId: number;

  async function createService(gymId: string, name: string, status: 'active' | 'inactive' = 'active'): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)`,
      [gymId, name],
    );
    await db.query(
      `INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, ?)`,
      [gymId, insertId, status],
    );
    return insertId;
  }

  const getServices = (id: number | string, gymId = epGymId) => request
    .get(`${BASE}/${id}/eligible-professional-services`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);
  const putServices = (id: number | string, body: any, gymId = epGymId) => request
    .put(`${BASE}/${id}/eligible-professional-services`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send(body);

  beforeAll(async () => {
    epGymId = await createTestGym('AT Eligible Services Gym');
    await createTestMembership(epGymId, 'admin');

    const atRes = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId)
      .send({ name: 'Restricted Class', duration_minutes: 45, max_capacity: 8, public_event: false });
    expect(atRes.status).toBe(201);
    epActivityTypeId = atRes.body.id;

    serviceAId = await createService(epGymId, 'Service A');
    serviceBId = await createService(epGymId, 'Service B');
  });

  it('returns an empty array when no services are configured', async () => {
    const res = await getServices(epActivityTypeId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('404s GET for a non-existent activity type', async () => {
    expect((await getServices(999999)).status).toBe(404);
  });

  it('404s PUT for a non-existent activity type', async () => {
    expect((await putServices(999999, { professional_service_ids: [serviceAId] })).status).toBe(404);
  });

  it('400s when a service id belongs to another gym', async () => {
    const otherGymId = await createTestGym('AT Eligible Services Other Gym');
    await createTestMembership(otherGymId, 'admin');
    const foreignId = await createService(otherGymId, 'Foreign Service');
    expect((await putServices(epActivityTypeId, { professional_service_ids: [foreignId] })).status).toBe(400);
  });

  it('400s for a completely invalid service id, and for a non-array body', async () => {
    expect((await putServices(epActivityTypeId, { professional_service_ids: [999999] })).status).toBe(400);
    expect((await putServices(epActivityTypeId, { professional_service_ids: ['x'] })).status).toBe(400);
    expect((await putServices(epActivityTypeId, { professional_service_ids: 'nope' })).status).toBe(400);
  });

  it('400s a service the gym has switched off — it could never make a member eligible', async () => {
    const inactiveId = await createService(epGymId, 'Inactive Service', 'inactive');
    expect((await putServices(epActivityTypeId, { professional_service_ids: [inactiveId] })).status).toBe(400);
  });

  it('sets eligible services and GET reflects them, ordered by name', async () => {
    const putRes = await putServices(epActivityTypeId, { professional_service_ids: [serviceBId, serviceAId] });
    expect(putRes.status).toBe(204);

    const getRes = await getServices(epActivityTypeId);
    expect(getRes.status).toBe(200);
    expect(getRes.body.map((p: any) => p.name)).toEqual(['Service A', 'Service B']);
    expect(getRes.body.map((p: any) => p.id).sort()).toEqual([serviceAId, serviceBId].sort());
  });

  it('GET /activity-types/:id carries the same list (§7)', async () => {
    const res = await request
      .get(`${BASE}/${epActivityTypeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId);
    expect(res.status).toBe(200);
    expect(res.body.eligible_professional_services.map((p: any) => p.name)).toEqual(['Service A', 'Service B']);
  });

  it('replace-all semantics: a second PUT fully replaces the previous set', async () => {
    expect((await putServices(epActivityTypeId, { professional_service_ids: [serviceAId] })).status).toBe(204);
    const getRes = await getServices(epActivityTypeId);
    expect(getRes.body).toHaveLength(1);
    expect(getRes.body[0].id).toBe(serviceAId);
  });

  it('keeps a stored service the gym has since switched off when it is re-sent unchanged (#986\'s rule)', async () => {
    await db.query(
      `UPDATE gym_professional_services SET status = 'inactive' WHERE gym_id = ? AND professional_service_id = ?`,
      [epGymId, serviceAId],
    );
    expect((await putServices(epActivityTypeId, { professional_service_ids: [serviceAId] })).status).toBe(204);
    await db.query(
      `UPDATE gym_professional_services SET status = 'active' WHERE gym_id = ? AND professional_service_id = ?`,
      [epGymId, serviceAId],
    );
  });

  it('the duplicate of an activity type names the same services', async () => {
    const dup = await request
      .post(`${BASE}/${epActivityTypeId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId);
    expect(dup.status).toBe(201);
    const getRes = await getServices(dup.body.id);
    expect(getRes.body.map((p: any) => p.id)).toEqual([serviceAId]);
  });

  it('an empty list clears all eligible services', async () => {
    expect((await putServices(epActivityTypeId, { professional_service_ids: [] })).status).toBe(204);
    expect((await getServices(epActivityTypeId)).body).toEqual([]);
  });

  it('returns 404 when reading eligible services for an activity type from another gym', async () => {
    const gymD = await createTestGym('AT Eligible Services Gym D');
    await createTestMembership(gymD, 'admin');
    expect((await getServices(epActivityTypeId, gymD)).status).toBe(404);
  });

  it('returns 403 for a non-admin role on PUT', async () => {
    const fdGymId = await createTestGym('AT Eligible Services FD Gym');
    await createTestMembership(fdGymId, 'front_desk');
    // Insert directly since front_desk cannot POST /activity-types.
    const { insertId: fdActivityTypeId } = await db.query(
      `INSERT INTO activity_types (gym_id, name, max_capacity, status, public_event) VALUES (?, 'FD Test AT', 10, 'active', 0)`,
      [fdGymId],
    );
    expect((await putServices(fdActivityTypeId, { professional_service_ids: [] }, fdGymId)).status).toBe(403);
  });

  it('no longer routes the retired eligible-plans endpoints', async () => {
    const res = await request
      .get(`${BASE}/${epActivityTypeId}/eligible-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', epGymId);
    expect(res.status).toBe(404);
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

// ── #647 stage 1: professional_service_id ───────────────────────────────────

describe('professional_service_id (#647)', () => {
  let psGymId: string;
  let otherGymId: string;
  let activeServiceId: number;
  let inactiveServiceId: number;
  let otherGymServiceId: number;

  /** A gym-owned Professional Service plus its per-gym enable row (#484). */
  async function createService(gid: string, name: string, status: 'active' | 'inactive' = 'active') {
    const { insertId } = await db.query(
      `INSERT INTO professional_services (gym_id, name, is_system) VALUES (?, ?, 0)`,
      [gid, name],
    );
    await db.query(
      `INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, ?)`,
      [gid, insertId, status],
    );
    return insertId;
  }

  const post = (gid: string, body: any) => request
    .post(BASE).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid).send(body);
  const put = (gid: string, id: number, body: any) => request
    .put(`${BASE}/${id}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid).send(body);

  beforeAll(async () => {
    psGymId = await createTestGym('AT PS Gym');
    await createTestMembership(psGymId, 'admin');
    otherGymId = await createTestGym('AT PS Other Gym');

    activeServiceId = await createService(psGymId, `PT Individual ${Date.now()}`);
    inactiveServiceId = await createService(psGymId, `Retired Service ${Date.now()}`, 'inactive');
    otherGymServiceId = await createService(otherGymId, `Foreign Service ${Date.now()}`);
  });

  it('stores the service on create and returns its name', async () => {
    const res = await post(psGymId, {
      name: `PS create ${Date.now()}`, duration_minutes: 60, max_capacity: 5,
      professional_service_id: activeServiceId,
    });

    expect(res.status).toBe(201);
    expect(res.body.professional_service_id).toBe(activeServiceId);
    expect(res.body.professional_service_name).toBeTruthy();
  });

  it('defaults to null when the field is omitted', async () => {
    const res = await post(psGymId, { name: `PS none ${Date.now()}`, duration_minutes: 60, max_capacity: 5 });

    expect(res.status).toBe(201);
    expect(res.body.professional_service_id).toBeNull();
  });

  it('rejects a service belonging to another gym', async () => {
    const res = await post(psGymId, {
      name: `PS foreign ${Date.now()}`, duration_minutes: 60, max_capacity: 5,
      professional_service_id: otherGymServiceId,
    });

    expect(res.status).toBe(400);
  });

  it('rejects a service the gym has switched off', async () => {
    const res = await post(psGymId, {
      name: `PS inactive ${Date.now()}`, duration_minutes: 60, max_capacity: 5,
      professional_service_id: inactiveServiceId,
    });

    expect(res.status).toBe(400);
  });

  it('rejects a non-numeric id', async () => {
    const res = await post(psGymId, {
      name: `PS bad ${Date.now()}`, duration_minutes: 60, max_capacity: 5,
      professional_service_id: 'personal-training',
    });

    expect(res.status).toBe(400);
  });

  it('sets, clears and leaves the service untouched via PUT', async () => {
    const created = await post(psGymId, { name: `PS put ${Date.now()}`, duration_minutes: 60, max_capacity: 5 });

    const set = await put(psGymId, created.body.id, { professional_service_id: activeServiceId });
    expect(set.status).toBe(200);
    expect(set.body.professional_service_id).toBe(activeServiceId);

    const renamed = await put(psGymId, created.body.id, { name: `PS put renamed ${Date.now()}` });
    expect(renamed.body.professional_service_id).toBe(activeServiceId);

    const cleared = await put(psGymId, created.body.id, { professional_service_id: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.professional_service_id).toBeNull();
  });

  it('propagates a change to future occurrences only, behind confirm_propagate', async () => {
    const created = await post(psGymId, { name: `PS prop ${Date.now()}`, duration_minutes: 60, max_capacity: 5 });
    const atId = created.body.id;

    const { insertId: pastId } = await db.query(
      `INSERT INTO calendar_events (gym_id, title, activity_type_id, starts_at, ends_at, status)
       VALUES (?, 'Past', ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 47 HOUR), 'scheduled')`,
      [psGymId, atId],
    );
    const { insertId: futureId } = await db.query(
      `INSERT INTO calendar_events (gym_id, title, activity_type_id, starts_at, ends_at, status)
       VALUES (?, 'Future', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 49 HOUR), 'scheduled')`,
      [psGymId, atId],
    );

    const blocked = await put(psGymId, atId, { professional_service_id: activeServiceId });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('future_events_impacted');

    const confirmed = await put(psGymId, atId, { professional_service_id: activeServiceId, confirm_propagate: true });
    expect(confirmed.status).toBe(200);

    const { rows } = await db.query(
      'SELECT id, professional_service_id FROM calendar_events WHERE id IN (?, ?)',
      [pastId, futureId],
    );
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r.professional_service_id]));
    expect(byId[futureId]).toBe(activeServiceId);
    expect(byId[pastId]).toBeNull();
  });

  it('carries the service over to a duplicated activity type', async () => {
    const created = await post(psGymId, {
      name: `PS dup ${Date.now()}`, duration_minutes: 60, max_capacity: 5,
      professional_service_id: activeServiceId,
    });

    const dup = await request
      .post(`${BASE}/${created.body.id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', psGymId);

    expect(dup.status).toBe(201);
    expect(dup.body.professional_service_id).toBe(activeServiceId);
  });
});

// ── #986: default_trainer_membership_id ─────────────────────────────────────

describe('default_trainer_membership_id (#986)', () => {
  let dtGymId: string;
  let foreignGymId: string;
  let frontDeskTrainerId: number;
  let formerStaffTrainerId: number;
  let foreignTrainerId: number;
  let alreadyInactiveTrainerId: number;
  let formerStaffId: number;

  const post = (gid: string, body: any) => request
    .post(BASE).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid).send(body);
  const put = (gid: string, id: number, body: any) => request
    .put(`${BASE}/${id}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid).send(body);

  /** A staff member with the login row a trainer assignment keys to. */
  async function createStaffTrainer(
    gid: string,
    first: string,
    profile: string,
    employment: 'active' | 'inactive' = 'active',
  ): Promise<{ membershipId: number; staffId: number }> {
    const { insertId: membershipId } = await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, name)
       VALUES (?, ?, 'front_desk', 'active', ?)`,
      [`at-trainer-${Math.random().toString(36).slice(2, 10)}`, gid, `${first} Staff`],
    );
    const { insertId: staffId } = await db.query(
      `INSERT INTO staff
         (gym_id, gym_membership_id, first_name, last_name, email, profile,
          employment_status, current_status, hire_date)
       VALUES (?, ?, ?, 'Staff', ?, ?, ?, 'available', '2026-01-01')`,
      [
        gid, membershipId, first,
        `${first}.${Math.random().toString(36).slice(2, 7)}@example.com`.toLowerCase(),
        profile, employment,
      ],
    );
    return { membershipId: Number(membershipId), staffId: Number(staffId) };
  }

  beforeAll(async () => {
    dtGymId = await createTestGym('AT Trainer Gym');
    await createTestMembership(dtGymId, 'admin');
    foreignGymId = await createTestGym('AT Trainer Other Gym');

    // Front Desk: an active employee who is not a coach. Assignable since #986.
    ({ membershipId: frontDeskTrainerId } = await createStaffTrainer(dtGymId, 'Ana', 'Front Desk'));
    ({ membershipId: formerStaffTrainerId, staffId: formerStaffId } =
      await createStaffTrainer(dtGymId, 'Bruno', 'Personal Trainer'));
    ({ membershipId: foreignTrainerId } = await createStaffTrainer(foreignGymId, 'Gil', 'Personal Trainer'));
    ({ membershipId: alreadyInactiveTrainerId } =
      await createStaffTrainer(dtGymId, 'Carla', 'Personal Trainer', 'inactive'));
  });

  it('stores an active staff member of any profile and returns their name', async () => {
    const res = await post(dtGymId, {
      name: `DT create ${Date.now()}`, duration_minutes: 45, max_capacity: 10,
      default_trainer_membership_id: frontDeskTrainerId,
    });
    expect(res.status).toBe(201);
    expect(res.body.default_trainer_membership_id).toBe(frontDeskTrainerId);
    expect(res.body.default_trainer_name).toBe('Ana Staff');
  });

  it('refuses a membership from another gym', async () => {
    const res = await post(dtGymId, {
      name: `DT foreign ${Date.now()}`, duration_minutes: 45, max_capacity: 10,
      default_trainer_membership_id: foreignTrainerId,
    });
    expect(res.status).toBe(400);
  });

  it('refuses a value that is not a positive integer', async () => {
    const res = await post(dtGymId, {
      name: `DT bogus ${Date.now()}`, duration_minutes: 45, max_capacity: 10,
      default_trainer_membership_id: 'not-an-id',
    });
    expect(res.status).toBe(400);
  });

  it('clears the trainer on an explicit null', async () => {
    const created = await post(dtGymId, {
      name: `DT clear ${Date.now()}`, duration_minutes: 45, max_capacity: 10,
      default_trainer_membership_id: frontDeskTrainerId,
    });
    const res = await put(dtGymId, created.body.id, { default_trainer_membership_id: null });
    expect(res.status).toBe(200);
    expect(res.body.default_trainer_membership_id).toBeNull();
  });

  // §3: the assignment survives the trainer leaving. Saving an unrelated field
  // resends the stored id, and that is not a new selection.
  it('keeps a stored trainer who is no longer an active staff member', async () => {
    const created = await post(dtGymId, {
      name: `DT keep ${Date.now()}`, duration_minutes: 45, max_capacity: 10,
      default_trainer_membership_id: formerStaffTrainerId,
    });
    expect(created.status).toBe(201);

    await db.query("UPDATE staff SET employment_status = 'inactive' WHERE id = ?", [formerStaffId]);

    const renamed = await put(dtGymId, created.body.id, {
      name: `DT keep renamed ${Date.now()}`,
      default_trainer_membership_id: formerStaffTrainerId,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.default_trainer_membership_id).toBe(formerStaffTrainerId);
  });

  it('refuses newly selecting a trainer who is not an active staff member', async () => {
    const created = await post(dtGymId, {
      name: `DT select inactive ${Date.now()}`, duration_minutes: 45, max_capacity: 10,
    });
    const res = await put(dtGymId, created.body.id, {
      default_trainer_membership_id: alreadyInactiveTrainerId,
    });
    expect(res.status).toBe(400);
  });
});
