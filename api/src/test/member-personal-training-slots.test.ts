// Tests for member-personal-training-slots.ts router
//
// #647 stage 2 — GET /members/:memberId/personal-training-slots. Mounted in
// app.ts behind requireAuth + tenantContext + requireModuleAccess('MEMBERS') +
// requireFeatureEnabled('organization.professional_services').
//
// The endpoint projects the Member's *recurring* Personal Training slots onto a
// Mon–Sun grid over a rolling 2-month window:
//
//   { timezone, window: { from, to, months }, professional_services: [...],
//     days: [{ weekday, slots: [...] }] }   // 7 days, ISO weekday 1=Mon … 7=Sun
//
// A slot groups calendar_events occurrences sharing gym-local weekday +
// start/end time + activity_type_id + professional_service_id. An occurrence is
// a candidate only when its professional_service_id is one the Member holds
// sessions for (stage 1) AND its Activity Type is bookable by the Member (#481).
//
// The pure projection (projectWeeklySlots / expectedSlotDates) is covered by the
// domain unit tests; this file exercises the SQL, the guards and the end-to-end
// shape against real MySQL.
//
// Dates: nothing is hard-coded. Every fixture gym is pinned to UTC
// (`gyms.timezone`) so "stored UTC" and "gym-local grid" coincide and the
// weekday/time assertions hold whenever the suite runs. The target weekday is
// always today + 3 days, so the first expected occurrence is never today and the
// window boundary is never in play. Occurrences are generated weekly from 10
// days before today to 10 days past the window end — a superset of whatever
// `expectedSlotDates` asks for — so `fully_available` is not at the mercy of the
// exact second the request runs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

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
 * window end — a deliberate superset of the router's expected dates, so every
 * date it looks for has a row and none of them reads as `no_occurrence`.
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

/** YYYY-MM-DD, `days` from today in UTC — matches the stage-1 loader's UTC_DATE(). */
function dayOffset(days: number): string {
  return DateTime.utc().plus({ days }).toFormat('yyyy-MM-dd');
}

// ─── Fixture helpers (direct inserts — the HTTP API is only used for the
// action under test) ──────────────────────────────────────────────────────────

/**
 * A test gym pinned to UTC. createTestGym() leaves `timezone` at its
 * 'Europe/Madrid' default; the grid is drawn in the gym's zone, so pinning it to
 * UTC makes the local weekday/time assertions independent of Spanish DST.
 */
async function createUtcGym(name: string): Promise<string> {
  const gymId = await createTestGym(name);
  await db.query('UPDATE gyms SET timezone = ? WHERE id = ?', ['UTC', gymId]);
  return gymId;
}

async function createMember(gymId: string, name = 'PTS Member'): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `pts-${uniq()}@test.com`],
  );
  return insertId;
}

/** A gym-owned Professional Service plus its per-gym enable row (see stage 1). */
async function createProfessionalService(
  gymId: string,
  name = `PTS-Service-${uniq()}`,
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
 * sellable_item_professional_services + user_class_packages.
 */
async function grantSessions(
  gymId: string,
  memberId: number,
  serviceId: number,
  sessions = 10,
): Promise<void> {
  const name = `PTS-Package-${uniq()}`;
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
  await db.query(
    `INSERT INTO user_class_packages
       (gym_id, member_id, class_package_id, expires_at, sessions_remaining, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [gymId, memberId, classPackageId, dayOffset(90), sessions],
  );
}

async function createActivityType(
  gymId: string,
  opts: { name?: string; maxCapacity?: number | null; publicEvent?: boolean } = {},
): Promise<{ id: number; name: string }> {
  const { name = `PTS-Activity-${uniq()}`, maxCapacity = 5, publicEvent = true } = opts;
  const { insertId } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, public_event, status)
     VALUES (?, ?, ?, ?, 'active')`,
    [gymId, name, maxCapacity, publicEvent ? 1 : 0],
  );
  return { id: insertId, name };
}

async function createPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `PTS-Plan-${uniq()}`],
  );
  return insertId;
}

async function assignPlan(gymId: string, memberId: number, planId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price, final_price)
     VALUES (?, ?, ?, 'active', ?, 40.00, 40.00)`,
    [gymId, memberId, planId, dayOffset(-30)],
  );
  return insertId;
}

async function makePlanEligible(gymId: string, activityTypeId: number, planId: number) {
  await db.query(
    `INSERT INTO activity_type_eligible_plans (gym_id, activity_type_id, membership_plan_id)
     VALUES (?, ?, ?)`,
    [gymId, activityTypeId, planId],
  );
}

/** One `calendar_events` occurrence. `start` is UTC — the fixture gyms are UTC. */
async function createOccurrence(
  gymId: string,
  opts: {
    activityTypeId: number;
    professionalServiceId: number | null;
    start: DateTime;
    durationMinutes?: number;
    status?: 'scheduled' | 'cancelled' | 'completed' | 'draft';
    capacity?: number | null;
  },
): Promise<number> {
  const {
    activityTypeId,
    professionalServiceId,
    start,
    durationMinutes = 60,
    status = 'scheduled',
    capacity = null,
  } = opts;
  const { insertId } = await db.query(
    `INSERT INTO calendar_events
       (gym_id, title, activity_type_id, professional_service_id, capacity,
        starts_at, ends_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      gymId,
      `PTS Occurrence ${uniq()}`,
      activityTypeId,
      professionalServiceId,
      capacity,
      start.toFormat(SQL),
      start.plus({ minutes: durationMinutes }).toFormat(SQL),
      status,
    ],
  );
  return insertId;
}

/**
 * Creates the whole weekly series and returns a map of gym-local date
 * (YYYY-MM-DD) → calendar_event id, so a single date can be mutated later.
 */
async function createWeeklySeries(
  gymId: string,
  opts: {
    activityTypeId: number;
    professionalServiceId: number;
    weekday: number;
    startTime: string;
    durationMinutes?: number;
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

async function book(
  gymId: string,
  eventId: number,
  memberId: number,
  status: 'booked' | 'waitlisted' | 'cancelled' = 'booked',
) {
  await db.query(
    `INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status, booked_at)
     VALUES (?, ?, ?, ?, UTC_TIMESTAMP())`,
    [gymId, eventId, memberId, status],
  );
}

// ─── Route helpers ────────────────────────────────────────────────────────────

const getSlots = (gymId: string, memberId: number | string) =>
  request
    .get(`/members/${memberId}/personal-training-slots`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);

/** Stage 3: PUT the whole weekly pattern. */
const putSelections = (gymId: string, memberId: number | string, body: unknown) =>
  request
    .put(`/members/${memberId}/personal-training-slots/selections`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send(body as object);

/** Stage 3: book the window, optionally replacing the pattern in the same call. */
const postBook = (gymId: string, memberId: number | string, body: unknown = {}) =>
  request
    .post(`/members/${memberId}/personal-training-slots/book`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send(body as object);

const dayOf = (body: any, weekday: number) =>
  body.days.find((d: any) => d.weekday === weekday);

/** The six identity fields a selection request carries, taken from a grid slot. */
const identityOf = (slot: any) => ({
  weekday: slot.weekday,
  start_time: slot.start_time,
  end_time: slot.end_time,
  activity_type_id: slot.activity_type_id,
  professional_service_id: slot.professional_service_id,
  center_id: slot.center_id ?? null,
});

// ─── Auth and access guards ───────────────────────────────────────────────────

describe('Auth and access guards', () => {
  let gymId: string;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createUtcGym('PTS Auth Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request
      .get(`/members/${memberId}/personal-training-slots`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  // PERMISSION_MATRIX.MEMBERS.member is 'R_OWN' — own data via /me/* only, so
  // requireModuleAccess('MEMBERS') refuses this admin-side route.
  it("returns 403 for the 'member' role (MEMBERS is R_OWN, not readable here)", async () => {
    const memberRoleGym = await createUtcGym('PTS Member Role Gym');
    await createTestMembership(memberRoleGym, 'member');
    const someMember = await createMember(memberRoleGym);

    const res = await getSlots(memberRoleGym, someMember);
    expect(res.status).toBe(403);
  });

  it("returns 403 for the 'accountant' role (MEMBERS is NONE)", async () => {
    const accountantGym = await createUtcGym('PTS Accountant Gym');
    await createTestMembership(accountantGym, 'accountant');
    const someMember = await createMember(accountantGym);

    const res = await getSlots(accountantGym, someMember);
    expect(res.status).toBe(403);
  });

  it('allows a read-only role (trainer_performance) to read the grid', async () => {
    const trainerGym = await createUtcGym('PTS Trainer Gym');
    await createTestMembership(trainerGym, 'trainer_performance');
    const trainerMember = await createMember(trainerGym);

    const res = await getSlots(trainerGym, trainerMember);
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(7);
  });

  it('returns 400 for a non-numeric memberId', async () => {
    const res = await getSlots(gymId, 'not-a-number');
    expect(res.status).toBe(400);
  });

  it('returns 404 for a member id that does not exist', async () => {
    const res = await getSlots(gymId, 9999999);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a soft-deleted member', async () => {
    const deleted = await createMember(gymId, 'PTS Deleted Member');
    await db.query('UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [deleted]);

    const res = await getSlots(gymId, deleted);
    expect(res.status).toBe(404);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('Tenant isolation', () => {
  let gymA: string;
  let gymB: string;
  let gymNoMembership: string;
  let memberInA: number;

  beforeAll(async () => {
    gymA = await createUtcGym('PTS Tenant Gym A');
    await createTestMembership(gymA, 'admin');

    // TEST_USER_ID is admin here too, so a request with gym B's header reaches
    // the router and the 404 can only come from the member/gym mismatch.
    gymB = await createUtcGym('PTS Tenant Gym B');
    await createTestMembership(gymB, 'admin');

    // A different Clerk user is admin here — TEST_USER_ID has no membership row.
    gymNoMembership = await createUtcGym('PTS Tenant Gym No Membership');
    await createTestMembership(gymNoMembership, 'admin', 'other-clerk-user-id');

    memberInA = await createMember(gymA, 'PTS Tenant Member A');
    const service = await createProfessionalService(gymA);
    await grantSessions(gymA, memberInA, service.id, 10);
  });

  it("returns 404 reading a gym A member with gym B's x-gym-id", async () => {
    const res = await getSlots(gymB, memberInA);
    expect(res.status).toBe(404);
  });

  it('still serves the grid for the owning gym', async () => {
    const res = await getSlots(gymA, memberInA);
    expect(res.status).toBe(200);
    expect(res.body.professional_services).toHaveLength(1);
  });

  it('returns 403 when the user has no membership in the requested gym', async () => {
    const memberInOther = await createMember(gymNoMembership);
    const res = await getSlots(gymNoMembership, memberInOther);
    expect(res.status).toBe(403);
  });
});

// ─── Happy path: a recurring PT slot on the grid ──────────────────────────────

describe('Weekly grid — happy path', () => {
  const weekday = targetWeekday();
  const otherWeekday = (weekday % 7) + 1;
  let gymId: string;
  let memberId: number;
  let service: { id: number; name: string };
  let activity: { id: number; name: string };

  beforeAll(async () => {
    gymId = await createUtcGym('PTS Happy Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId, 'PTS Happy Member');

    service = await createProfessionalService(gymId, `PTS Personal Training ${uniq()}`);
    await grantSessions(gymId, memberId, service.id, 10);

    activity = await createActivityType(gymId, { maxCapacity: 5 });
    await createWeeklySeries(gymId, {
      activityTypeId: activity.id,
      professionalServiceId: service.id,
      weekday,
      startTime: '10:00',
    });

    // A second service the Member does NOT hold, with its own weekly series on
    // another weekday — every one of its occurrences must be filtered out.
    const foreign = await createProfessionalService(gymId, `PTS Physio ${uniq()}`);
    const foreignActivity = await createActivityType(gymId, { maxCapacity: 5 });
    await createWeeklySeries(gymId, {
      activityTypeId: foreignActivity.id,
      professionalServiceId: foreign.id,
      weekday: otherWeekday,
      startTime: '18:00',
    });
  });

  it('returns the window envelope: gym timezone, 2 months, seven ISO weekdays', async () => {
    const res = await getSlots(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe('UTC');
    expect(res.body.window.months).toBe(2);
    expect(res.body.window.from).toBe(DateTime.utc().toFormat('yyyy-MM-dd'));
    expect(res.body.window.to).toBe(DateTime.utc().plus({ months: 2 }).toFormat('yyyy-MM-dd'));
    expect(res.body.days.map((d: any) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('echoes the Professional Services the Member holds sessions for', async () => {
    const res = await getSlots(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body.professional_services).toHaveLength(1);
    expect(res.body.professional_services[0]).toMatchObject({
      professional_service_id: service.id,
      name: service.name,
      sessions: 10,
    });
  });

  it('places the slot on the right weekday with its gym-local start and end time', async () => {
    const res = await getSlots(gymId, memberId);
    expect(res.status).toBe(200);

    const day = dayOf(res.body, weekday);
    expect(day.slots).toHaveLength(1);
    expect(day.slots[0]).toMatchObject({
      weekday,
      start_time: '10:00',
      end_time: '11:00',
      professional_service_id: service.id,
      professional_service_name: service.name,
      activity_type_id: activity.id,
      activity_type_name: activity.name,
      fully_available: true,
    });
  });

  it('reports every expected date as available and counts them consistently', async () => {
    const res = await getSlots(gymId, memberId);
    const slot = dayOf(res.body, weekday).slots[0];

    expect(slot.occurrence_count).toBeGreaterThan(0);
    expect(slot.dates).toHaveLength(slot.occurrence_count);
    expect(slot.available_count).toBe(slot.occurrence_count);
    expect(slot.already_booked_count).toBe(0);
    expect(slot.dates.every((d: any) => d.status === 'available')).toBe(true);
    expect(slot.dates.every((d: any) => typeof d.calendar_event_id === 'number')).toBe(true);
    // Every date falls on the slot's weekday and inside the window.
    for (const d of slot.dates) {
      expect(DateTime.fromISO(d.date, { zone: 'UTC' }).weekday).toBe(weekday);
      expect(d.date >= res.body.window.from).toBe(true);
      expect(d.date <= res.body.window.to).toBe(true);
    }
  });

  it('excludes occurrences of a Professional Service the Member does not hold', async () => {
    const res = await getSlots(gymId, memberId);
    expect(dayOf(res.body, otherWeekday).slots).toEqual([]);

    // …and nothing anywhere in the grid references that service.
    const allSlots = res.body.days.flatMap((d: any) => d.slots);
    expect(allSlots).toHaveLength(1);
    expect(allSlots[0].professional_service_id).toBe(service.id);
  });

  it("does not show the slot to another gym member who holds nothing", async () => {
    const stranger = await createMember(gymId, 'PTS Stranger Member');
    const res = await getSlots(gymId, stranger);
    expect(res.status).toBe(200);
    expect(res.body.professional_services).toEqual([]);
    expect(res.body.days.flatMap((d: any) => d.slots)).toEqual([]);
  });
});

// ─── Per-date statuses ────────────────────────────────────────────────────────

describe('Per-date statuses within a slot', () => {
  const weekday = targetWeekday();
  let gymId: string;
  let memberId: number;
  let slotDates: { available: string; cancelled: string; full: string; booked: string; missing: string };

  beforeAll(async () => {
    gymId = await createUtcGym('PTS Statuses Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId, 'PTS Statuses Member');
    const otherMember = await createMember(gymId, 'PTS Other Member');

    const service = await createProfessionalService(gymId, `PTS Statuses PT ${uniq()}`);
    await grantSessions(gymId, memberId, service.id, 10);
    // Capacity 1: a single booking by anyone else fills the occurrence.
    const activity = await createActivityType(gymId, { maxCapacity: 1 });

    // The first five occurrences comfortably inside the window (~3, 10, 17, 24
    // and 31 days out), so none of them brushes either window edge.
    const upcoming = weeklyStarts(weekday, '09:30')
      .filter((s) => s > DateTime.utc().plus({ days: 1 }))
      .slice(0, 5)
      .map((s) => s.toFormat('yyyy-MM-dd'));
    slotDates = {
      available: upcoming[0],
      cancelled: upcoming[1],
      full: upcoming[2],
      booked: upcoming[3],
      missing: upcoming[4],
    };

    const byDate = await createWeeklySeries(gymId, {
      activityTypeId: activity.id,
      professionalServiceId: service.id,
      weekday,
      startTime: '09:30',
      capacity: null, // falls back to activity_types.max_capacity = 1
      skipDates: [slotDates.missing],
    });

    await db.query('UPDATE calendar_events SET status = ? WHERE id = ?', [
      'cancelled',
      byDate.get(slotDates.cancelled),
    ]);
    await book(gymId, byDate.get(slotDates.full)!, otherMember);
    await book(gymId, byDate.get(slotDates.booked)!, memberId);
  });

  const statusFor = (body: any, date: string) => {
    const slot = dayOf(body, weekday).slots[0];
    return slot.dates.find((d: any) => d.date === date);
  };

  it('keeps the slot on the grid even though some dates are unavailable', async () => {
    const res = await getSlots(gymId, memberId);
    expect(res.status).toBe(200);
    const day = dayOf(res.body, weekday);
    expect(day.slots).toHaveLength(1);
    expect(day.slots[0]).toMatchObject({ start_time: '09:30', end_time: '10:30' });
    expect(day.slots[0].fully_available).toBe(false);
  });

  it('marks a free scheduled occurrence available', async () => {
    const res = await getSlots(gymId, memberId);
    expect(statusFor(res.body, slotDates.available)).toMatchObject({ status: 'available' });
  });

  it("marks a cancelled occurrence 'not_scheduled'", async () => {
    const res = await getSlots(gymId, memberId);
    expect(statusFor(res.body, slotDates.cancelled)).toMatchObject({ status: 'not_scheduled' });
  });

  it("marks an occurrence at capacity 'full'", async () => {
    const res = await getSlots(gymId, memberId);
    expect(statusFor(res.body, slotDates.full)).toMatchObject({ status: 'full' });
  });

  it("marks an occurrence the Member already holds 'already_booked'", async () => {
    const res = await getSlots(gymId, memberId);
    expect(statusFor(res.body, slotDates.booked)).toMatchObject({ status: 'already_booked' });
  });

  it("lists a date with no calendar_events row as 'no_occurrence' with a null event id", async () => {
    const res = await getSlots(gymId, memberId);
    expect(statusFor(res.body, slotDates.missing)).toMatchObject({
      status: 'no_occurrence',
      calendar_event_id: null,
    });
  });

  it('counts availability over the whole window, not just the sampled dates', async () => {
    const res = await getSlots(gymId, memberId);
    const slot = dayOf(res.body, weekday).slots[0];
    const counted = (status: string) =>
      slot.dates.filter((d: any) => d.status === status).length;

    expect(slot.occurrence_count).toBe(slot.dates.length);
    expect(slot.available_count).toBe(counted('available'));
    expect(slot.already_booked_count).toBe(1);
    expect(counted('not_scheduled')).toBe(1);
    expect(counted('full')).toBe(1);
    expect(counted('no_occurrence')).toBe(1);
  });
});

// ─── #481 Activity Type eligibility ───────────────────────────────────────────

describe('Activity Type eligibility (#481)', () => {
  const restrictedWeekday = targetWeekday(3);
  const eligibleWeekday = targetWeekday(4);
  let gymId: string;
  let memberId: number;
  let service: { id: number; name: string };
  let eligibleActivityId: number;

  beforeAll(async () => {
    gymId = await createUtcGym('PTS Eligibility Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId, 'PTS Eligibility Member');

    service = await createProfessionalService(gymId, `PTS Eligibility PT ${uniq()}`);
    await grantSessions(gymId, memberId, service.id, 10);

    // (a) Not public and no eligible plan → the booking path would 403, so the
    //     slot must not appear at all.
    const restricted = await createActivityType(gymId, { publicEvent: false, maxCapacity: 5 });
    await createWeeklySeries(gymId, {
      activityTypeId: restricted.id,
      professionalServiceId: service.id,
      weekday: restrictedWeekday,
      startTime: '07:00',
    });

    // (b) Not public, but the Member's ACTIVE assignment is on an eligible plan.
    const planId = await createPlan(gymId);
    await assignPlan(gymId, memberId, planId);
    const eligible = await createActivityType(gymId, { publicEvent: false, maxCapacity: 5 });
    eligibleActivityId = eligible.id;
    await makePlanEligible(gymId, eligible.id, planId);
    await createWeeklySeries(gymId, {
      activityTypeId: eligible.id,
      professionalServiceId: service.id,
      weekday: eligibleWeekday,
      startTime: '08:00',
    });
  });

  it('drops a non-public Activity Type the Member has no eligible plan for', async () => {
    const res = await getSlots(gymId, memberId);
    expect(res.status).toBe(200);
    expect(dayOf(res.body, restrictedWeekday).slots).toEqual([]);
  });

  it('keeps a non-public Activity Type the Member\'s active plan may book', async () => {
    const res = await getSlots(gymId, memberId);
    const day = dayOf(res.body, eligibleWeekday);
    expect(day.slots).toHaveLength(1);
    expect(day.slots[0]).toMatchObject({
      activity_type_id: eligibleActivityId,
      start_time: '08:00',
      end_time: '09:00',
      fully_available: true,
    });
  });

  it('shows exactly one slot in the whole grid', async () => {
    const res = await getSlots(gymId, memberId);
    expect(res.body.days.flatMap((d: any) => d.slots)).toHaveLength(1);
  });
});

// ─── A Member holding no Professional Services ────────────────────────────────

describe('Member with no Professional Services', () => {
  const weekday = targetWeekday();
  let gymId: string;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createUtcGym('PTS Empty Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId, 'PTS Empty Member');

    // Real PT occurrences exist in the gym — the Member simply holds no sessions.
    const service = await createProfessionalService(gymId, `PTS Unheld Service ${uniq()}`);
    const activity = await createActivityType(gymId, { maxCapacity: 5 });
    await createWeeklySeries(gymId, {
      activityTypeId: activity.id,
      professionalServiceId: service.id,
      weekday,
      startTime: '11:00',
    });
  });

  it('returns an empty service list and seven empty days', async () => {
    const res = await getSlots(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body.professional_services).toEqual([]);
    expect(res.body.days).toHaveLength(7);
    expect(res.body.days.map((d: any) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const day of res.body.days) expect(day.slots).toEqual([]);
  });
});

// ─── Stage 3: storing the weekly pattern ──────────────────────────────────────
//
// PUT /members/:memberId/personal-training-slots/selections replaces the
// Member's `member_recurring_slots` rows (migration 169) with whatever the grid
// sends. Write-gated with requireModuleWrite('MEMBERS'); every submitted
// identity must be a slot the projection currently offers.

describe('Selections — PUT /selections', () => {
  const weekday = targetWeekday();
  const secondWeekday = (weekday % 7) + 1;
  let gymId: string;
  let memberId: number;
  let slotA: any;
  let slotB: any;

  beforeAll(async () => {
    gymId = await createUtcGym('PTS Selection Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId, 'PTS Selection Member');

    const service = await createProfessionalService(gymId, `PTS Selection PT ${uniq()}`);
    await grantSessions(gymId, memberId, service.id, 20);

    const activity = await createActivityType(gymId, { maxCapacity: 5 });
    await createWeeklySeries(gymId, {
      activityTypeId: activity.id, professionalServiceId: service.id,
      weekday, startTime: '10:00',
    });
    await createWeeklySeries(gymId, {
      activityTypeId: activity.id, professionalServiceId: service.id,
      weekday: secondWeekday, startTime: '18:00',
    });

    const grid = await getSlots(gymId, memberId);
    slotA = dayOf(grid.body, weekday).slots[0];
    slotB = dayOf(grid.body, secondWeekday).slots[0];
  });

  it('starts with no selections and no slot marked selected', async () => {
    const res = await getSlots(gymId, memberId);
    expect(res.body.selections).toEqual([]);
    expect(res.body.days.flatMap((d: any) => d.slots).every((s: any) => s.selected === false)).toBe(true);
  });

  it('stores multiple slots across different days and times (§2)', async () => {
    const res = await putSelections(gymId, memberId, { slots: [identityOf(slotA), identityOf(slotB)] });
    expect(res.status).toBe(200);
    expect(res.body.selections).toHaveLength(2);
    expect(res.body.selections.every((s: any) => s.matched)).toBe(true);

    const grid = await getSlots(gymId, memberId);
    expect(dayOf(grid.body, weekday).slots[0].selected).toBe(true);
    expect(dayOf(grid.body, secondWeekday).slots[0].selected).toBe(true);
  });

  it('is a full replace — re-sending one slot drops the other', async () => {
    await putSelections(gymId, memberId, { slots: [identityOf(slotA), identityOf(slotB)] });
    const res = await putSelections(gymId, memberId, { slots: [identityOf(slotA)] });

    expect(res.status).toBe(200);
    expect(res.body.selections).toHaveLength(1);
    expect(res.body.selections[0]).toMatchObject(identityOf(slotA));

    const grid = await getSlots(gymId, memberId);
    expect(dayOf(grid.body, secondWeekday).slots[0].selected).toBe(false);
  });

  it('keeps the stored row (and its id) when a selection is re-sent unchanged', async () => {
    const first = await putSelections(gymId, memberId, { slots: [identityOf(slotA)] });
    const again = await putSelections(gymId, memberId, { slots: [identityOf(slotA)] });
    expect(again.body.selections[0].id).toBe(first.body.selections[0].id);
  });

  it('clears every selection when sent an empty array', async () => {
    await putSelections(gymId, memberId, { slots: [identityOf(slotA)] });
    const res = await putSelections(gymId, memberId, { slots: [] });

    expect(res.status).toBe(200);
    expect(res.body.selections).toEqual([]);
  });

  it('rejects a slot the grid does not offer', async () => {
    const res = await putSelections(gymId, memberId, {
      slots: [{ ...identityOf(slotA), start_time: '05:00', end_time: '06:00' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('slot_not_available');
  });

  it('rejects a malformed body', async () => {
    expect((await putSelections(gymId, memberId, { slots: 'nope' })).status).toBe(400);
    expect((await putSelections(gymId, memberId, { slots: [{ ...identityOf(slotA), weekday: 9 }] })).status).toBe(400);
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request
      .put(`/members/${memberId}/personal-training-slots/selections`)
      .set('x-gym-id', gymId)
      .send({ slots: [] });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a read-only role (MEMBERS is readable, not writable)', async () => {
    const readOnlyGym = await createUtcGym('PTS Selection ReadOnly Gym');
    await createTestMembership(readOnlyGym, 'trainer_performance');
    const otherMember = await createMember(readOnlyGym, 'PTS ReadOnly Member');

    const res = await putSelections(readOnlyGym, otherMember, { slots: [] });
    expect(res.status).toBe(403);
  });

  it("returns 404 writing a gym A member with another gym's x-gym-id", async () => {
    const otherGym = await createUtcGym('PTS Selection Other Gym');
    await createTestMembership(otherGym, 'admin');

    const res = await putSelections(otherGym, memberId, { slots: [] });
    expect(res.status).toBe(404);
  });

  it('does not store the selection in the other gym', async () => {
    const otherGym = await createUtcGym('PTS Selection Isolation Gym');
    await createTestMembership(otherGym, 'admin');
    const otherMember = await createMember(otherGym, 'PTS Isolation Member');

    await putSelections(gymId, memberId, { slots: [identityOf(slotA)] });
    const res = await getSlots(otherGym, otherMember);
    expect(res.body.selections).toEqual([]);
  });
});

// ─── Stage 3: Book ────────────────────────────────────────────────────────────
//
// POST /members/:memberId/personal-training-slots/book puts every free date of
// the selected slots through bookMemberOnSession — the existing booking path,
// one occurrence at a time — and reports the ones it could not take.

describe('Book — POST /book', () => {
  const weekday = targetWeekday();
  let gymId: string;
  let memberId: number;
  let service: { id: number; name: string };
  let activity: { id: number; name: string };
  let slot: any;

  beforeAll(async () => {
    gymId = await createUtcGym('PTS Book Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId, 'PTS Book Member');

    service = await createProfessionalService(gymId, `PTS Book PT ${uniq()}`);
    await grantSessions(gymId, memberId, service.id, 20);

    activity = await createActivityType(gymId, { maxCapacity: 5 });
    await createWeeklySeries(gymId, {
      activityTypeId: activity.id, professionalServiceId: service.id,
      weekday, startTime: '14:00',
    });

    const grid = await getSlots(gymId, memberId);
    slot = dayOf(grid.body, weekday).slots[0];
  });

  /** How many live bookings the Member holds in this gym right now. */
  async function bookingCount(member = memberId): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM calendar_event_bookings
        WHERE gym_id = ? AND member_id = ? AND status = 'booked'`,
      [gymId, member],
    );
    return Number(rows[0].n);
  }

  it('books every free date of the submitted slot and stores the pattern (§3)', async () => {
    const res = await postBook(gymId, memberId, { slots: [identityOf(slot)] });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(slot.occurrence_count);
    expect(res.body.failed).toBe(0);
    expect(res.body.selections).toHaveLength(1);
    expect(await bookingCount()).toBe(slot.occurrence_count);

    // Every booking points at one of the slot's occurrences, on its weekday.
    const dates = res.body.slots[0].results.map((r: any) => r.date);
    expect(new Set(dates).size).toBe(dates.length);
    for (const date of dates) {
      expect(DateTime.fromISO(date, { zone: 'UTC' }).weekday).toBe(weekday);
    }
  });

  it('is idempotent — a second Book creates nothing and skips as already_booked', async () => {
    const before = await bookingCount();
    const res = await postBook(gymId, memberId);

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.failed).toBe(0);
    expect(res.body.slots[0].results.every((r: any) => r.reason === 'already_booked')).toBe(true);
    expect(await bookingCount()).toBe(before);
  });

  it('marks every booked date already_booked on the grid afterwards', async () => {
    const grid = await getSlots(gymId, memberId);
    const booked = dayOf(grid.body, weekday).slots[0];
    expect(booked.selected).toBe(true);
    expect(booked.available_count).toBe(0);
    expect(booked.already_booked_count).toBe(booked.occurrence_count);
  });

  it('books nothing when no slot is selected', async () => {
    const other = await createMember(gymId, 'PTS Book Unselected Member');
    await grantSessions(gymId, other, service.id, 10);

    const res = await postBook(gymId, other);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 0, skipped: 0, failed: 0 });
    expect(res.body.slots).toEqual([]);
    expect(await bookingCount(other)).toBe(0);
  });

  it('skips a full occurrence instead of waitlisting the Member', async () => {
    const fullGym = await createUtcGym('PTS Book Full Gym');
    await createTestMembership(fullGym, 'admin');
    const member = await createMember(fullGym, 'PTS Book Full Member');
    const blocker = await createMember(fullGym, 'PTS Book Blocker');
    const fullService = await createProfessionalService(fullGym, `PTS Full PT ${uniq()}`);
    await grantSessions(fullGym, member, fullService.id, 20);
    const fullActivity = await createActivityType(fullGym, { maxCapacity: 1 });
    const byDate = await createWeeklySeries(fullGym, {
      activityTypeId: fullActivity.id, professionalServiceId: fullService.id,
      weekday, startTime: '15:00',
    });

    // Fill the first date with somebody else, then Book.
    const firstDate = [...byDate.keys()].sort().find((d) => d >= DateTime.utc().toFormat('yyyy-MM-dd'))!;
    await book(fullGym, byDate.get(firstDate)!, blocker);

    const grid = await getSlots(fullGym, member);
    const fullSlot = dayOf(grid.body, weekday).slots[0];
    const res = await postBook(fullGym, member, { slots: [identityOf(fullSlot)] });

    expect(res.status).toBe(200);
    const full = res.body.slots[0].results.find((r: any) => r.date === firstDate);
    expect(full).toMatchObject({ outcome: 'skipped', reason: 'full' });

    // Nothing was waitlisted for the Member on that occurrence.
    const { rows } = await db.query(
      `SELECT status FROM calendar_event_bookings
        WHERE calendar_event_id = ? AND member_id = ?`,
      [byDate.get(firstDate), member],
    );
    expect(rows).toEqual([]);
  });

  it('skips a cancelled occurrence and books the rest', async () => {
    const mixedGym = await createUtcGym('PTS Book Cancelled Gym');
    await createTestMembership(mixedGym, 'admin');
    const member = await createMember(mixedGym, 'PTS Book Cancelled Member');
    const mixedService = await createProfessionalService(mixedGym, `PTS Cancelled PT ${uniq()}`);
    await grantSessions(mixedGym, member, mixedService.id, 20);
    const mixedActivity = await createActivityType(mixedGym, { maxCapacity: 5 });
    const byDate = await createWeeklySeries(mixedGym, {
      activityTypeId: mixedActivity.id, professionalServiceId: mixedService.id,
      weekday, startTime: '16:00',
    });

    const firstDate = [...byDate.keys()].sort().find((d) => d >= DateTime.utc().toFormat('yyyy-MM-dd'))!;
    await db.query("UPDATE calendar_events SET status = 'cancelled' WHERE id = ?", [byDate.get(firstDate)]);

    const grid = await getSlots(mixedGym, member);
    const mixedSlot = dayOf(grid.body, weekday).slots[0];
    const res = await postBook(mixedGym, member, { slots: [identityOf(mixedSlot)] });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(mixedSlot.available_count);
    expect(res.body.slots[0].results.find((r: any) => r.date === firstDate)).toMatchObject({
      outcome: 'skipped', reason: 'not_scheduled',
    });
  });

  it('books nothing for a stored slot the Member is no longer entitled to (§5)', async () => {
    const lapsedGym = await createUtcGym('PTS Book Lapsed Gym');
    await createTestMembership(lapsedGym, 'admin');
    const member = await createMember(lapsedGym, 'PTS Book Lapsed Member');
    const lapsedService = await createProfessionalService(lapsedGym, `PTS Lapsed PT ${uniq()}`);
    await grantSessions(lapsedGym, member, lapsedService.id, 10);
    const lapsedActivity = await createActivityType(lapsedGym, { maxCapacity: 5 });
    await createWeeklySeries(lapsedGym, {
      activityTypeId: lapsedActivity.id, professionalServiceId: lapsedService.id,
      weekday, startTime: '17:00',
    });

    const grid = await getSlots(lapsedGym, member);
    const lapsedSlot = dayOf(grid.body, weekday).slots[0];
    await putSelections(lapsedGym, member, { slots: [identityOf(lapsedSlot)] });

    // The package expires — the Member no longer holds the Professional Service.
    await db.query(
      "UPDATE user_class_packages SET status = 'expired' WHERE gym_id = ? AND member_id = ?",
      [lapsedGym, member],
    );

    const res = await postBook(lapsedGym, member);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 0, failed: 0 });
    expect(res.body.slots[0].matched).toBe(false);
    expect(res.body.selections[0].matched).toBe(false);

    const { rows } = await db.query(
      "SELECT id FROM calendar_event_bookings WHERE gym_id = ? AND member_id = ?",
      [lapsedGym, member],
    );
    expect(rows).toEqual([]);
  });

  it('rejects a slot the grid does not offer', async () => {
    const res = await postBook(gymId, memberId, {
      slots: [{ ...identityOf(slot), start_time: '03:00', end_time: '04:00' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('slot_not_available');
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request
      .post(`/members/${memberId}/personal-training-slots/book`)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(401);
  });

  it('returns 403 for a read-only role', async () => {
    const readOnlyGym = await createUtcGym('PTS Book ReadOnly Gym');
    await createTestMembership(readOnlyGym, 'trainer_performance');
    const otherMember = await createMember(readOnlyGym, 'PTS Book ReadOnly Member');

    expect((await postBook(readOnlyGym, otherMember)).status).toBe(403);
  });

  it("returns 404 booking a gym A member with another gym's x-gym-id", async () => {
    const otherGym = await createUtcGym('PTS Book Other Gym');
    await createTestMembership(otherGym, 'admin');

    expect((await postBook(otherGym, memberId)).status).toBe(404);
  });
});
