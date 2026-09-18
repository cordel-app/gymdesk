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

/** Upcoming Mon–Sun week whose Monday is today or later (UTC). */
function upcomingMonSunWeek() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysUntilMon = (1 - today.getUTCDay() + 7) % 7; // 0=Sun … 6=Sat; 1=Mon
  const mon = new Date(today);
  mon.setUTCDate(today.getUTCDate() + daysUntilMon);
  const ymd = (offset: number) => {
    const d = new Date(mon);
    d.setUTCDate(mon.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  return {
    start: ymd(0),
    end: ymd(6),
    mon: ymd(0),
    tue: ymd(1),
    wed: ymd(2),
    thu: ymd(3),
    fri: ymd(4),
    sat: ymd(5),
    sun: ymd(6),
  };
}

/** Upcoming Monday (today or later, UTC), optionally shifted by whole weeks —
 * used by the #503 stage 4 end-date-only tests, which need 3+ weekly Mondays
 * in a single rule window. */
function upcomingMonday(offsetWeeks = 0): string {
  const { mon } = upcomingMonSunWeek();
  const d = new Date(`${mon}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetWeeks * 7);
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
    // occurrenceDatesForRule skips dates before today, so the window must be a future week.
    const week = upcomingMonSunWeek();
    const createRes = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: week.start,
        end_date: week.end,
        weekdays: [1, 3, 5], // Mon, Wed, Fri
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

    expect(dates).toContain(week.mon);
    expect(dates).toContain(week.wed);
    expect(dates).toContain(week.fri);
    expect(dates).not.toContain(week.tue);
    expect(dates).not.toContain(week.thu);
    expect(dates).not.toContain(week.sat);
    expect(dates).not.toContain(week.sun);
  });

  // #360 stage 3 / #503 stage 1: materialized occurrences are bookable
  // CalendarEvents — activity_type_id is set and capacity is backfilled
  // from the activity type.
  it('materialized occurrences carry activity_type_id and the activity type\'s capacity', async () => {
    const week = upcomingMonSunWeek();
    const createRes = await request
      .post(rulesBase(activityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: week.start,
        end_date: week.end,
        weekdays: [1],
        start_time: '07:00',
        end_time: '08:00',
      });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.id;

    const { rows } = await db.query(
      "SELECT activity_type_id, capacity FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL",
      [ruleId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.activity_type_id).toBe(activityTypeId);
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

    it('PUT with no member_ids key still returns 200 (window shift needs confirm_cancel_booked since member C is already booked — see #482)', async () => {
      const res = await request
        .put(`/activity-types/${activityTypeId}/schedule-rules/${ruleId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({
          type: 'one_off',
          start_date: tomorrowStr(),
          start_time: '18:30',
          end_time: '19:30',
          confirm_cancel_booked: true,
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

// ── #482: weekly rule slot slicing ──────────────────────────────────────────
// A `weekly` rule's start_time–end_time availability window is sliced into
// activity_types.duration_minutes-sized bookable calendar_events (e.g. Personal
// Training availability), instead of materializing a single event spanning the
// whole window.

describe('weekly rule slot slicing (#482)', () => {
  let slotActivityTypeId: number;

  beforeAll(async () => {
    const res = await request
      .post('/activity-types')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Personal Training SR', duration_minutes: 60, max_capacity: 1, status: 'active' });
    expect(res.status).toBe(201);
    slotActivityTypeId = res.body.id;
  });

  it('slices a 4-hour window into four 60-minute slots', async () => {
    const week = upcomingMonSunWeek();
    const createRes = await request
      .post(rulesBase(slotActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: week.start,
        end_date: week.end,
        weekdays: [1], // Monday
        start_time: '16:00',
        end_time: '20:00',
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.slot_warning).toBeNull();
    const ruleId = createRes.body.id;

    const { rows } = await db.query(
      `SELECT starts_at, ends_at FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL ORDER BY starts_at`,
      [ruleId],
    );
    expect(rows.length).toBe(4);
    // starts_at/ends_at are stored in UTC after timezone conversion; assert
    // consecutive 60-minute boundaries rather than absolute clock times.
    for (let i = 0; i < rows.length; i++) {
      const starts = new Date(rows[i].starts_at).getTime();
      const ends = new Date(rows[i].ends_at).getTime();
      expect(ends - starts).toBe(60 * 60 * 1000);
      if (i > 0) expect(starts).toBe(new Date(rows[i - 1].ends_at).getTime());
    }
  });

  it('drops a non-divisible remainder and returns a slot_warning', async () => {
    const week = upcomingMonSunWeek();
    const createRes = await request
      .post(rulesBase(slotActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: week.start,
        end_date: week.end,
        weekdays: [2], // Tuesday
        start_time: '15:00',
        end_time: '16:30', // 90 minutes / 60-minute duration -> one slot, 30 min dropped
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.slot_warning).toMatch(/doesn't divide evenly/);
    const ruleId = createRes.body.id;

    const { rows } = await db.query(
      `SELECT starts_at, ends_at FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
      [ruleId],
    );
    expect(rows.length).toBe(1);
    const starts = new Date(rows[0].starts_at).getTime();
    const ends = new Date(rows[0].ends_at).getTime();
    expect(ends - starts).toBe(60 * 60 * 1000);
  });

  it('generates zero slots and warns when duration exceeds the window', async () => {
    const week = upcomingMonSunWeek();
    const createRes = await request
      .post(rulesBase(slotActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: week.start,
        end_date: week.end,
        weekdays: [3], // Wednesday
        start_time: '15:00',
        end_time: '15:30', // 30 minutes, shorter than the 60-minute duration
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.slot_warning).toMatch(/longer than this availability window/);
    const ruleId = createRes.body.id;

    const { rows } = await db.query(
      `SELECT id FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
      [ruleId],
    );
    expect(rows.length).toBe(0);
  });

  it('does not slice one_off rules', async () => {
    const res = await request
      .post(rulesBase(slotActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'one_off',
        start_date: tomorrowStr(),
        start_time: '09:00',
        end_time: '11:00', // 120 minutes — would slice into 2 slots if this were weekly
      });
    expect(res.status).toBe(201);
    expect(res.body.slot_warning).toBeNull();

    const { rows } = await db.query(
      `SELECT id FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
      [res.body.id],
    );
    expect(rows.length).toBe(1);
  });

  it('falls back to a single full-window slot when duration_minutes is null (legacy data)', async () => {
    const { insertId: legacyActivityTypeId } = await db.query(
      `INSERT INTO activity_types (gym_id, name, duration_minutes, max_capacity, status) VALUES (?, 'Legacy No-Duration SR', NULL, 10, 'active')`,
      [gymId],
    );

    const week = upcomingMonSunWeek();
    const createRes = await request
      .post(rulesBase(legacyActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: week.start,
        end_date: week.end,
        weekdays: [4], // Thursday
        start_time: '10:00',
        end_time: '11:30',
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.slot_warning).toBeNull();
    const ruleId = createRes.body.id;

    const { rows } = await db.query(
      `SELECT starts_at, ends_at FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
      [ruleId],
    );
    expect(rows.length).toBe(1);
    const starts = new Date(rows[0].starts_at).getTime();
    const ends = new Date(rows[0].ends_at).getTime();
    expect(ends - starts).toBe(90 * 60 * 1000);
  });

  it('re-slices on PUT when the window or duration-relevant fields change', async () => {
    const week = upcomingMonSunWeek();
    const createRes = await request
      .post(rulesBase(slotActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: week.start,
        end_date: week.end,
        weekdays: [5], // Friday
        start_time: '16:00',
        end_time: '18:00', // 2 slots of 60 min
      });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.id;

    const before = await db.query(
      `SELECT id FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
      [ruleId],
    );
    expect(before.rows.length).toBe(2);

    const putRes = await request
      .put(`/activity-types/${slotActivityTypeId}/schedule-rules/${ruleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly',
        start_date: week.start,
        end_date: week.end,
        weekdays: [5],
        start_time: '16:00',
        end_time: '19:00', // now 3 slots of 60 min
      });
    expect(putRes.status).toBe(200);
    expect(putRes.body.slot_warning).toBeNull();

    const after = await db.query(
      `SELECT id FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
      [ruleId],
    );
    expect(after.rows.length).toBe(3);
  });
});

// ── #482: preserving booked occurrences on rule edit/delete ────────────────
// Editing or deleting a schedule rule must never silently cancel an already-
// booked future occurrence. One that no longer fits the new/removed window
// requires explicit staff confirmation (`confirm_cancel_booked`) before
// anything is touched; one that still fits the new window is always
// preserved untouched (never cancelled/regenerated).

async function waitForNotification(memberId: number, entityId: number): Promise<any> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { rows } = await db.query(
      `SELECT * FROM member_notifications WHERE member_id = ? AND type = 'event_cancelled' AND entity_id = ?`,
      [memberId, entityId],
    );
    if (rows.length > 0) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

describe('booked-occurrence preservation on rule edit/delete (#482)', () => {
  let preserveActivityTypeId: number;

  beforeAll(async () => {
    const res = await request
      .post('/activity-types')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Preserve SR', duration_minutes: 60, max_capacity: 10, status: 'active' });
    expect(res.status).toBe(201);
    preserveActivityTypeId = res.body.id;
  });

  it('PUT narrowing/moving the window away from a booked occurrence blocks with 409 and touches nothing', async () => {
    const week = upcomingMonSunWeek();
    const memberId = await insertTestMember(gymId, 'block-put');

    const createRes = await request
      .post(rulesBase(preserveActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [1], start_time: '16:00', end_time: '17:00', // Monday, single 60-min slot
        member_ids: [memberId],
      });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.id;

    const { rows: eventRows } = await db.query(
      `SELECT id FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
      [ruleId],
    );
    expect(eventRows.length).toBe(1);
    const eventId = eventRows[0].id;

    const putRes = await request
      .put(`/activity-types/${preserveActivityTypeId}/schedule-rules/${ruleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [1], start_time: '18:00', end_time: '19:00', // moved away entirely
      });
    expect(putRes.status).toBe(409);
    expect(putRes.body.error).toBe('booked_occurrences_impacted');
    expect(putRes.body.member_count).toBe(1);
    expect(putRes.body.impacted_occurrences).toHaveLength(1);
    expect(putRes.body.impacted_occurrences[0].id).toBe(eventId);

    // Nothing was touched: the rule row and the booked occurrence are unchanged.
    const { rows: ruleRows } = await db.query(
      `SELECT start_time FROM activity_type_schedule_rules WHERE id = ?`,
      [ruleId],
    );
    expect(String(ruleRows[0].start_time).slice(0, 5)).toBe('16:00');

    const { rows: bookingRows } = await db.query(
      `SELECT status FROM calendar_event_bookings WHERE calendar_event_id = ? AND member_id = ?`,
      [eventId, memberId],
    );
    expect(bookingRows[0].status).toBe('booked');
    const { rows: eventAfter } = await db.query(`SELECT status FROM calendar_events WHERE id = ?`, [eventId]);
    expect(eventAfter[0].status).toBe('scheduled');
  });

  it('PUT with confirm_cancel_booked:true proceeds, cancels the impacted occurrence, and notifies the affected member', async () => {
    const week = upcomingMonSunWeek();
    const memberId = await insertTestMember(gymId, 'confirm-put');

    const createRes = await request
      .post(rulesBase(preserveActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [2], start_time: '16:00', end_time: '17:00', // Tuesday
        member_ids: [memberId],
      });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.id;

    const { rows: eventRows } = await db.query(
      `SELECT id FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
      [ruleId],
    );
    const eventId = eventRows[0].id;

    const putRes = await request
      .put(`/activity-types/${preserveActivityTypeId}/schedule-rules/${ruleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [2], start_time: '18:00', end_time: '19:00',
        confirm_cancel_booked: true,
      });
    expect(putRes.status).toBe(200);

    const { rows: eventAfter } = await db.query(
      `SELECT status, deleted_at FROM calendar_events WHERE id = ?`,
      [eventId],
    );
    expect(eventAfter[0].status).toBe('cancelled');
    expect(eventAfter[0].deleted_at).not.toBeNull();

    const notification = await waitForNotification(memberId, eventId);
    expect(notification).not.toBeNull();
    expect(notification.entity_type).toBe('session');
  });

  it('PUT widening the window around a booked occurrence preserves it untouched — no confirmation needed, no duplicate slot', async () => {
    const week = upcomingMonSunWeek();
    const memberId = await insertTestMember(gymId, 'preserve-put');

    const createRes = await request
      .post(rulesBase(preserveActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [3], start_time: '16:00', end_time: '17:00', // Wednesday, single 60-min slot
        member_ids: [memberId],
      });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.id;

    const { rows: before } = await db.query(
      `SELECT id, starts_at FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
      [ruleId],
    );
    expect(before.length).toBe(1);
    const preservedEventId = before[0].id;
    const preservedStartsAt = before[0].starts_at;

    // Widen 16:00–17:00 to 15:00–18:00: the booked 16:00–17:00 slot still fits,
    // so it must not be cancelled/regenerated — no confirm_cancel_booked needed.
    const putRes = await request
      .put(`/activity-types/${preserveActivityTypeId}/schedule-rules/${ruleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [3], start_time: '15:00', end_time: '18:00',
      });
    expect(putRes.status).toBe(200);

    const { rows: after } = await db.query(
      `SELECT id, starts_at, status, deleted_at FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL ORDER BY starts_at`,
      [ruleId],
    );
    // 3 slots total (15–16, 16–17, 17–18); the middle one is the exact same
    // preserved row (same id), not a freshly regenerated duplicate.
    expect(after.length).toBe(3);
    const preserved = after.find((r: any) => r.id === preservedEventId);
    expect(preserved).toBeDefined();
    expect(preserved.status).toBe('scheduled');
    expect(new Date(preserved.starts_at).getTime()).toBe(new Date(preservedStartsAt).getTime());
    // No other row shares its exact start time (dedup — no overlapping duplicate slot).
    const sameStart = after.filter((r: any) => new Date(r.starts_at).getTime() === new Date(preservedStartsAt).getTime());
    expect(sameStart.length).toBe(1);

    const { rows: bookingRows } = await db.query(
      `SELECT status FROM calendar_event_bookings WHERE calendar_event_id = ? AND member_id = ?`,
      [preservedEventId, memberId],
    );
    expect(bookingRows[0].status).toBe('booked');
  });

  it('DELETE with a booked future occurrence blocks with 409 unless ?confirm_cancel_booked=true, then notifies on confirm', async () => {
    const week = upcomingMonSunWeek();
    const memberId = await insertTestMember(gymId, 'delete-guard');

    const createRes = await request
      .post(rulesBase(preserveActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [4], start_time: '16:00', end_time: '17:00', // Thursday
        member_ids: [memberId],
      });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.id;

    const { rows: eventRows } = await db.query(
      `SELECT id FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
      [ruleId],
    );
    const eventId = eventRows[0].id;

    const blockedRes = await request
      .delete(`/activity-types/${preserveActivityTypeId}/schedule-rules/${ruleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(blockedRes.status).toBe(409);
    expect(blockedRes.body.error).toBe('booked_occurrences_impacted');

    const { rows: ruleStillThere } = await db.query(
      `SELECT id FROM activity_type_schedule_rules WHERE id = ?`,
      [ruleId],
    );
    expect(ruleStillThere.length).toBe(1);

    const confirmedRes = await request
      .delete(`/activity-types/${preserveActivityTypeId}/schedule-rules/${ruleId}?confirm_cancel_booked=true`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(confirmedRes.status).toBe(204);

    const { rows: ruleGone } = await db.query(
      `SELECT id FROM activity_type_schedule_rules WHERE id = ?`,
      [ruleId],
    );
    expect(ruleGone.length).toBe(0);

    const { rows: eventAfter } = await db.query(
      `SELECT status, deleted_at FROM calendar_events WHERE id = ?`,
      [eventId],
    );
    expect(eventAfter[0].status).toBe('cancelled');
    expect(eventAfter[0].deleted_at).not.toBeNull();

    const notification = await waitForNotification(memberId, eventId);
    expect(notification).not.toBeNull();
  });

  it('DELETE with no booked occurrences proceeds immediately without confirmation', async () => {
    const week = upcomingMonSunWeek();
    const createRes = await request
      .post(rulesBase(preserveActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [5], start_time: '16:00', end_time: '17:00', // Friday, unbooked
      });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.id;

    const res = await request
      .delete(`/activity-types/${preserveActivityTypeId}/schedule-rules/${ruleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });
});

// ── #503 stage 4: end-date-only edits diff surgically ───────────────────────
// Changing *only* a recurring rule's end_date must never cancel-and-regenerate
// occurrences that stay in range (booked or not) — only occurrences the new
// end_date actually excludes are removed, and only with confirmation when any
// of them are booked. This is distinct from the general #482 window-change
// path above, which regenerates every non-preserved future occurrence.

describe('end-date-only diffing (#503 stage 4)', () => {
  let endDateActivityTypeId: number;

  beforeAll(async () => {
    const res = await request
      .post('/activity-types')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'End Date SR', duration_minutes: 60, max_capacity: 10, status: 'active' });
    expect(res.status).toBe(201);
    endDateActivityTypeId = res.body.id;
  });

  it('PUT extending end_date only adds the new occurrences — the existing booked occurrence keeps its row untouched, no confirmation needed', async () => {
    const mon1 = upcomingMonday(0);
    const memberId = await insertTestMember(gymId, 'extend-end-date');

    const createRes = await request
      .post(rulesBase(endDateActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: mon1, end_date: mon1, // single Monday occurrence
        weekdays: [1], start_time: '09:00', end_time: '10:00',
        member_ids: [memberId],
      });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.id;

    const { rows: before } = await db.query(
      `SELECT id, starts_at FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL`,
      [ruleId],
    );
    expect(before.length).toBe(1);
    const originalEventId = before[0].id;
    const originalStartsAt = before[0].starts_at;

    const putRes = await request
      .put(`/activity-types/${endDateActivityTypeId}/schedule-rules/${ruleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: mon1, end_date: upcomingMonday(2), // adds week 2 and week 3
        weekdays: [1], start_time: '09:00', end_time: '10:00',
      });
    expect(putRes.status).toBe(200);

    const { rows: after } = await db.query(
      `SELECT id, starts_at, status, deleted_at FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL ORDER BY starts_at`,
      [ruleId],
    );
    expect(after.length).toBe(3);
    const originalRow = after.find((r: any) => r.id === originalEventId);
    expect(originalRow).toBeDefined();
    expect(originalRow.status).toBe('scheduled');
    expect(new Date(originalRow.starts_at).getTime()).toBe(new Date(originalStartsAt).getTime());

    const { rows: bookingRows } = await db.query(
      `SELECT status FROM calendar_event_bookings WHERE calendar_event_id = ? AND member_id = ?`,
      [originalEventId, memberId],
    );
    expect(bookingRows[0].status).toBe('booked');
  });

  it('PUT shortening end_date with no bookings on the removed occurrences proceeds without confirmation, leaving the in-range occurrence untouched', async () => {
    const mon1 = upcomingMonday(0);

    const createRes = await request
      .post(rulesBase(endDateActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: mon1, end_date: upcomingMonday(2), // 3 Mondays, unbooked
        weekdays: [1], start_time: '11:00', end_time: '12:00',
      });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.id;

    const { rows: before } = await db.query(
      `SELECT id, starts_at FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL ORDER BY starts_at`,
      [ruleId],
    );
    expect(before.length).toBe(3);
    const keptEventId = before[0].id;
    const keptStartsAt = before[0].starts_at;
    const removedIds = [before[1].id, before[2].id];

    const putRes = await request
      .put(`/activity-types/${endDateActivityTypeId}/schedule-rules/${ruleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: mon1, end_date: mon1, // shrink to only the first Monday
        weekdays: [1], start_time: '11:00', end_time: '12:00',
      });
    expect(putRes.status).toBe(200);

    const { rows: keptAfter } = await db.query(
      `SELECT starts_at, status, deleted_at FROM calendar_events WHERE id = ?`,
      [keptEventId],
    );
    expect(keptAfter[0].status).toBe('scheduled');
    expect(keptAfter[0].deleted_at).toBeNull();
    expect(new Date(keptAfter[0].starts_at).getTime()).toBe(new Date(keptStartsAt).getTime());

    const { rows: removedAfter } = await db.query(
      `SELECT status, deleted_at FROM calendar_events WHERE id IN (?, ?)`,
      removedIds,
    );
    expect(removedAfter).toHaveLength(2);
    for (const row of removedAfter) {
      expect(row.status).toBe('cancelled');
      expect(row.deleted_at).not.toBeNull();
    }
  });

  it('PUT shortening end_date that would remove booked occurrences blocks with 409 and touches nothing; confirming removes only the excluded occurrences and notifies the member', async () => {
    const mon1 = upcomingMonday(0);
    const memberId = await insertTestMember(gymId, 'shrink-end-date');

    const createRes = await request
      .post(rulesBase(endDateActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: mon1, end_date: upcomingMonday(2), // 3 Mondays
        weekdays: [1], start_time: '13:00', end_time: '14:00',
        member_ids: [memberId], // auto-books all 3 occurrences
      });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.id;

    const { rows: eventRows } = await db.query(
      `SELECT id, starts_at FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL ORDER BY starts_at`,
      [ruleId],
    );
    expect(eventRows.length).toBe(3);
    const keptEventId = eventRows[0].id;
    const removedIds = [eventRows[1].id, eventRows[2].id];

    const blockedRes = await request
      .put(`/activity-types/${endDateActivityTypeId}/schedule-rules/${ruleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: mon1, end_date: mon1, // shrink to only the first Monday
        weekdays: [1], start_time: '13:00', end_time: '14:00',
      });
    expect(blockedRes.status).toBe(409);
    expect(blockedRes.body.error).toBe('booked_occurrences_impacted');
    expect(blockedRes.body.member_count).toBe(1);
    expect(blockedRes.body.impacted_occurrences).toHaveLength(2);

    // Nothing touched yet — including the in-range occurrence.
    const { rows: untouched } = await db.query(
      `SELECT status FROM calendar_events WHERE id IN (?, ?, ?)`,
      [keptEventId, ...removedIds],
    );
    expect(untouched.every((r: any) => r.status === 'scheduled')).toBe(true);

    const confirmRes = await request
      .put(`/activity-types/${endDateActivityTypeId}/schedule-rules/${ruleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: mon1, end_date: mon1,
        weekdays: [1], start_time: '13:00', end_time: '14:00',
        confirm_cancel_booked: true,
      });
    expect(confirmRes.status).toBe(200);

    const { rows: keptAfter } = await db.query(
      `SELECT status, deleted_at FROM calendar_events WHERE id = ?`,
      [keptEventId],
    );
    expect(keptAfter[0].status).toBe('scheduled');
    expect(keptAfter[0].deleted_at).toBeNull();

    const { rows: removedAfter } = await db.query(
      `SELECT status, deleted_at FROM calendar_events WHERE id IN (?, ?)`,
      removedIds,
    );
    for (const row of removedAfter) {
      expect(row.status).toBe('cancelled');
      expect(row.deleted_at).not.toBeNull();
    }

    for (const removedId of removedIds) {
      const notification = await waitForNotification(memberId, removedId);
      expect(notification).not.toBeNull();
    }
  });
});

// ── #482: overlap warnings between rules (same space/trainer) ──────────────
// activity_type_schedule_rules has no space/trainer of its own — both are
// inherited from the parent Activity Type's default_space_id /
// default_trainer_membership_id. A non-blocking `overlap_warning` is surfaced
// on POST/PUT when another rule in the gym, resolving to the same space or
// trainer, has a weekday+time window that overlaps this one.

describe('overlap warnings between rules (#482)', () => {
  let spaceId: number;
  let trainerMembershipId: number;
  let spaceActivityTypeA: number;
  let spaceActivityTypeB: number;
  let trainerActivityTypeC: number;
  let trainerActivityTypeD: number;
  let unrelatedActivityTypeId: number;

  beforeAll(async () => {
    const { insertId: centerId } = await db.query(
      `INSERT INTO centers (gym_id, name) VALUES (?, 'Overlap Test Center')`,
      [gymId],
    );

    const spaceRes = await request
      .post('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Overlap Test Space', capacity: 4, center_id: centerId });
    expect(spaceRes.status).toBe(201);
    spaceId = spaceRes.body.id;

    const trainerUserId = `overlap-trainer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await createTestMembership(gymId, 'trainer_performance', trainerUserId);
    const { rows: trainerRows } = await db.query(
      `SELECT id FROM gym_memberships WHERE gym_id = ? AND user_id = ?`,
      [gymId, trainerUserId],
    );
    trainerMembershipId = trainerRows[0].id;

    const makeActivityType = async (name: string, extra: Record<string, unknown>) => {
      const res = await request
        .post('/activity-types')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name, duration_minutes: 60, max_capacity: 10, status: 'active', ...extra });
      expect(res.status).toBe(201);
      return res.body.id as number;
    };

    spaceActivityTypeA = await makeActivityType('Overlap Space A', { default_space_id: spaceId });
    spaceActivityTypeB = await makeActivityType('Overlap Space B', { default_space_id: spaceId });
    trainerActivityTypeC = await makeActivityType('Overlap Trainer C', { default_trainer_membership_id: trainerMembershipId });
    trainerActivityTypeD = await makeActivityType('Overlap Trainer D', { default_trainer_membership_id: trainerMembershipId });
    unrelatedActivityTypeId = await makeActivityType('Overlap Unrelated', {});
  });

  it('POST with no other rules yet returns overlap_warning: null', async () => {
    const week = upcomingMonSunWeek();
    const res = await request
      .post(rulesBase(spaceActivityTypeA))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [1], start_time: '16:00', end_time: '17:00', // Monday
      });
    expect(res.status).toBe(201);
    expect(res.body.overlap_warning).toBeNull();
  });

  it('POST a rule on another Activity Type sharing the same space, at an overlapping time, warns', async () => {
    const week = upcomingMonSunWeek();
    const res = await request
      .post(rulesBase(spaceActivityTypeB))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [1], start_time: '16:30', end_time: '17:30', // Monday, overlaps 16:00–17:00
      });
    expect(res.status).toBe(201);
    expect(res.body.overlap_warning).toContain('same space');
    expect(res.body.overlap_warning).toContain('Overlap Space A');
  });

  it('POST a rule on the same space Activity Type but a non-overlapping time does not warn', async () => {
    const week = upcomingMonSunWeek();
    const res = await request
      .post(rulesBase(spaceActivityTypeB))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [1], start_time: '20:00', end_time: '21:00', // Monday, after both existing windows
      });
    expect(res.status).toBe(201);
    expect(res.body.overlap_warning).toBeNull();
  });

  it('POST a rule on the same space Activity Type but a different weekday does not warn', async () => {
    const week = upcomingMonSunWeek();
    const res = await request
      .post(rulesBase(spaceActivityTypeB))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [3], start_time: '16:00', end_time: '17:00', // Wednesday — A only runs Monday
      });
    expect(res.status).toBe(201);
    expect(res.body.overlap_warning).toBeNull();
  });

  it('POST a rule on another Activity Type sharing the same trainer, at an overlapping time, warns', async () => {
    const week = upcomingMonSunWeek();
    const createC = await request
      .post(rulesBase(trainerActivityTypeC))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [2], start_time: '10:00', end_time: '11:00', // Tuesday
      });
    expect(createC.status).toBe(201);
    expect(createC.body.overlap_warning).toBeNull();

    const createD = await request
      .post(rulesBase(trainerActivityTypeD))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [2], start_time: '10:30', end_time: '11:30', // Tuesday, overlaps
      });
    expect(createD.status).toBe(201);
    expect(createD.body.overlap_warning).toContain('same trainer');
    expect(createD.body.overlap_warning).toContain('Overlap Trainer C');
  });

  it('POST a rule on an Activity Type with no default space/trainer never warns', async () => {
    const week = upcomingMonSunWeek();
    const res = await request
      .post(rulesBase(unrelatedActivityTypeId))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [1], start_time: '16:00', end_time: '17:00', // same day/time as spaceActivityTypeA's rule
      });
    expect(res.status).toBe(201);
    expect(res.body.overlap_warning).toBeNull();
  });

  it('PUT moving a rule into an overlapping window surfaces overlap_warning', async () => {
    const week = upcomingMonSunWeek();
    const createRes = await request
      .post(rulesBase(spaceActivityTypeB))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [4], start_time: '09:00', end_time: '10:00', // Thursday, no conflict yet
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.overlap_warning).toBeNull();
    const ruleId = createRes.body.id;

    const putRes = await request
      .put(`/activity-types/${spaceActivityTypeB}/schedule-rules/${ruleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [1], start_time: '16:00', end_time: '17:00', // moved onto Activity Type A's Monday window
      });
    expect(putRes.status).toBe(200);
    expect(putRes.body.overlap_warning).toContain('same space');
    expect(putRes.body.overlap_warning).toContain('Overlap Space A');
  });

  it('PUT does not warn about a rule overlapping only itself', async () => {
    const week = upcomingMonSunWeek();
    const createRes = await request
      .post(rulesBase(trainerActivityTypeC))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [5], start_time: '12:00', end_time: '13:00', // Friday, isolated
      });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.id;

    const putRes = await request
      .put(`/activity-types/${trainerActivityTypeC}/schedule-rules/${ruleId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        type: 'weekly', start_date: week.start, end_date: week.end,
        weekdays: [5], start_time: '12:00', end_time: '13:30', // same rule, slightly widened
      });
    expect(putRes.status).toBe(200);
    expect(putRes.body.overlap_warning).toBeNull();
  });
});
