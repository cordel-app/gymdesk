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

// Tomorrow's date (YYYY-MM-DD, UTC) — used by the #366 member_ids tests below so the
// materialized occurrence's starts_at is safely in the future regardless of the gym's
// timezone offset (occurrenceDatesForRule only needs start_date >= today in UTC, but
// cancelFutureOccurrences compares the localized starts_at against UTC_TIMESTAMP()).
function tomorrowStr(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function insertTestMember(gymId: string, label: string): Promise<number> {
  const email = `sr-member-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Some Name', ?)`,
    [gymId, email],
  );
  return insertId;
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
    expect(res.body.start_date).toBe('2026-09-01');   // must be YYYY-MM-DD, not an ISO timestamp
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

// ── Happy path: POST weekly (single day) ──────────────────────────────────

describe('POST schedule-rule weekly single-day', () => {
  it('creates a weekly rule with weekdays:[1] and returns 201 with weekdays array', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: '2026-09-01',
        end_date: '2026-12-31',
        weekdays: [1],            // Monday
        start_time: '18:00',
        end_time: '19:00',
      });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('weekly');
    expect(res.body.start_date).toBe('2026-09-01');
    expect(res.body.end_date).toBe('2026-12-31');
    expect(res.body.weekdays).toEqual([1]);
    expect(res.body.start_time).toBe('18:00');
    expect(res.body.end_time).toBe('19:00');
    expect(res.body.activity_type_id).toBe(activityTypeId);
  });

  it('backward-compat: accepts legacy weekday (integer) for weekly and promotes to weekdays array', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: '2026-09-01',
        end_date: '2026-12-31',
        weekday: 3,               // legacy single-field
        start_time: '10:00',
        end_time: '11:00',
      });
    expect(res.status).toBe(201);
    expect(res.body.weekdays).toEqual([3]);
  });
});

// ── Happy path: POST weekly (multi-day) ───────────────────────────────────

describe('POST schedule-rule weekly multi-day', () => {
  let multiRuleId: number;

  it('creates a weekly rule with weekdays:[1,3,5] (Mon/Wed/Fri) and returns 201', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: '2026-09-01',
        end_date: '2026-09-30',
        weekdays: [1, 3, 5],     // Mon, Wed, Fri
        start_time: '09:00',
        end_time: '10:00',
      });
    expect(res.status).toBe(201);
    expect(res.body.weekdays).toEqual([1, 3, 5]);
    multiRuleId = res.body.id;
  });

  it('GET returns the rule with weekdays array', async () => {
    const res = await request
      .get(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const rule = res.body.find((r: any) => r.id === multiRuleId);
    expect(rule).toBeDefined();
    expect(rule.weekdays).toEqual([1, 3, 5]);
  });

  it('PUT updates weekdays (remove Wednesday, keep Mon+Fri)', async () => {
    const res = await request
      .put(`/activity-types/${activityTypeId}/schedule-rules/${multiRuleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: '2026-09-01',
        end_date: '2026-09-30',
        weekdays: [1, 5],         // Mon, Fri only
        start_time: '09:00',
        end_time: '10:00',
      });
    expect(res.status).toBe(200);
    expect(res.body.weekdays).toEqual([1, 5]);
  });

  it('schedule generation: Mon+Wed+Fri rule produces occurrences only on those days', async () => {
    // Create a fresh rule for a specific week
    const createRes = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: '2026-09-07', // week of 7–13 Sep 2026
        end_date: '2026-09-13',
        weekdays: [1, 3, 5],      // Mon=8 Sep, Wed=10 Sep, Fri=12 Sep
        start_time: '07:00',
        end_time: '08:00',
      });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.id;

    // Verify materialized calendar_events for this rule
    const { rows } = await db.query(
      'SELECT DATE(starts_at) AS d FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL ORDER BY starts_at',
      [ruleId],
    );
    const dates = rows.map((r: any) => (r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10)));

    // Must include Mon/Wed/Fri
    expect(dates).toContain('2026-09-07'); // Mon
    expect(dates).toContain('2026-09-09'); // Wed
    expect(dates).toContain('2026-09-11'); // Fri
    // Must not include other days
    expect(dates).not.toContain('2026-09-08'); // Tue
    expect(dates).not.toContain('2026-09-10'); // Thu
    expect(dates).not.toContain('2026-09-12'); // Sat
    expect(dates).not.toContain('2026-09-13'); // Sun
  });

  // #360 stage 3: materialized occurrences are bookable CalendarEvents —
  // kind='session' and capacity backfilled from the activity type.
  it('materialized occurrences carry kind=session and the activity type\'s capacity', async () => {
    const createRes = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: '2026-10-05',
        end_date: '2026-10-11',
        weekdays: [1],
        start_time: '07:00',
        end_time: '08:00',
      });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.id;

    const { rows } = await db.query(
      "SELECT kind, capacity FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL",
      [ruleId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.kind).toBe('session');
      expect(row.capacity).toBe(15); // activityTypeId's max_capacity, set in beforeAll
    }
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
        weekdays: [2],
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
        weekdays: [3],
        start_time: '09:00',
        end_time: '10:00',
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when weekdays is empty for a weekly rule', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: '2026-09-01',
        end_date: '2026-12-31',
        weekdays: [],             // empty — must be rejected
        start_time: '09:00',
        end_time: '10:00',
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when neither weekday nor weekdays is provided for a weekly rule', async () => {
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
        // no weekday or weekdays
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

  it('returns 400 when start_time is in 12h format (e.g. "02:00 PM")', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'one_off',
        start_date: '2026-09-01',
        start_time: '02:00 PM',
        end_time: '04:00 PM',
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when start_time has invalid hours (e.g. "25:00")', async () => {
    const res = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'one_off',
        start_date: '2026-09-01',
        start_time: '25:00',
        end_time: '26:00',
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

// ── #366: member_ids assignment ─────────────────────────────────────────────
// POST/PUT accept an optional `member_ids: number[]` field so staff can assign
// Members to a recurring rule; every materialized occurrence auto-books them
// (force=true — capacity is advisory, never a hard block for a staff assignment).

describe('member_ids assignment (#366)', () => {
  describe('POST with member_ids', () => {
    let memberId: number;
    let ruleId: number;
    let eventId: number;

    it('returns 201 with member_ids echoing what was sent', async () => {
      memberId = await insertTestMember(gymId, 'post-happy');

      const res = await request
        .post(rulesBase(activityTypeId))
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({
          type: 'one_off',
          start_date: tomorrowStr(),
          start_time: '09:00',
          end_time: '10:00',
          member_ids: [memberId],
        });
      expect(res.status).toBe(201);
      expect(res.body.member_ids).toEqual([memberId]);
      ruleId = res.body.id;
    });

    it('materializes a calendar_events row for the rule', async () => {
      const { rows } = await db.query(
        `SELECT id FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
        [ruleId],
      );
      expect(rows.length).toBe(1);
      eventId = rows[0].id;
    });

    it('books the assigned member on the occurrence with status booked (not waitlisted, despite force=true)', async () => {
      const { rows } = await db.query(
        `SELECT status FROM calendar_event_bookings WHERE calendar_event_id = ? AND member_id = ? AND status = 'booked'`,
        [eventId, memberId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('booked');
    });
  });

  describe('capacity is advisory, not blocking, for assigned members', () => {
    it('assigning a member to a rule never returns a capacity-related 4xx, even though force=true is used internally', async () => {
      const memberId = await insertTestMember(gymId, 'advisory-capacity');

      const res = await request
        .post(rulesBase(activityTypeId))
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({
          type: 'one_off',
          start_date: tomorrowStr(),
          start_time: '11:00',
          end_time: '12:00',
          member_ids: [memberId],
        });
      expect(res.status).toBe(201);
      expect(res.body.member_ids).toEqual([memberId]);

      const { rows: eventRows } = await db.query(
        `SELECT id FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
        [res.body.id],
      );
      expect(eventRows.length).toBe(1);

      const { rows: bookingRows } = await db.query(
        `SELECT status FROM calendar_event_bookings WHERE calendar_event_id = ? AND member_id = ?`,
        [eventRows[0].id, memberId],
      );
      expect(bookingRows.length).toBe(1);
      expect(bookingRows[0].status).toBe('booked');
    });
  });

  describe('member_ids validation', () => {
    it('returns 400 when member_ids contains a member id that does not exist in this gym', async () => {
      const res = await request
        .post(rulesBase(activityTypeId))
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({
          type: 'one_off',
          start_date: tomorrowStr(),
          start_time: '13:00',
          end_time: '14:00',
          member_ids: [999999],
        });
      expect(res.status).toBe(400);
    });

    it('returns 400 when member_ids is not an array', async () => {
      const res = await request
        .post(rulesBase(activityTypeId))
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({
          type: 'one_off',
          start_date: tomorrowStr(),
          start_time: '14:00',
          end_time: '15:00',
          member_ids: 'not-an-array',
        });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT updates the assigned set', () => {
    let ruleId: number;
    let memberA: number;
    let memberB: number;
    let oldEventId: number;

    beforeAll(async () => {
      memberA = await insertTestMember(gymId, 'put-a');
      memberB = await insertTestMember(gymId, 'put-b');

      const createRes = await request
        .post(rulesBase(activityTypeId))
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({
          type: 'one_off',
          start_date: tomorrowStr(),
          start_time: '16:00',
          end_time: '17:00',
          member_ids: [memberA],
        });
      expect(createRes.status).toBe(201);
      ruleId = createRes.body.id;

      const { rows } = await db.query(
        `SELECT id FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
        [ruleId],
      );
      expect(rows.length).toBe(1);
      oldEventId = rows[0].id;
    });

    it('PUT with a different member_ids returns the new set', async () => {
      const res = await request
        .put(`/activity-types/${activityTypeId}/schedule-rules/${ruleId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({
          type: 'one_off',
          start_date: tomorrowStr(),
          start_time: '16:00',
          end_time: '17:00',
          member_ids: [memberB],
        });
      expect(res.status).toBe(200);
      expect(res.body.member_ids).toEqual([memberB]);
    });

    it("cancels the old occurrence's booking (member A's old row is soft-cancelled with it)", async () => {
      const { rows } = await db.query(
        `SELECT status, deleted_at FROM calendar_events WHERE id = ?`,
        [oldEventId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('cancelled');
      expect(rows[0].deleted_at).not.toBeNull();
    });

    it('re-materializes a fresh occurrence with only member B booked', async () => {
      const { rows: eventRows } = await db.query(
        `SELECT id FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
        [ruleId],
      );
      expect(eventRows.length).toBe(1);
      const newEventId = eventRows[0].id;
      expect(newEventId).not.toBe(oldEventId);

      const { rows: bookingRows } = await db.query(
        `SELECT member_id, status FROM calendar_event_bookings WHERE calendar_event_id = ? AND status = 'booked'`,
        [newEventId],
      );
      expect(bookingRows.map((r: any) => r.member_id)).toEqual([memberB]);
    });
  });

  describe('PUT omitting member_ids leaves the assignment untouched', () => {
    let ruleId: number;
    let memberC: number;

    beforeAll(async () => {
      memberC = await insertTestMember(gymId, 'omit');

      const createRes = await request
        .post(rulesBase(activityTypeId))
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({
          type: 'one_off',
          start_date: tomorrowStr(),
          start_time: '18:00',
          end_time: '19:00',
          member_ids: [memberC],
        });
      expect(createRes.status).toBe(201);
      ruleId = createRes.body.id;
    });

    it('PUT with no member_ids key still returns 200', async () => {
      const res = await request
        .put(`/activity-types/${activityTypeId}/schedule-rules/${ruleId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({
          type: 'one_off',
          start_date: tomorrowStr(),
          start_time: '18:30',
          end_time: '19:30',
          // member_ids intentionally omitted
        });
      expect(res.status).toBe(200);
    });

    it('GET still shows member C as assigned', async () => {
      const res = await request
        .get(rulesBase(activityTypeId))
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      const rule = res.body.find((r: any) => r.id === ruleId);
      expect(rule).toBeDefined();
      expect(rule.member_ids).toEqual([memberC]);
    });
  });

  describe('GET list includes member_ids', () => {
    it('every rule in the list response has a member_ids array', async () => {
      const res = await request
        .get(rulesBase(activityTypeId))
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      for (const rule of res.body) {
        expect(Array.isArray(rule.member_ids)).toBe(true);
      }
    });
  });
});
