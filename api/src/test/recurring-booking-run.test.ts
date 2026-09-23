// Tests for recurring-bookings.ts router
//
// #647 stage 4 — POST /recurring-bookings/run, the nightly rolling 2-month
// Personal Training booking window. Unlike every other router in this suite it
// is *not* mounted behind requireAuth + tenantContext: an external scheduler
// fires it with an X-Internal-Secret header, exactly as POST /billing/run is
// fired (see billing-run.test.ts for the precedent this file mirrors).
//
// The run re-projects each Member's stored `member_recurring_slots` pattern
// over the next two months and books whatever is free, so §4's "creates only
// missing bookings" / "does not create duplicates" is a property of the
// projection rather than of bookkeeping — which is why the idempotence block
// below is the centre of this file.
//
// Scoping: a run carrying `gym_id` or `member_id` skips the 23-hour rate limit
// and does not stamp `recurring_booking_run_log`. Every fixture-backed test
// here uses a scoped run, so none of them depends on the global rate-limit
// singleton or on whatever other gyms happen to exist in the database. Only the
// rate-limit block runs unscoped, and it is placed first — before any of this
// file's fixtures exist — so its full-database sweep can never disturb them.
//
// Dates: nothing is hard-coded. Every fixture gym is pinned to UTC
// (`gyms.timezone`) so the stored UTC `calendar_events.starts_at` and the
// gym-local grid the projection draws coincide, and the ISO weekday /
// `member_recurring_slots.iso_weekday` of a fixture is read back off the grid
// the router itself produced rather than assumed. Occurrences run weekly from
// 10 days before today to 10 days past the window end — a superset of whatever
// `expectedSlotDates` asks for — so no date reads as `no_occurrence` unless the
// test asked for it.
//
// Vacuous-pass guard: every "nothing was booked" assertion is preceded by the
// positive control that the same fixture *does* book when the precondition
// holds.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { db } from '../infra/db';
import { slotIdentityKey } from '../domain/personalTrainingSlots';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const SECRET = 'test-recurring-bookings-secret';

beforeAll(() => {
  process.env.RECURRING_BOOKINGS_INTERNAL_SECRET = SECRET;
});

afterEach(async () => {
  // Reset the rate-limit singleton between tests — the same shape billing-run
  // uses. Scoped runs never touch it, so this only matters for the rate-limit
  // block, but resetting unconditionally keeps one stray unscoped run from
  // poisoning everything after it.
  await db.query('UPDATE recurring_booking_run_log SET last_run_at = NULL WHERE id = 1');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ─── Ids and date helpers ─────────────────────────────────────────────────────

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const SQL = 'yyyy-MM-dd HH:mm:ss';

/** ISO weekday (1=Mon … 7=Sun) three days from today — never today's weekday. */
function targetWeekday(offsetDays = 3): number {
  return DateTime.utc().plus({ days: offsetDays }).weekday;
}

/**
 * Every `weekday` at `startTime` from 10 days before today to 10 days past the
 * window end — a deliberate superset of the dates the router expects, so every
 * date it looks for has a row and none reads as `no_occurrence` by accident.
 */
function weeklyStarts(weekday: number, startTime: string): DateTime[] {
  const [hour, minute] = startTime.split(':').map(Number);
  const now = DateTime.utc();
  const end = now.plus({ months: 2, days: 10 });
  let cursor = now.minus({ days: 10 }).startOf('day');
  cursor = cursor.plus({ days: (weekday - cursor.weekday + 7) % 7 });
  const out: DateTime[] = [];
  while (cursor < end) {
    out.push(cursor.set({ hour, minute, second: 0, millisecond: 0 }));
    cursor = cursor.plus({ weeks: 1 });
  }
  return out;
}

/** YYYY-MM-DD, `days` from today in UTC. */
function dayOffset(days: number): string {
  return DateTime.utc().plus({ days }).toFormat('yyyy-MM-dd');
}

// ─── Fixture helpers (direct inserts — the HTTP API is only used for the
// action under test, plus the grid read that derives a valid slot identity) ───

/**
 * A test gym pinned to UTC. createTestGym() leaves `timezone` at its
 * 'Europe/Madrid' default; the projection works in the gym's zone, so pinning
 * it to UTC makes the weekday/time fixtures independent of Spanish DST.
 */
async function createUtcGym(name: string): Promise<string> {
  const gymId = await createTestGym(name);
  await db.query('UPDATE gyms SET timezone = ? WHERE id = ?', ['UTC', gymId]);
  return gymId;
}

async function createMember(gymId: string, name = 'RBR Member'): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `rbr-${uniq()}@test.com`],
  );
  return insertId;
}

/** A gym-owned Professional Service plus its per-gym enable row (stage 1). */
async function createProfessionalService(
  gymId: string,
  name = `RBR-Service-${uniq()}`,
): Promise<{ id: number; name: string }> {
  const { insertId } = await db.query(
    `INSERT INTO professional_services (gym_id, name, is_system, system_key)
     VALUES (?, ?, 0, NULL)`,
    [gymId, name],
  );
  await db.query(
    `INSERT INTO gym_professional_services (gym_id, professional_service_id, status)
     VALUES (?, ?, 'active')`,
    [gymId, insertId],
  );
  return { id: insertId, name };
}

/**
 * Grants `sessions` of `serviceId` to `memberId` through the stage-1 package
 * path: class_packages + its gym_charges Sellable Item +
 * sellable_item_professional_services + user_class_packages. This is what makes
 * the Member "hold" the Professional Service — without it the projection is
 * empty and every assertion below would pass vacuously.
 *
 * Returns the `user_class_packages` id so §5 can revoke the entitlement.
 */
async function grantSessions(
  gymId: string,
  memberId: number,
  serviceId: number,
  sessions = 60,
): Promise<number> {
  const name = `RBR-Package-${uniq()}`;
  const { insertId: classPackageId } = await db.query(
    `INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status)
     VALUES (?, ?, ?, 100.00, 365, 'active')`,
    [gymId, name, sessions],
  );
  const { insertId: sellableItemId } = await db.query(
    `INSERT INTO gym_charges
       (gym_id, name, type, units, amount, currency, billing_frequency,
        status, availability, is_system, class_package_id)
     VALUES (?, ?, 'sessions', ?, 100.00, 'EUR', NULL, 'active', 'available', 0, ?)`,
    [gymId, name, sessions, classPackageId],
  );
  await db.query(
    `INSERT INTO sellable_item_professional_services (gym_id, sellable_item_id, professional_service_id)
     VALUES (?, ?, ?)`,
    [gymId, sellableItemId, serviceId],
  );
  const { insertId } = await db.query(
    `INSERT INTO user_class_packages
       (gym_id, member_id, class_package_id, expires_at, sessions_remaining, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [gymId, memberId, classPackageId, dayOffset(120), sessions],
  );
  return insertId;
}

async function createActivityType(
  gymId: string,
  opts: { name?: string; maxCapacity?: number | null } = {},
): Promise<{ id: number; name: string }> {
  const { name = `RBR-Activity-${uniq()}`, maxCapacity = 5 } = opts;
  const { insertId } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, public_event, status)
     VALUES (?, ?, ?, 1, 'active')`,
    [gymId, name, maxCapacity],
  );
  return { id: insertId, name };
}

/** One `calendar_events` occurrence. `start` is UTC — the fixture gyms are UTC. */
async function createOccurrence(
  gymId: string,
  opts: {
    activityTypeId: number;
    professionalServiceId: number;
    start: DateTime;
    durationMinutes?: number;
    capacity?: number | null;
  },
): Promise<number> {
  const { activityTypeId, professionalServiceId, start, durationMinutes = 60, capacity = null } = opts;
  const { insertId } = await db.query(
    `INSERT INTO calendar_events
       (gym_id, title, activity_type_id, professional_service_id, capacity,
        starts_at, ends_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
    [
      gymId,
      `RBR Occurrence ${uniq()}`,
      activityTypeId,
      professionalServiceId,
      capacity,
      start.toFormat(SQL),
      start.plus({ minutes: durationMinutes }).toFormat(SQL),
    ],
  );
  return insertId;
}

/**
 * The whole weekly series. Returns gym-local date (YYYY-MM-DD) →
 * calendar_event id so a single date can be filled or left out.
 */
async function createWeeklySeries(
  gymId: string,
  opts: {
    activityTypeId: number;
    professionalServiceId: number;
    weekday: number;
    startTime: string;
    capacity?: number | null;
    /** Local dates (YYYY-MM-DD) to leave without an occurrence. */
    skipDates?: string[];
  },
): Promise<Map<string, number>> {
  const { weekday, startTime, skipDates = [], ...rest } = opts;
  const byDate = new Map<string, number>();
  for (const start of weeklyStarts(weekday, startTime)) {
    const date = start.toFormat('yyyy-MM-dd');
    if (skipDates.includes(date)) continue;
    byDate.set(date, await createOccurrence(gymId, { ...rest, start }));
  }
  return byDate;
}

async function book(gymId: string, eventId: number, memberId: number) {
  await db.query(
    `INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status, booked_at)
     VALUES (?, ?, ?, 'booked', UTC_TIMESTAMP())`,
    [gymId, eventId, memberId],
  );
}

// ─── Reading the world back ───────────────────────────────────────────────────

/** The stage-2 grid, used only to derive a slot identity the projection offers. */
const getGrid = (gymId: string, memberId: number) =>
  request
    .get(`/members/${memberId}/personal-training-slots`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);

/** The one slot the fixture put on `weekday`, straight off the router's grid. */
async function gridSlot(gymId: string, memberId: number, weekday: number): Promise<any> {
  const res = await getGrid(gymId, memberId);
  expect(res.status).toBe(200);
  const day = res.body.days.find((d: any) => d.weekday === weekday);
  expect(day.slots).toHaveLength(1);
  return day.slots[0];
}

/** The six identity fields of a slot — what a stored selection is. */
const identityOf = (slot: any) => ({
  weekday: slot.weekday,
  start_time: slot.start_time,
  end_time: slot.end_time,
  activity_type_id: slot.activity_type_id,
  professional_service_id: slot.professional_service_id,
  center_id: slot.center_id ?? null,
});

/**
 * Store the weekly pattern directly (migration 169). `iso_weekday` is ISO
 * (1=Mon … 7=Sun) and the times are gym-local TIME values, so the identity is
 * taken from the grid the router itself produced rather than reconstructed —
 * a selection the projection does not offer books nothing at all.
 */
async function selectSlot(gymId: string, memberId: number, slot: any): Promise<void> {
  const id = identityOf(slot);
  await db.query(
    `INSERT INTO member_recurring_slots
       (gym_id, member_id, iso_weekday, start_time, end_time,
        activity_type_id, professional_service_id, center_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      gymId, memberId, id.weekday, `${id.start_time}:00`, `${id.end_time}:00`,
      id.activity_type_id, id.professional_service_id, id.center_id,
    ],
  );
}

interface BookingRow { id: number; calendar_event_id: number; status: string }

async function bookingRows(gymId: string, memberId: number): Promise<BookingRow[]> {
  const { rows } = await db.query<BookingRow>(
    `SELECT id, calendar_event_id, status FROM calendar_event_bookings
      WHERE gym_id = ? AND member_id = ? ORDER BY id ASC`,
    [gymId, memberId],
  );
  return rows;
}

interface SkipAlert { id: number; entity_id: number | null; payload: any }

async function skipAlerts(gymId: string, memberId: number): Promise<SkipAlert[]> {
  const { rows } = await db.query<SkipAlert>(
    `SELECT id, entity_id, payload FROM member_notifications
      WHERE gym_id = ? AND member_id = ? AND type = 'recurring_booking_skipped'
      ORDER BY id ASC`,
    [gymId, memberId],
  );
  return rows.map((r) => ({
    ...r,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
  }));
}

async function lastRunAt(): Promise<Date | null> {
  const { rows } = await db.query<{ last_run_at: Date | null }>(
    'SELECT last_run_at FROM recurring_booking_run_log WHERE id = 1',
  );
  return rows[0]?.last_run_at ?? null;
}

// ─── The action under test ────────────────────────────────────────────────────

const runJob = (body: Record<string, unknown> = {}) =>
  request.post('/recurring-bookings/run').set('x-internal-secret', SECRET).send(body);

/** The one member report a gym-scoped run over a single-member gym produces. */
const onlyMember = (body: any) => {
  expect(body.members).toHaveLength(1);
  return body.members[0];
};

/**
 * Build the standard fixture: a UTC gym whose Member holds a Professional
 * Service, with a weekly series of eligible occurrences on `weekday`.
 */
async function buildFixture(opts: {
  gymName: string;
  weekday: number;
  startTime: string;
  maxCapacity?: number;
  skipDates?: string[];
}) {
  const { gymName, weekday, startTime, maxCapacity = 5, skipDates = [] } = opts;
  const gymId = await createUtcGym(gymName);
  await createTestMembership(gymId, 'admin');
  const memberId = await createMember(gymId, `${gymName} Member`);
  const service = await createProfessionalService(gymId, `RBR PT ${uniq()}`);
  const packageId = await grantSessions(gymId, memberId, service.id);
  const activity = await createActivityType(gymId, { maxCapacity });
  const byDate = await createWeeklySeries(gymId, {
    activityTypeId: activity.id,
    professionalServiceId: service.id,
    weekday,
    startTime,
    skipDates,
  });
  return { gymId, memberId, service, activity, packageId, byDate };
}

// ─── 1. Auth ──────────────────────────────────────────────────────────────────

describe('POST /recurring-bookings/run — auth', () => {
  it('returns 401 without an X-Internal-Secret header', async () => {
    const res = await request.post('/recurring-bookings/run').send({});
    expect(res.status).toBe(401);
  });

  it('returns 401 with the wrong secret', async () => {
    const res = await request
      .post('/recurring-bookings/run')
      .set('x-internal-secret', 'not-the-secret')
      .send({});
    expect(res.status).toBe(401);
  });

  it('does not stamp the run log on a rejected request', async () => {
    await request.post('/recurring-bookings/run').set('x-internal-secret', 'nope').send({});
    expect(await lastRunAt()).toBeNull();
  });
});

// ─── 2. Validation ────────────────────────────────────────────────────────────

describe('POST /recurring-bookings/run — body validation', () => {
  it('rejects member_id = 0', async () => {
    const res = await runJob({ member_id: 0 });
    expect(res.status).toBe(400);
  });

  it('rejects a non-numeric member_id', async () => {
    const res = await runJob({ member_id: 'abc' });
    expect(res.status).toBe(400);
  });

  it('rejects limit = 0', async () => {
    const res = await runJob({ limit: 0 });
    expect(res.status).toBe(400);
  });

  it('rejects a limit above the cap', async () => {
    const res = await runJob({ limit: 99999 });
    expect(res.status).toBe(400);
  });

  it('does not stamp the run log when the body is rejected', async () => {
    await runJob({ limit: 99999 });
    expect(await lastRunAt()).toBeNull();
  });
});

// ─── 3. Rate limit ────────────────────────────────────────────────────────────
//
// Deliberately placed before any booking fixture in this file exists: an
// unscoped run sweeps every Member in the database, and running it first means
// it cannot disturb the gyms the later blocks assert on.

describe('POST /recurring-bookings/run — 23-hour rate limit', () => {
  let emptyGymId: string;

  beforeAll(async () => {
    emptyGymId = await createUtcGym('RBR Rate Limit Gym');
    await createTestMembership(emptyGymId, 'admin');
  });

  it('stamps recurring_booking_run_log on an unscoped run', async () => {
    expect(await lastRunAt()).toBeNull();

    const res = await runJob();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      processed: expect.any(Number),
      created: expect.any(Number),
      skipped: expect.any(Number),
      failed: expect.any(Number),
      notified: expect.any(Number),
    });
    expect(Array.isArray(res.body.members)).toBe(true);
    expect(await lastRunAt()).not.toBeNull();
  });

  it('returns 429 for a second unscoped run within 23 hours', async () => {
    expect((await runJob()).status).toBe(200);

    const res = await runJob();
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/23 hours/);
  });

  it('runs unscoped again once the stamp is older than 23 hours', async () => {
    await runJob();
    await db.query(
      'UPDATE recurring_booking_run_log SET last_run_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR) WHERE id = 1',
    );

    expect((await runJob()).status).toBe(200);
  });

  it('does not rate-limit a scoped run fired straight after an unscoped one', async () => {
    expect((await runJob()).status).toBe(200);
    const stamped = await lastRunAt();
    expect(stamped).not.toBeNull();

    const byGym = await runJob({ gym_id: emptyGymId });
    expect(byGym.status).toBe(200);

    // …and the scoped run left the singleton exactly where the unscoped one put it.
    expect((await lastRunAt())?.getTime()).toBe(stamped?.getTime());
  });

  it('does not stamp the log when the only run is a scoped one', async () => {
    expect(await lastRunAt()).toBeNull();

    const res = await runJob({ gym_id: emptyGymId });
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(0);
    expect(res.body.members).toEqual([]);
    expect(await lastRunAt()).toBeNull();
  });
});

// ─── 4. Happy path and idempotence (§4) ───────────────────────────────────────

describe('The rolling window — happy path and idempotence', () => {
  const weekday = targetWeekday();
  let gymId: string;
  let memberId: number;
  let slot: any;

  beforeAll(async () => {
    ({ gymId, memberId } = await buildFixture({
      gymName: 'RBR Window Gym',
      weekday,
      startTime: '10:00',
    }));
    slot = await gridSlot(gymId, memberId, weekday);
    await selectSlot(gymId, memberId, slot);
  });

  it('books every available date of the 2-month window', async () => {
    // Re-read the grid immediately before the run so the expected count cannot
    // drift across a slot boundary.
    const current = await gridSlot(gymId, memberId, weekday);
    expect(current.selected).toBe(true);
    expect(current.available_count).toBeGreaterThan(0);

    const before = await bookingRows(gymId, memberId);
    expect(before).toHaveLength(0);

    const res = await runJob({ gym_id: gymId });
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1);

    const report = onlyMember(res.body);
    expect(report).toMatchObject({ gym_id: gymId, member_id: memberId, failed: 0 });
    expect(report.error).toBeUndefined();
    expect(report.created).toBe(current.available_count);

    // The reported count is the number of rows that actually landed.
    const after = await bookingRows(gymId, memberId);
    expect(after.length - before.length).toBe(res.body.created);
    expect(res.body.created).toBe(report.created);
    expect(res.body.created).toBeGreaterThan(0);
    expect(after.every((r) => r.status === 'booked')).toBe(true);
    // One booking per occurrence, never two.
    expect(new Set(after.map((r) => r.calendar_event_id)).size).toBe(after.length);
  });

  it('creates only missing bookings — a second run creates nothing', async () => {
    const before = await bookingRows(gymId, memberId);
    expect(before.length).toBeGreaterThan(0);

    const res = await runJob({ gym_id: gymId, detail: true });
    expect(res.status).toBe(200);

    const report = onlyMember(res.body);
    expect(report.created).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(before.length);

    // Every date the first run took is reported as already_booked, not re-taken.
    const results = report.slots[0].results;
    expect(results.filter((r: any) => r.outcome === 'skipped')).toHaveLength(before.length);
    expect(results.every((r: any) => r.outcome === 'skipped' && r.reason === 'already_booked')).toBe(true);
  });

  it('does not create duplicates — the stored rows are untouched', async () => {
    const before = await bookingRows(gymId, memberId);
    await runJob({ gym_id: gymId });
    const after = await bookingRows(gymId, memberId);

    expect(after).toEqual(before);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
  });

  it('raises no alert for a date skipped as already_booked', async () => {
    // Three runs have now passed over the same fully-booked window.
    expect(await skipAlerts(gymId, memberId)).toEqual([]);
  });

  it('is reachable by member_id alone, without a gym_id', async () => {
    const res = await runJob({ member_id: memberId });
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1);
    expect(onlyMember(res.body)).toMatchObject({ gym_id: gymId, member_id: memberId, created: 0 });
  });
});

// ─── 5. Tenant isolation ──────────────────────────────────────────────────────

describe('Tenant isolation — a gym-scoped run touches only that gym', () => {
  const weekday = targetWeekday();
  let gymA: string;
  let memberA: number;
  let gymB: string;
  let memberB: number;

  beforeAll(async () => {
    const a = await buildFixture({ gymName: 'RBR Tenant Gym A', weekday, startTime: '11:00' });
    gymA = a.gymId;
    memberA = a.memberId;
    await selectSlot(gymA, memberA, await gridSlot(gymA, memberA, weekday));

    const b = await buildFixture({ gymName: 'RBR Tenant Gym B', weekday, startTime: '11:00' });
    gymB = b.gymId;
    memberB = b.memberId;
    await selectSlot(gymB, memberB, await gridSlot(gymB, memberB, weekday));
  });

  it("books gym A's member and leaves gym B's completely alone", async () => {
    const res = await runJob({ gym_id: gymA });
    expect(res.status).toBe(200);

    // Positive control: gym A really did book, so "gym B booked nothing" means
    // scoping rather than a broken fixture.
    const report = onlyMember(res.body);
    expect(report).toMatchObject({ gym_id: gymA, member_id: memberA, failed: 0 });
    expect(report.created).toBeGreaterThan(0);
    expect((await bookingRows(gymA, memberA)).length).toBe(report.created);

    // The report never mentions gym B.
    expect(res.body.members.map((m: any) => m.gym_id)).toEqual([gymA]);
    expect(res.body.members.some((m: any) => m.member_id === memberB)).toBe(false);

    expect(await bookingRows(gymB, memberB)).toEqual([]);
    expect(await skipAlerts(gymB, memberB)).toEqual([]);
  });

  it("gym B's identical fixture books when the run is scoped to it", async () => {
    const res = await runJob({ gym_id: gymB });
    expect(res.status).toBe(200);

    const report = onlyMember(res.body);
    expect(report).toMatchObject({ gym_id: gymB, member_id: memberB });
    expect(report.created).toBeGreaterThan(0);
    expect((await bookingRows(gymB, memberB)).length).toBe(report.created);
  });

  it("a run scoped to gym B's member never reaches gym A", async () => {
    const beforeA = await bookingRows(gymA, memberA);

    const res = await runJob({ member_id: memberB });
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: any) => m.member_id)).toEqual([memberB]);

    expect(await bookingRows(gymA, memberA)).toEqual(beforeA);
  });
});

// ─── 6. A Member with no stored selection ─────────────────────────────────────

describe('A Member with no stored selection is not processed', () => {
  const weekday = targetWeekday();
  let gymId: string;
  let selected: number;
  let unselected: number;
  let serviceId: number;
  let activityId: number;

  beforeAll(async () => {
    const fixture = await buildFixture({
      gymName: 'RBR Unselected Gym',
      weekday,
      startTime: '12:00',
    });
    gymId = fixture.gymId;
    selected = fixture.memberId;
    serviceId = fixture.service.id;
    activityId = fixture.activity.id;
    await selectSlot(gymId, selected, await gridSlot(gymId, selected, weekday));

    // Same entitlements, same eligible occurrences — only the stored pattern is
    // missing, so nothing but `member_recurring_slots` can explain the skip.
    unselected = await createMember(gymId, 'RBR Unselected Member');
    await grantSessions(gymId, unselected, serviceId);
  });

  it('walks only the Member who has a stored pattern', async () => {
    const res = await runJob({ gym_id: gymId });
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1);
    expect(res.body.members.map((m: any) => m.member_id)).toEqual([selected]);
    expect(await bookingRows(gymId, unselected)).toEqual([]);
  });

  it('picks the same Member up as soon as a pattern is stored', async () => {
    // Positive control: the grid offers this Member the very same slot, so the
    // previous test's empty result was the missing selection and nothing else.
    const slot = await gridSlot(gymId, unselected, weekday);
    expect(slot.activity_type_id).toBe(activityId);
    expect(slot.professional_service_id).toBe(serviceId);
    await selectSlot(gymId, unselected, slot);

    const res = await runJob({ gym_id: gymId });
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(2);
    expect(res.body.members.map((m: any) => m.member_id).sort()).toEqual([selected, unselected].sort());

    const report = res.body.members.find((m: any) => m.member_id === unselected);
    expect(report.created).toBeGreaterThan(0);
    expect((await bookingRows(gymId, unselected)).length).toBe(report.created);
  });
});

// ─── 6b. A soft-deleted gym ───────────────────────────────────────────────────

describe('A soft-deleted gym is not processed', () => {
  // `member_recurring_slots` cascades on a *hard* delete only, so every stored
  // pattern of a closed gym is still sitting there. Without the `gyms` join in
  // `loadRunTargets` the nightly job keeps filling its calendar for ever —
  // including through an unscoped run, where nobody named the gym at all.
  const weekday = targetWeekday();
  let gymId: string;
  let memberId: number;

  beforeAll(async () => {
    const fixture = await buildFixture({
      gymName: 'RBR Closed Gym',
      weekday,
      startTime: '14:00',
    });
    gymId = fixture.gymId;
    memberId = fixture.memberId;
    await selectSlot(gymId, memberId, await gridSlot(gymId, memberId, weekday));
  });

  it('books while the gym is live (positive control)', async () => {
    const res = await runJob({ gym_id: gymId });
    expect(res.status).toBe(200);
    expect(onlyMember(res.body).created).toBeGreaterThan(0);
  });

  it('books nothing once the gym is soft-deleted', async () => {
    const before = await bookingRows(gymId, memberId);
    expect(before.length).toBeGreaterThan(0); // the control above really ran

    await db.query('UPDATE gyms SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [gymId]);
    // Cancel what was booked, so "nothing new" cannot be mistaken for
    // "everything was already booked".
    await db.query(
      "UPDATE calendar_event_bookings SET status = 'cancelled' WHERE gym_id = ? AND member_id = ?",
      [gymId, memberId],
    );

    const res = await runJob({ gym_id: gymId });
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(0);
    expect(res.body.members).toEqual([]);
    expect(res.body.created).toBe(0);

    const after = await bookingRows(gymId, memberId);
    expect(after.filter((b) => b.status === 'booked')).toEqual([]);
  });

  it('is skipped by an unscoped run too', async () => {
    await db.query('UPDATE recurring_booking_run_log SET last_run_at = NULL WHERE id = 1');
    const res = await runJob();
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: any) => m.gym_id)).not.toContain(gymId);
    expect((await bookingRows(gymId, memberId)).filter((b) => b.status === 'booked')).toEqual([]);
  });

  afterAll(async () => {
    // cleanupTestGyms() deletes by id, not by state, so the soft delete does not
    // strand the fixture — but restore it anyway so the teardown path is the
    // same one every other block exercises.
    await db.query('UPDATE gyms SET deleted_at = NULL WHERE id = ?', [gymId]);
    await db.query('UPDATE recurring_booking_run_log SET last_run_at = NULL WHERE id = 1');
  });
});

// ─── 7. §5 — the Member lost the Professional Service ─────────────────────────

describe('§5 — a Member who lost the Professional Service', () => {
  const weekday = targetWeekday();
  let gymId: string;
  let memberId: number;
  let packageId: number;
  let bookedBefore: BookingRow[];

  beforeAll(async () => {
    const fixture = await buildFixture({ gymName: 'RBR Lapsed Gym', weekday, startTime: '13:00' });
    gymId = fixture.gymId;
    memberId = fixture.memberId;
    packageId = fixture.packageId;
    await selectSlot(gymId, memberId, await gridSlot(gymId, memberId, weekday));
  });

  it('books normally while the entitlement holds (positive control)', async () => {
    const res = await runJob({ gym_id: gymId });
    expect(res.status).toBe(200);

    const report = onlyMember(res.body);
    expect(report.created).toBeGreaterThan(0);

    bookedBefore = await bookingRows(gymId, memberId);
    expect(bookedBefore.length).toBe(report.created);
  });

  it('books nothing once the entitlement is gone', async () => {
    await db.query("UPDATE user_class_packages SET status = 'expired' WHERE id = ?", [packageId]);

    // The grid stops offering the slot, which is what the job sees too.
    const res = await getGrid(gymId, memberId);
    expect(res.body.professional_services).toEqual([]);

    const run = await runJob({ gym_id: gymId });
    expect(run.status).toBe(200);

    // The Member is still walked — they simply have nothing bookable.
    const report = onlyMember(run.body);
    expect(report).toMatchObject({ member_id: memberId, created: 0, failed: 0, notified: 0 });
    expect(report.error).toBeUndefined();
  });

  it('leaves the bookings it already made exactly as they were', async () => {
    const after = await bookingRows(gymId, memberId);
    expect(after).toEqual(bookedBefore);
    expect(after.map((r) => r.id)).toEqual(bookedBefore.map((r) => r.id));
    expect(after.every((r) => r.status === 'booked')).toBe(true);
  });

  it('raises no alert for a slot it can no longer resolve', async () => {
    expect(await skipAlerts(gymId, memberId)).toEqual([]);
  });
});

// ─── 8. Alerts (§Q5) ──────────────────────────────────────────────────────────

describe('Alerts — a date the run could not book', () => {
  const weekday = targetWeekday();
  let gymId: string;
  let memberId: number;
  let slot: any;
  let slotKey: string;
  let fullDate: string;
  let fullEventId: number;
  let missingDate: string;

  beforeAll(async () => {
    // Capacity 1: a single booking by anybody else fills the occurrence.
    const upcoming = weeklyStarts(weekday, '09:30')
      .filter((s) => s > DateTime.utc().plus({ days: 1 }))
      .slice(0, 2)
      .map((s) => s.toFormat('yyyy-MM-dd'));
    [fullDate, missingDate] = upcoming;

    const fixture = await buildFixture({
      gymName: 'RBR Alerts Gym',
      weekday,
      startTime: '09:30',
      maxCapacity: 1,
      skipDates: [missingDate],
    });
    gymId = fixture.gymId;
    memberId = fixture.memberId;
    fullEventId = fixture.byDate.get(fullDate)!;

    // Somebody else takes the only seat on `fullDate`.
    const blocker = await createMember(gymId, 'RBR Alerts Blocker');
    await book(gymId, fullEventId, blocker);

    slot = await gridSlot(gymId, memberId, weekday);
    slotKey = slotIdentityKey(identityOf(slot));
    await selectSlot(gymId, memberId, slot);
  });

  it('alerts on the full date and on the date with no occurrence', async () => {
    const current = await gridSlot(gymId, memberId, weekday);
    expect(current.available_count).toBeGreaterThan(0);

    const res = await runJob({ member_id: memberId });
    expect(res.status).toBe(200);

    const report = onlyMember(res.body);
    // Positive control: the rest of the window did book.
    expect(report.created).toBe(current.available_count);
    expect(report.skipped).toBe(2);
    expect(report.notified).toBe(2);
    expect(res.body.notified).toBe(2);

    const alerts = await skipAlerts(gymId, memberId);
    expect(alerts).toHaveLength(2);

    const byDate = new Map(alerts.map((a) => [a.payload.date, a]));
    expect([...byDate.keys()].sort()).toEqual([fullDate, missingDate].sort());

    const full = byDate.get(fullDate)!;
    expect(full.payload).toMatchObject({ date: fullDate, reason: 'full', slot_key: slotKey });
    expect(full.entity_id).toBe(fullEventId);

    const missing = byDate.get(missingDate)!;
    expect(missing.payload).toMatchObject({
      date: missingDate,
      reason: 'no_occurrence',
      slot_key: slotKey,
    });
    expect(missing.entity_id).toBeNull();

    // Every alert carries the slot it belongs to, so the member app can name it.
    for (const alert of alerts) {
      expect(alert.payload.slot_key).toBe(slotKey);
      expect(alert.payload.weekday).toBe(weekday);
      expect(alert.payload.start_time).toBe('09:30');
      expect(typeof alert.payload.title).toBe('string');
    }
  });

  it('does not duplicate the alert on a second run', async () => {
    const before = await skipAlerts(gymId, memberId);
    expect(before).toHaveLength(2);

    const res = await runJob({ member_id: memberId });
    expect(res.status).toBe(200);
    expect(onlyMember(res.body).notified).toBe(0);
    expect(res.body.notified).toBe(0);

    const after = await skipAlerts(gymId, memberId);
    expect(after).toHaveLength(2);
    expect(after.map((a) => a.id)).toEqual(before.map((a) => a.id));
  });

  it('raises no alert for the dates it skipped as already_booked', async () => {
    // The second run re-walked a window whose bookable dates are all taken —
    // proof that `already_booked` is outside NOTIFIED_SKIP_REASONS.
    const res = await runJob({ member_id: memberId });
    const report = onlyMember(res.body);
    expect(report.created).toBe(0);
    expect(report.skipped).toBeGreaterThan(2);
    expect(report.notified).toBe(0);

    const alerts = await skipAlerts(gymId, memberId);
    expect(alerts).toHaveLength(2);
    expect(alerts.some((a) => a.payload.reason === 'already_booked')).toBe(false);
  });
});

// ─── 9. detail ────────────────────────────────────────────────────────────────

describe('detail — the per-slot report', () => {
  const weekday = targetWeekday();
  let gymId: string;
  let memberId: number;
  let slot: any;

  beforeAll(async () => {
    const fixture = await buildFixture({ gymName: 'RBR Detail Gym', weekday, startTime: '19:00' });
    gymId = fixture.gymId;
    memberId = fixture.memberId;
    slot = await gridSlot(gymId, memberId, weekday);
    await selectSlot(gymId, memberId, slot);
  });

  it('omits slots when detail is not requested', async () => {
    const res = await runJob({ gym_id: gymId });
    expect(res.status).toBe(200);

    const report = onlyMember(res.body);
    expect(report.created).toBeGreaterThan(0);
    expect(report.slots).toBeUndefined();
  });

  it('includes the per-slot, per-date report when detail is true', async () => {
    const res = await runJob({ gym_id: gymId, detail: true });
    expect(res.status).toBe(200);

    const report = onlyMember(res.body);
    expect(Array.isArray(report.slots)).toBe(true);
    expect(report.slots).toHaveLength(1);

    const detail = report.slots[0];
    expect(detail).toMatchObject({ ...identityOf(slot), matched: true });
    expect(detail.professional_service_name).toBe(slot.professional_service_name);
    expect(detail.activity_type_name).toBe(slot.activity_type_name);
    expect(Array.isArray(detail.results)).toBe(true);
    expect(detail.results.length).toBeGreaterThan(0);
    for (const result of detail.results) {
      expect(typeof result.date).toBe('string');
      expect(['booked', 'skipped', 'failed']).toContain(result.outcome);
    }
  });

  it('omits slots again when detail is left off', async () => {
    const res = await runJob({ gym_id: gymId, detail: false });
    expect(onlyMember(res.body).slots).toBeUndefined();
  });
});
