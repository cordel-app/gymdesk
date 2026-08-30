// Tests for activity-type-schedule-rules.ts router

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

function rulesBase(atId: number) {
  return `/activity-types/${atId}/schedule-rules`;
}

beforeAll(async () => {
  gymId = await createTestGym('SR Test Gym');
  await createTestMembership(gymId, 'admin');

  // Create an activity type via the API to use as the parent for schedule-rules tests
  const res = await request
    .post('/activity-types')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ name: 'Pilates SR', duration_minutes: 45, max_capacity: 15, status: 'active' });
  expect(res.status).toBe(201);
  activityTypeId = res.body.id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ── Auth guard ─────────────────────────────────────────────────────────────

describe('auth guard', () => {
  it('returns 401 without auth on GET schedule-rules', async () => {
    const res = await request
      .get(rulesBase(activityTypeId))
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 401 without auth on POST schedule-rule', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('x-gym-id', gymId)
      .send({ type: 'one_off', start_date: '2026-09-01', start_time: '09:00', end_time: '10:00' });
    expect(res.status).toBe(401);
  });
});

// ── Tenant isolation ───────────────────────────────────────────────────────

describe('tenant isolation', () => {
  it('returns 403 when user has no membership in the requested gym', async () => {
    const otherGymId = await createTestGym('SR Other Gym');
    // TEST_USER_ID has no membership in otherGymId
    const res = await request
      .get(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(403);
  });

  it('returns 404 when the activity type belongs to a different gym', async () => {
    const gymA = await createTestGym('SR Gym A');
    const gymB = await createTestGym('SR Gym B');
    await createTestMembership(gymA, 'admin');
    await createTestMembership(gymB, 'admin');

    // Create activity type in gym A, access its rules via gym B
    const createRes = await request
      .post('/activity-types')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ name: 'Cross-Tenant SR', duration_minutes: 30, max_capacity: 10 });
    expect(createRes.status).toBe(201);
    const crossId = createRes.body.id;

    const res = await request
      .get(rulesBase(crossId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });
});

// ── Role guard ─────────────────────────────────────────────────────────────

describe('role guard', () => {
  let fdGymId: string;
  let fdActivityTypeId: number;

  beforeAll(async () => {
    fdGymId = await createTestGym('SR FD Gym');
    await createTestMembership(fdGymId, 'front_desk');
    // Insert activity type directly since front_desk cannot POST via the API
    const { insertId } = await db.query(
      `INSERT INTO activity_types (gym_id, name, duration_minutes, max_capacity, status)
       VALUES (?, 'FD AT SR', 30, 10, 'active')`,
      [fdGymId],
    );
    fdActivityTypeId = insertId;
  });

  it('returns 403 when front_desk user tries to POST a schedule rule', async () => {
    const res = await request
      .post(rulesBase(fdActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', fdGymId)
      .send({ type: 'one_off', start_date: '2026-09-01', start_time: '09:00', end_time: '10:00' });
    expect(res.status).toBe(403);
  });

  it('allows front_desk user to GET schedule rules (read access)', async () => {
    const res = await request
      .get(rulesBase(fdActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', fdGymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── Happy path: GET / ──────────────────────────────────────────────────────

describe('GET schedule-rules', () => {
  it('returns 200 with an array', async () => {
    const res = await request
      .get(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns 404 when activity type does not exist', async () => {
    const res = await request
      .get(rulesBase(999999))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ── Happy path: POST one_off ───────────────────────────────────────────────

describe('POST schedule-rule one_off', () => {
  let ruleId: number;

  it('creates a one_off rule and returns 201 with correct shape', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'one_off',
        start_date: '2026-09-01',
        start_time: '09:00',
        end_time: '10:00',
      });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('one_off');
    expect(res.body.start_time).toBe('09:00');
    expect(res.body.end_time).toBe('10:00');
    expect(res.body.activity_type_id).toBe(activityTypeId);
    expect(res.body.gym_id).toBe(gymId);
    expect(res.body.end_date).toBeNull();
    expect(res.body.weekday).toBeNull();
    ruleId = res.body.id;
  });

  it('rule appears in GET /', async () => {
    const res = await request
      .get(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain(ruleId);
  });
});

// ── Happy path: POST weekly ────────────────────────────────────────────────

describe('POST schedule-rule weekly', () => {
  it('creates a weekly rule with weekday, start_date, end_date and returns 201', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: '2026-09-01',
        end_date: '2026-12-31',   // within 1 year of start_date
        weekday: 1,               // Monday
        start_time: '18:00',
        end_time: '19:00',
      });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('weekly');
    expect(res.body.weekday).toBe(1);
    expect(res.body.start_time).toBe('18:00');
    expect(res.body.end_time).toBe('19:00');
    expect(res.body.activity_type_id).toBe(activityTypeId);
  });
});

// ── Validation ─────────────────────────────────────────────────────────────

describe('validation', () => {
  it('returns 400 when end_date is missing for a weekly rule', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: '2026-09-01',
        weekday: 2,
        start_time: '09:00',
        end_time: '10:00',
        // end_date intentionally omitted
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when end_date is more than 1 year after start_date', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: '2026-09-01',
        end_date: '2027-10-01',   // > 1 year after start_date (2027-09-01 limit)
        weekday: 3,
        start_time: '09:00',
        end_time: '10:00',
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when weekday is missing for a weekly rule', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: '2026-09-01',
        end_date: '2026-12-31',
        start_time: '09:00',
        end_time: '10:00',
        // weekday intentionally omitted
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when start_time is missing', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'one_off',
        start_date: '2026-09-01',
        end_time: '10:00',
        // start_time intentionally omitted
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when end_time is not after start_time', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'one_off',
        start_date: '2026-09-01',
        start_time: '10:00',
        end_time: '09:00',  // before start_time
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when type is invalid', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'invalid_type',
        start_date: '2026-09-01',
        start_time: '09:00',
        end_time: '10:00',
      });
    expect(res.status).toBe(400);
  });
});

// ── Happy path: PUT and DELETE ─────────────────────────────────────────────

describe('PUT and DELETE schedule rule', () => {
  let ruleId: number;

  beforeAll(async () => {
    // Create a dedicated rule for PUT/DELETE tests
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'one_off',
        start_date: '2026-11-01',
        start_time: '14:00',
        end_time: '15:00',
      });
    expect(res.status).toBe(201);
    ruleId = res.body.id;
  });

  it('PUT /:ruleId returns 200 with the updated rule', async () => {
    const res = await request
      .put(`/activity-types/${activityTypeId}/schedule-rules/${ruleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'one_off',
        start_date: '2026-11-15',
        start_time: '10:00',
        end_time: '11:30',
      });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ruleId);
    expect(res.body.start_time).toBe('10:00');
    expect(res.body.end_time).toBe('11:30');
  });

  it('PUT /:ruleId returns 404 for a non-existent rule', async () => {
    const res = await request
      .put(`/activity-types/${activityTypeId}/schedule-rules/999999`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'one_off',
        start_date: '2026-11-15',
        start_time: '10:00',
        end_time: '11:00',
      });
    expect(res.status).toBe(404);
  });

  it('DELETE /:ruleId returns 204', async () => {
    const res = await request
      .delete(`/activity-types/${activityTypeId}/schedule-rules/${ruleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('deleted rule no longer appears in GET /', async () => {
    const res = await request
      .get(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).not.toContain(ruleId);
  });

  it('DELETE /:ruleId returns 404 for a non-existent rule', async () => {
    const res = await request
      .delete(`/activity-types/${activityTypeId}/schedule-rules/999999`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
