// #1113 — the pre-event training reminder (`POST /booking-reminders/run`,
// api/src/api/booking-reminders.ts) and the alerts §1 takes away.
//
// The run is system-wide (one SELECT across every gym, like the nightly runs),
// so this file does its own normalising: it asserts on the alerts of the members
// it created rather than on the run's global counters, because a booking another
// test file left inside the two-hour window would otherwise move them. The two
// places a global count is asserted both subtract a baseline taken immediately
// before.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const SECRET = 'test-booking-reminders-secret';
const REMINDER = 'booking_reminder_2h';

let gymId: string;
let otherGymId: string;
let centerId: number;
let otherCenterId: number;
let activityTypeId: number;
let otherActivityTypeId: number;

const run = () => request.post('/booking-reminders/run').set('X-Internal-Secret', SECRET);

/** An occurrence `startsMinutes` from now, so "is it inside the window" is real. */
async function createEvent(opts: {
  startsMinutes: number;
  status?: string;
  title?: string;
  deleted?: boolean;
  gym?: string;
}): Promise<number> {
  const gid = opts.gym ?? gymId;
  const { insertId } = await db.query(
    `INSERT INTO calendar_events
       (gym_id, center_id, title, activity_type_id, starts_at, ends_at, status, deleted_at)
     VALUES (?, ?, ?, ?,
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE),
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?, ${opts.deleted ? 'UTC_TIMESTAMP()' : 'NULL'})`,
    [
      gid,
      gid === gymId ? centerId : otherCenterId,
      opts.title ?? 'Spin Class',
      gid === gymId ? activityTypeId : otherActivityTypeId,
      opts.startsMinutes, opts.startsMinutes + 60,
      opts.status ?? 'scheduled',
    ],
  );
  return insertId;
}

async function createMember(opts: { deleted?: boolean; gym?: string } = {}): Promise<number> {
  const gid = opts.gym ?? gymId;
  const email = `reminder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email, deleted_at)
     VALUES (?, 'Reminder Member', ?, ${opts.deleted ? 'UTC_TIMESTAMP()' : 'NULL'})`,
    [gid, email],
  );
  return insertId;
}

async function book(
  memberId: number,
  eventId: number,
  status: 'booked' | 'waitlisted' | 'cancelled' = 'booked',
  gid = gymId,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_event_bookings
       (gym_id, center_id, member_id, calendar_event_id, status, attendance_status, booked_at)
     VALUES (?, ?, ?, ?, ?, 'pending', UTC_TIMESTAMP())`,
    [gid, gid === gymId ? centerId : otherCenterId, memberId, eventId, status],
  );
  return insertId;
}

async function remindersFor(memberId: number) {
  const { rows } = await db.query<{ id: number; entity_type: string; entity_id: number; payload: any }>(
    `SELECT id, type, entity_type, entity_id, payload FROM member_notifications
      WHERE member_id = ? AND type = ? ORDER BY id ASC`,
    [memberId, REMINDER],
  );
  return rows;
}

beforeAll(async () => {
  process.env.BOOKING_REMINDERS_INTERNAL_SECRET = SECRET;
  gymId = await createTestGym('Booking Reminder Gym');
  otherGymId = await createTestGym('Booking Reminder Gym B');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');

  const { insertId: cid } = await db.query(
    `INSERT INTO centers (gym_id, name, status) VALUES (?, 'Reminder Center', 'active')`,
    [gymId],
  );
  centerId = cid;
  const { insertId: cid2 } = await db.query(
    `INSERT INTO centers (gym_id, name, status) VALUES (?, 'Reminder Center B', 'active')`,
    [otherGymId],
  );
  otherCenterId = cid2;

  const { insertId: atid } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, ?, 20, 'active')`,
    [gymId, `ReminderClass-${Date.now()}`],
  );
  activityTypeId = atid;
  const { insertId: atid2 } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, ?, 20, 'active')`,
    [otherGymId, `ReminderClassB-${Date.now()}`],
  );
  otherActivityTypeId = atid2;
});

afterAll(async () => {
  delete process.env.BOOKING_REMINDERS_INTERNAL_SECRET;
  await cleanupTestGyms();
  await db.end();
});

// ─── Auth (#783's shared-secret surface) ──────────────────────────────────────

describe('POST /booking-reminders/run auth', () => {
  it('401 without the internal secret', async () => {
    const res = await request.post('/booking-reminders/run');
    expect(res.status).toBe(401);
  });

  it('401 with the wrong internal secret', async () => {
    const res = await request.post('/booking-reminders/run').set('X-Internal-Secret', 'nope');
    expect(res.status).toBe(401);
  });

  it('401 when the deployment has no secret configured at all', async () => {
    delete process.env.BOOKING_REMINDERS_INTERNAL_SECRET;
    const res = await run();
    expect(res.status).toBe(401);
    process.env.BOOKING_REMINDERS_INTERNAL_SECRET = SECRET;
  });

  it('does not accept the billing secret', async () => {
    // Its own workflow, so its own secret (api/src/api/promotion-lifecycle.ts's
    // own rule). A shared one would mean the quarter-hourly schedule and the
    // nightly charge share a credential.
    process.env.BILLING_INTERNAL_SECRET = 'billing-secret';
    const res = await request.post('/booking-reminders/run').set('X-Internal-Secret', 'billing-secret');
    expect(res.status).toBe(401);
    delete process.env.BILLING_INTERNAL_SECRET;
  });
});

// ─── §2/§3: who is owed a reminder ────────────────────────────────────────────

describe('the reminder the run raises (#1113 §2)', () => {
  it('alerts a member whose booked event starts inside the window', async () => {
    const memberId = await createMember();
    const eventId = await createEvent({ startsMinutes: 90, title: 'Morning Spin' });
    await book(memberId, eventId);

    const res = await run();
    expect(res.status).toBe(200);
    expect(res.body.lead_minutes).toBe(120);

    const rows = await remindersFor(memberId);
    expect(rows).toHaveLength(1);
    // The occurrence is what the alert is about, so the member can tap through.
    expect(rows[0].entity_type).toBe('session');
    expect(rows[0].entity_id).toBe(eventId);
    // The occurrence's own title, and no sentence — the copy is the Members
    // App's locale keys.
    const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
    expect(payload.title).toBe('Morning Spin');
    expect(payload.starts_at).toBeTruthy();
    expect(Object.keys(payload).sort()).toEqual(['starts_at', 'title']);
  });

  it('raises exactly one reminder however often it runs (§5)', async () => {
    const memberId = await createMember();
    const eventId = await createEvent({ startsMinutes: 30 });
    await book(memberId, eventId);

    await run();
    await run();
    await run();

    expect(await remindersFor(memberId)).toHaveLength(1);
  });

  it('leaves an event beyond the window alone until it comes inside it', async () => {
    const memberId = await createMember();
    const eventId = await createEvent({ startsMinutes: 240 });
    await book(memberId, eventId);

    await run();
    expect(await remindersFor(memberId)).toHaveLength(0);

    // Bring it inside the two hours without touching anything else.
    await db.query(
      'UPDATE calendar_events SET starts_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 100 MINUTE) WHERE id = ?',
      [eventId],
    );
    await run();
    expect(await remindersFor(memberId)).toHaveLength(1);
  });

  it('does not remind about an event that has already started', async () => {
    const memberId = await createMember();
    const eventId = await createEvent({ startsMinutes: -10 });
    await book(memberId, eventId);

    await run();
    expect(await remindersFor(memberId)).toHaveLength(0);
  });

  it('does not remind a member who cancelled before the reminder was due (§3)', async () => {
    const memberId = await createMember();
    const eventId = await createEvent({ startsMinutes: 60 });
    await book(memberId, eventId, 'cancelled');

    await run();
    expect(await remindersFor(memberId)).toHaveLength(0);
  });

  it('does not remind a waitlisted member — a place in a queue is not a training', async () => {
    const memberId = await createMember();
    const eventId = await createEvent({ startsMinutes: 60 });
    await book(memberId, eventId, 'waitlisted');

    await run();
    expect(await remindersFor(memberId)).toHaveLength(0);
  });

  it('does not remind about a cancelled, completed, draft or deleted occurrence', async () => {
    for (const status of ['cancelled', 'completed', 'draft']) {
      const memberId = await createMember();
      const eventId = await createEvent({ startsMinutes: 60, status });
      await book(memberId, eventId);
      await run();
      expect(await remindersFor(memberId)).toHaveLength(0);
    }

    const memberId = await createMember();
    const eventId = await createEvent({ startsMinutes: 60, deleted: true });
    await book(memberId, eventId);
    await run();
    expect(await remindersFor(memberId)).toHaveLength(0);
  });

  it('does not remind a soft-deleted member', async () => {
    const memberId = await createMember({ deleted: true });
    const eventId = await createEvent({ startsMinutes: 60 });
    await book(memberId, eventId);

    await run();
    expect(await remindersFor(memberId)).toHaveLength(0);
  });

  it('reminds every booked member of the same occurrence', async () => {
    const a = await createMember();
    const b = await createMember();
    const eventId = await createEvent({ startsMinutes: 45 });
    await book(a, eventId);
    await book(b, eventId);

    await run();
    expect(await remindersFor(a)).toHaveLength(1);
    expect(await remindersFor(b)).toHaveLength(1);
  });

  it('reminds about the booking that is live, not the one that was replaced (§6)', async () => {
    const memberId = await createMember();
    const dropped = await createEvent({ startsMinutes: 50, title: 'Event A' });
    const kept = await createEvent({ startsMinutes: 70, title: 'Event B' });
    await book(memberId, dropped, 'cancelled');
    await book(memberId, kept);

    await run();
    const rows = await remindersFor(memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_id).toBe(kept);
  });

  it('counts every gym it wrote for, and only alerts each gym’s own members', async () => {
    const mine = await createMember();
    const theirs = await createMember({ gym: otherGymId });
    const myEvent = await createEvent({ startsMinutes: 55 });
    const theirEvent = await createEvent({ startsMinutes: 55, gym: otherGymId });
    await book(mine, myEvent);
    await book(theirs, theirEvent, 'booked', otherGymId);

    const res = await run();
    expect(res.status).toBe(200);
    expect(res.body.gyms).toBeGreaterThanOrEqual(2);

    const { rows: mineRows } = await db.query<{ gym_id: string }>(
      'SELECT gym_id FROM member_notifications WHERE member_id = ? AND type = ?',
      [mine, REMINDER],
    );
    expect(mineRows).toHaveLength(1);
    expect(mineRows[0].gym_id).toBe(gymId);

    const { rows: theirRows } = await db.query<{ gym_id: string }>(
      'SELECT gym_id FROM member_notifications WHERE member_id = ? AND type = ?',
      [theirs, REMINDER],
    );
    expect(theirRows).toHaveLength(1);
    expect(theirRows[0].gym_id).toBe(otherGymId);
  });

  it('reports what it wrote', async () => {
    // A baseline, because the run is system-wide and other files' fixtures may
    // also sit inside the window.
    const before = await run();
    expect(before.status).toBe(200);

    const memberId = await createMember();
    const eventId = await createEvent({ startsMinutes: 80 });
    await book(memberId, eventId);

    const res = await run();
    expect(res.body.candidates).toBeGreaterThanOrEqual(1);
    expect(res.body.created).toBeGreaterThanOrEqual(1);
    expect(res.body.capped).toBe(false);
    expect(res.body.failures).toBeUndefined();
  });
});

// §1/§7 — that a member's own booking raises no alert at all is asserted on the
// routes' own source in `booking-reminders.unit.test.ts`: the alert it removes
// was fire-and-forget, so a `.then()` that silently never ran would make an HTTP
// assertion pass for the wrong reason.
