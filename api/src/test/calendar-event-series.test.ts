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
let otherGymId: string;

beforeAll(async () => {
  gymId = await createTestGym('CalSeriesGym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('OtherGym');
  await createTestMembership(otherGymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ── Auth guards ───────────────────────────────────────────────────────────────

describe('Auth guards', () => {
  it('GET /calendar-event-series returns 401 without auth', async () => {
    const res = await request.get('/calendar-event-series').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('GET /calendar-events returns 401 without auth', async () => {
    const res = await request.get('/calendar-events').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});

// ── Recurring series creation ─────────────────────────────────────────────────

describe('POST /calendar-events with recurrence', () => {
  it('creates a weekly series and generates occurrences', async () => {
    const res = await request.post('/calendar-events')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        title: 'Hyrox',
        starts_at: '2026-09-07T10:00:00', // a Sunday
        ends_at:   '2026-09-07T11:00:00',
        recurrence: {
          type: 'weekly',
          interval: 1,
          weekdays: 'Mon,Wed,Fri',
          end_type: 'on_date',
          end_date: '2026-09-30',
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.series).toBeDefined();
    expect(res.body.firstEvent).toBeDefined();
    expect(res.body.count).toBeGreaterThan(0);

    // Verify occurrences are Mon/Wed/Fri only
    const { rows } = await db.query(
      `SELECT DAYOFWEEK(starts_at) AS dow FROM calendar_events
       WHERE series_id = ? AND gym_id = ? ORDER BY starts_at`,
      [res.body.series.id, gymId],
    );
    const dows = rows.map((r: any) => r.dow);
    // MySQL DAYOFWEEK: 1=Sun, 2=Mon, 4=Wed, 6=Fri
    for (const dow of dows) {
      expect([2, 4, 6]).toContain(dow);
    }
  });

  it('creates a daily series (after_n occurrences)', async () => {
    const res = await request.post('/calendar-events')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        title: 'Morning Run',
        starts_at: '2026-10-01T06:00:00',
        ends_at:   '2026-10-01T06:30:00',
        recurrence: {
          type: 'daily',
          interval: 1,
          end_type: 'after_n',
          end_count: 5,
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(5);

    const { rows } = await db.query(
      'SELECT COUNT(*) AS cnt FROM calendar_events WHERE series_id = ? AND gym_id = ?',
      [res.body.series.id, gymId],
    );
    expect(rows[0].cnt).toBe(5);
  });

  it('returns 400 when recurrence produces no occurrences', async () => {
    const res = await request.post('/calendar-events')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        title: 'Empty',
        starts_at: '2026-12-31T10:00:00',
        ends_at:   '2026-12-31T11:00:00',
        recurrence: {
          type: 'weekly',
          interval: 1,
          weekdays: 'Mon',
          end_type: 'on_date',
          end_date: '2026-12-30', // end_date before start_date
        },
      });
    expect(res.status).toBe(400);
  });
});

// ── GET /calendar-event-series ────────────────────────────────────────────────

describe('GET /calendar-event-series/:id', () => {
  let seriesId: number;

  beforeAll(async () => {
    const res = await request.post('/calendar-events')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        title: 'Yoga',
        starts_at: '2026-11-04T08:00:00',
        ends_at:   '2026-11-04T09:00:00',
        recurrence: { type: 'weekly', interval: 1, weekdays: 'Tue,Thu', end_type: 'never' },
      });
    seriesId = res.body.series.id;
  });

  it('returns the series definition', async () => {
    const res = await request.get(`/calendar-event-series/${seriesId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.recurrence_type).toBe('weekly');
    expect(res.body.weekdays).toBe('Tue,Thu');
  });

  it('returns 404 for another gym (tenant isolation)', async () => {
    const res = await request.get(`/calendar-event-series/${seriesId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(404);
  });
});

// ── Scope: this ───────────────────────────────────────────────────────────────

describe('PUT /calendar-events/:id scope=this', () => {
  let seriesId: number;
  let eventIds: number[];

  beforeAll(async () => {
    const res = await request.post('/calendar-events')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        title: 'Pilates',
        starts_at: '2026-09-14T09:00:00',
        ends_at:   '2026-09-14T10:00:00',
        recurrence: { type: 'weekly', interval: 1, weekdays: 'Mon', end_type: 'after_n', end_count: 4 },
      });
    seriesId = res.body.series.id;
    const { rows } = await db.query(
      'SELECT id FROM calendar_events WHERE series_id = ? AND gym_id = ? ORDER BY starts_at',
      [seriesId, gymId],
    );
    eventIds = rows.map((r: any) => r.id);
  });

  it('updates only the target event; siblings unchanged', async () => {
    const targetId = eventIds[1];
    const res = await request.put(`/calendar-events/${targetId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ title: 'Pilates (Special)', scope: 'this' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Pilates (Special)');

    // Siblings should still have original title
    const sibling = await request.get(`/calendar-events/${eventIds[0]}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(sibling.body.title).toBe('Pilates');
  });
});

// ── Scope: this_and_following ─────────────────────────────────────────────────

describe('PUT /calendar-events/:id scope=this_and_following', () => {
  let seriesId: number;
  let eventIds: number[];

  beforeAll(async () => {
    const res = await request.post('/calendar-events')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        title: 'Boxing',
        starts_at: '2026-09-07T07:00:00',
        ends_at:   '2026-09-07T08:00:00',
        recurrence: { type: 'weekly', interval: 1, weekdays: 'Mon', end_type: 'after_n', end_count: 4 },
      });
    seriesId = res.body.series.id;
    const { rows } = await db.query(
      'SELECT id FROM calendar_events WHERE series_id = ? AND gym_id = ? ORDER BY starts_at',
      [seriesId, gymId],
    );
    eventIds = rows.map((r: any) => r.id);
  });

  it('splits the series at the selected event', async () => {
    const targetId = eventIds[2]; // 3rd occurrence
    const res = await request.put(`/calendar-events/${targetId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        title: 'Boxing Advanced',
        scope: 'this_and_following',
        recurrence: { type: 'weekly', interval: 1, weekdays: 'Mon', end_type: 'after_n', end_count: 3 },
      });
    expect(res.status).toBe(200);

    // Past events from original series should still exist
    const past = await request.get(`/calendar-events/${eventIds[0]}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(past.body.title).toBe('Boxing');

    // Original series end_date should be truncated
    const { rows: sr } = await db.query(
      "SELECT end_type FROM calendar_event_series WHERE id = ? AND gym_id = ?",
      [seriesId, gymId],
    );
    expect(sr[0].end_type).toBe('on_date');
  });
});

// ── Scope: entire_series ──────────────────────────────────────────────────────

describe('PUT /calendar-events/:id scope=entire_series', () => {
  let seriesId: number;
  let firstPastEventId: number;
  let futureEventId: number;

  beforeAll(async () => {
    // Create events with a past start so some are "past"
    const res = await request.post('/calendar-events')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        title: 'Crossfit',
        starts_at: '2025-01-06T06:00:00',
        ends_at:   '2025-01-06T07:00:00',
        recurrence: { type: 'weekly', interval: 1, weekdays: 'Mon', end_type: 'after_n', end_count: 4 },
      });
    seriesId = res.body.series.id;
    const { rows } = await db.query(
      'SELECT id FROM calendar_events WHERE series_id = ? AND gym_id = ? ORDER BY starts_at',
      [seriesId, gymId],
    );
    firstPastEventId = rows[0].id;
    futureEventId = rows[rows.length - 1].id;
  });

  it('updates the series metadata; past events untouched', async () => {
    const res = await request.put(`/calendar-events/${futureEventId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ title: 'Crossfit Pro', scope: 'entire_series' });
    expect(res.status).toBe(200);

    // Past event must remain unchanged
    const past = await request.get(`/calendar-events/${firstPastEventId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    // Past event is immutable — title must not have changed to 'Crossfit Pro'
    expect(past.body.title).toBe('Crossfit');

    // Series definition updated
    const series = await request.get(`/calendar-event-series/${seriesId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(series.body.title).toBe('Crossfit Pro');
  });
});

// ── DELETE scopes ─────────────────────────────────────────────────────────────

describe('DELETE /calendar-events/:id', () => {
  let seriesId: number;
  let eventIds: number[];

  beforeAll(async () => {
    const res = await request.post('/calendar-events')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        title: 'Zumba',
        starts_at: '2026-10-05T18:00:00',
        ends_at:   '2026-10-05T19:00:00',
        recurrence: { type: 'weekly', interval: 1, weekdays: 'Mon', end_type: 'after_n', end_count: 4 },
      });
    seriesId = res.body.series.id;
    const { rows } = await db.query(
      'SELECT id FROM calendar_events WHERE series_id = ? AND gym_id = ? ORDER BY starts_at',
      [seriesId, gymId],
    );
    eventIds = rows.map((r: any) => r.id);
  });

  it('scope=this cancels only the target (keeps it visible as cancelled)', async () => {
    const res = await request.delete(`/calendar-events/${eventIds[0]}?scope=this`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(204);

    // Event still visible (not deleted), but cancelled
    const check = await request.get(`/calendar-events/${eventIds[0]}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(check.status).toBe(200);
    expect(check.body.status).toBe('cancelled');

    // Sibling should still be scheduled
    const sibling = await request.get(`/calendar-events/${eventIds[1]}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(sibling.body.status).toBe('scheduled');
  });

  it('scope=entire_series soft-deletes the series', async () => {
    const res = await request.delete(`/calendar-events/${eventIds[1]}?scope=entire_series`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(204);

    const series = await request.get(`/calendar-event-series/${seriesId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(series.status).toBe(404);
  });
});

// ── Tenant isolation ──────────────────────────────────────────────────────────

describe('Tenant isolation', () => {
  let eventId: number;

  beforeAll(async () => {
    const { rows } = await db.query(
      "INSERT INTO calendar_events (gym_id, title, starts_at, ends_at, all_day, status) VALUES (?, 'Isolated', '2026-11-02 10:00:00', '2026-11-02 11:00:00', 0, 'scheduled')",
      [gymId],
    );
    eventId = (rows as any).insertId ?? 0;
    // Re-fetch using insertId from the query result properly
    const r2 = await db.query(
      "SELECT id FROM calendar_events WHERE gym_id = ? AND title = 'Isolated' ORDER BY id DESC LIMIT 1",
      [gymId],
    );
    eventId = r2.rows[0].id;
  });

  it('returns 404 when accessing an event from another gym', async () => {
    const res = await request.get(`/calendar-events/${eventId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(404);
  });
});
