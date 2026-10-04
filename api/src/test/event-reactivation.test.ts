// #979 — Reactivate a cancelled event: `Scheduled → Cancelled → Scheduled`.
//
// What this file pins down is the half of the ticket that is a *property of
// the existing data model* rather than new code: cancelling a session never
// touched `calendar_event_bookings`, so the enrolled members, the waitlist and
// its ordering survive the round trip untouched, and reactivation inserts
// nothing (§4, §5, §11). The rest is the gate (only a cancelled event, and
// only while its slot is still free), the member alert and the audit row.

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
let centerId: number;
let spaceId: number;
let activityTypeId: number;
let shareableActivityTypeId: number;
let trainerMembershipId: number;

function headers(gid = gymId) {
  return { Authorization: TEST_AUTH_HEADER, 'x-gym-id': gid };
}

/**
 * A session relative to now, so "has it ended" is real.
 * `slot: false` leaves trainer and space off, which is the shape that has no
 * concurrency rule to satisfy.
 */
async function createSession(opts: {
  startsHours: number;
  endsHours: number;
  status?: string;
  slot?: boolean;
  activityTypeId?: number;
}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events
       (gym_id, center_id, title, activity_type_id, trainer_membership_id, space_id,
        starts_at, ends_at, status)
     VALUES (?, ?, 'Personal Training', ?, ?, ?,
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR),
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), ?)`,
    [
      gymId, centerId, opts.activityTypeId ?? activityTypeId,
      opts.slot === false ? null : trainerMembershipId,
      opts.slot === false ? null : spaceId,
      opts.startsHours, opts.endsHours, opts.status ?? 'scheduled',
    ],
  );
  return insertId;
}

async function createMember(): Promise<number> {
  const email = `reactivate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Reactivate Member', ?)`,
    [gymId, email],
  );
  await db.query(
    `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at)
     VALUES (?, ?, ?, 1, UTC_TIMESTAMP())`,
    [gymId, insertId, centerId],
  );
  return insertId;
}

async function book(
  memberId: number,
  eventId: number,
  status: 'booked' | 'waitlisted' = 'booked',
  waitlistPosition: number | null = null,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_event_bookings
       (gym_id, center_id, member_id, calendar_event_id, status, attendance_status,
        waitlist_position, booked_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, UTC_TIMESTAMP())`,
    [gymId, centerId, memberId, eventId, status, waitlistPosition],
  );
  return insertId;
}

async function cancel(id: number, reason = 'Trainer ill') {
  const res = await request
    .post(`/class-sessions/${id}/cancel`)
    .set(headers())
    .send({ cancellation_reason: reason });
  expect(res.status).toBe(204);
}

function reactivate(id: number, gid = gymId) {
  return request.post(`/class-sessions/${id}/reactivate`).set(headers(gid));
}

async function bookingRows(eventId: number) {
  const { rows } = await db.query(
    `SELECT id, member_id, status, waitlist_position, booked_at
     FROM calendar_event_bookings WHERE calendar_event_id = ? ORDER BY id ASC`,
    [eventId],
  );
  return rows;
}

beforeAll(async () => {
  gymId      = await createTestGym('Reactivate Gym');
  otherGymId = await createTestGym('Reactivate Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');

  const { insertId: cid } = await db.query(
    `INSERT INTO centers (gym_id, name, status) VALUES (?, 'Reactivate Center', 'active')`,
    [gymId],
  );
  centerId = cid;

  const { insertId: sid } = await db.query(
    `INSERT INTO spaces (gym_id, center_id, name, capacity, status) VALUES (?, ?, 'Studio R', 20, 'active')`,
    [gymId, centerId],
  );
  spaceId = sid;

  const { insertId: atid } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, ?, 4, 'active')`,
    [gymId, `ReactivateClass-${Date.now()}`],
  );
  activityTypeId = atid;

  const { insertId: atid2 } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status, is_shareable)
     VALUES (?, ?, 4, 'active', 1)`,
    [gymId, `ReactivateShareable-${Date.now()}`],
  );
  shareableActivityTypeId = atid2;

  await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role, status, name)
     VALUES (?, ?, 'trainer_performance', 'active', 'Coach R')`,
    [`reactivate-trainer-${Date.now()}`, gymId],
  );
  const { rows } = await db.query(
    `SELECT id FROM gym_memberships WHERE gym_id = ? AND role = 'trainer_performance' ORDER BY id DESC LIMIT 1`,
    [gymId],
  );
  trainerMembershipId = rows[0].id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('POST /class-sessions/:id/reactivate — the transition (#979)', () => {
  it('puts a cancelled event back to scheduled on the same row', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25, slot: false });
    await cancel(id);

    const res = await reactivate(id);
    expect(res.status).toBe(200);
    // §3 — the original row, back to Scheduled, with every field it had.
    expect(res.body.id).toBe(id);
    expect(res.body.status).toBe('scheduled');
    expect(res.body.execution_status).toBe('scheduled');
    expect(res.body.activity_type_id).toBe(activityTypeId);

    // §7/§11 — one event, not two.
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM calendar_events WHERE gym_id = ? AND id = ?`,
      [gymId, id],
    );
    expect(Number(rows[0].cnt)).toBe(1);
  });

  it('clears the cancellation reason it undoes', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25, slot: false });
    await cancel(id, 'Snowed in');
    const { rows: before } = await db.query(
      `SELECT cancellation_reason FROM calendar_events WHERE id = ?`, [id],
    );
    expect(before[0].cancellation_reason).toBe('Snowed in');

    expect((await reactivate(id)).status).toBe(200);
    const { rows: after } = await db.query(
      `SELECT cancellation_reason FROM calendar_events WHERE id = ?`, [id],
    );
    expect(after[0].cancellation_reason).toBeNull();
  });

  it('reactivates a cancelled event that has already passed', async () => {
    // "Cancelled by mistake" is usually noticed after the class should have
    // run, so a past event is reactivatable; #977's rule then classifies it.
    const id = await createSession({ startsHours: -3, endsHours: -2, slot: false });
    await cancel(id);
    const res = await reactivate(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('scheduled');
    // Nobody on it, and it has ended — #977 says `not_used`, not `scheduled`.
    expect(res.body.execution_status).toBe('not_used');
  });

  it('refuses an event that is not cancelled, and is idempotent under a second call', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25, slot: false });
    const first = await reactivate(id);
    expect(first.status).toBe(400);
    expect(first.body.code).toBe('not_cancelled');

    await cancel(id);
    expect((await reactivate(id)).status).toBe(200);
    const second = await reactivate(id);
    expect(second.status).toBe(400);
    expect(second.body.code).toBe('not_cancelled');
  });

  it('refuses a completed event (Completed is not part of this flow)', async () => {
    const id = await createSession({ startsHours: -3, endsHours: -2, status: 'completed', slot: false });
    const res = await reactivate(id);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_cancelled');
  });

  it('404s a session from another gym (tenant isolation)', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25, slot: false });
    await cancel(id);
    expect((await reactivate(id, otherGymId)).status).toBe(404);
    const { rows } = await db.query(`SELECT status FROM calendar_events WHERE id = ?`, [id]);
    expect(rows[0].status).toBe('cancelled');
  });

  it('404s a manual calendar entry — this router answers for sessions only', async () => {
    const { insertId } = await db.query(
      `INSERT INTO calendar_events (gym_id, center_id, title, starts_at, ends_at, status)
       VALUES (?, ?, 'Open slot',
               DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR),
               DATE_ADD(UTC_TIMESTAMP(), INTERVAL 25 HOUR), 'cancelled')`,
      [gymId, centerId],
    );
    expect((await reactivate(insertId)).status).toBe(404);
  });

  it('requires authentication', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25, slot: false });
    await cancel(id);
    const res = await request.post(`/class-sessions/${id}/reactivate`).set({ 'x-gym-id': gymId });
    expect(res.status).toBe(401);
  });
});

describe('Reactivation preserves enrollments rather than recreating them (#979)', () => {
  it('keeps the enrolled member, their booking row and its id', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25, slot: false });
    const memberId = await createMember();
    const bookingId = await book(memberId, id);

    await cancel(id);
    // §4 — the cancellation never touched the booking in the first place.
    expect((await bookingRows(id)).map((r: any) => r.id)).toEqual([bookingId]);

    const res = await reactivate(id);
    expect(res.status).toBe(200);
    expect(Number(res.body.booked_count)).toBe(1);

    const rows = await bookingRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(bookingId);
    expect(rows[0].member_id).toBe(memberId);
    expect(rows[0].status).toBe('booked');
  });

  it('keeps the waiting list and its ordering', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25, slot: false });
    const booked = await createMember();
    await book(booked, id);
    const first = await createMember();
    const second = await createMember();
    await book(first, id, 'waitlisted', 1);
    await book(second, id, 'waitlisted', 2);

    await cancel(id);
    const res = await reactivate(id);
    expect(res.status).toBe(200);
    // §5 — same queue, same positions.
    expect(Number(res.body.waitlist_count)).toBe(2);
    const queue = (await bookingRows(id))
      .filter((r: any) => r.status === 'waitlisted')
      .map((r: any) => [r.member_id, r.waitlist_position]);
    expect(queue).toEqual([[first, 1], [second, 2]]);
  });

  it('creates no duplicate booking and no duplicate waitlist entry', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25, slot: false });
    const memberId = await createMember();
    await book(memberId, id);
    const waiting = await createMember();
    await book(waiting, id, 'waitlisted', 1);

    await cancel(id);
    await reactivate(id);
    await reactivate(id); // the second call is refused, so it cannot double up

    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM calendar_event_bookings WHERE calendar_event_id = ?`,
      [id],
    );
    expect(Number(rows[0].cnt)).toBe(2);
  });

  it('leaves a booking the member cancelled themselves cancelled', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25, slot: false });
    const memberId = await createMember();
    const bookingId = await book(memberId, id);
    await db.query(`UPDATE calendar_event_bookings SET status = 'cancelled' WHERE id = ?`, [bookingId]);

    await cancel(id);
    const res = await reactivate(id);
    expect(res.status).toBe(200);
    // Reactivating the event is not a licence to re-book somebody who left.
    expect(Number(res.body.booked_count)).toBe(0);
    const rows = await bookingRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('cancelled');
  });
});

describe('Reactivation and the trainer/space slot (#979)', () => {
  it('refuses when another session has taken the slot since the cancellation', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25 });
    await cancel(id);

    // The cancellation freed the slot — every conflict check in the router
    // skips `cancelled` rows — so this one is allowed in.
    const { rows: slot } = await db.query(
      `SELECT starts_at, ends_at FROM calendar_events WHERE id = ?`, [id],
    );
    await db.query(
      `INSERT INTO calendar_events
         (gym_id, center_id, title, activity_type_id, trainer_membership_id, space_id,
          starts_at, ends_at, status)
       VALUES (?, ?, 'Replacement', ?, ?, ?, ?, ?, 'scheduled')`,
      [gymId, centerId, activityTypeId, trainerMembershipId, spaceId,
       slot[0].starts_at, slot[0].ends_at],
    );

    const res = await reactivate(id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('slot_fully_occupied');
    // Refused means refused: the event is still cancelled.
    const { rows } = await db.query(`SELECT status FROM calendar_events WHERE id = ?`, [id]);
    expect(rows[0].status).toBe('cancelled');
  });

  it('allows it back into a slot that is still free', async () => {
    const id = await createSession({ startsHours: 48, endsHours: 49 });
    await cancel(id);
    const res = await reactivate(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('scheduled');
  });

  it('ignores a cancelled neighbour when deciding whether the slot is free', async () => {
    const id = await createSession({ startsHours: 72, endsHours: 73 });
    const neighbour = await createSession({ startsHours: 72, endsHours: 73 });
    await cancel(neighbour);
    await cancel(id);
    expect((await reactivate(id)).status).toBe(200);
  });

  it('applies the shared-training rule, not a looser one, to a shareable activity', async () => {
    const host = await createSession({ startsHours: 96, endsHours: 97, activityTypeId: shareableActivityTypeId });
    await db.query(`UPDATE calendar_events SET allows_shared_booking = 1 WHERE id = ?`, [host]);
    const guest = await createSession({ startsHours: 96, endsHours: 97, activityTypeId: shareableActivityTypeId });
    await cancel(guest);

    // max_concurrent_groups defaults to 1 on both trainer and space, so the
    // slot is full with the host alone — the shared-training rule is the same
    // one a create or a reschedule gets, and it answers the same way.
    const res = await reactivate(guest);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('slot_fully_occupied');
  });
});

describe('Reactivation alerts and audit (#979)', () => {
  it('alerts the enrolled members with event_reactivated, not a new booking', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25, slot: false });
    const memberId = await createMember();
    await book(memberId, id);
    await cancel(id);
    expect((await reactivate(id)).status).toBe(200);

    // The insert is fire-and-forget; give it a tick to land.
    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await db.query(
      `SELECT type, payload FROM member_notifications
       WHERE gym_id = ? AND member_id = ? AND entity_id = ? ORDER BY id ASC`,
      [gymId, memberId, id],
    );
    const types = rows.map((r: any) => r.type);
    // §6 — the cancellation alert, then the reactivation one, and no
    // `booking_confirmed`: the member booked nothing.
    expect(types).toEqual(['event_cancelled', 'event_reactivated']);
    expect(types).not.toContain('booking_confirmed');
  });

  it('does not alert a waitlisted member, who was never told it was cancelled', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25, slot: false });
    const waiting = await createMember();
    await book(waiting, id, 'waitlisted', 1);
    await cancel(id);
    expect((await reactivate(id)).status).toBe(200);

    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM member_notifications
       WHERE gym_id = ? AND member_id = ? AND entity_id = ?`,
      [gymId, waiting, id],
    );
    expect(Number(rows[0].cnt)).toBe(0);
  });

  it('sends nothing for a cancelled event nobody was on', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25, slot: false });
    await cancel(id);
    expect((await reactivate(id)).status).toBe(200);

    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM member_notifications WHERE gym_id = ? AND entity_id = ?`,
      [gymId, id],
    );
    expect(Number(rows[0].cnt)).toBe(0);
  });

  it('records the transition, the reason it undid and who got their place back', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25, slot: false });
    const memberId = await createMember();
    await book(memberId, id);
    const waiting = await createMember();
    await book(waiting, id, 'waitlisted', 1);
    await cancel(id, 'Double booked');
    expect((await reactivate(id)).status).toBe(200);

    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await db.query(
      `SELECT action, previous_values, new_values, actor_name
       FROM audit_logs
       WHERE gym_id = ? AND entity_type = 'class_session' AND entity_id = ? AND action = 'reactivate'`,
      [gymId, String(id)],
    );
    expect(rows).toHaveLength(1);
    // `audit_logs.previous_values` / `new_values` are JSON columns, so mysql2
    // hands them back already parsed.
    const asObject = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
    const prev = asObject(rows[0].previous_values);
    const next = asObject(rows[0].new_values);
    // §9 — both ends of the transition, and the reason, which the column no
    // longer holds.
    expect(prev).toMatchObject({ status: 'cancelled', cancellation_reason: 'Double booked' });
    expect(next).toMatchObject({ status: 'scheduled', cancellation_reason: null });
    expect(next.restored_member_ids).toEqual([memberId]);
    expect(next.restored_waitlist_member_ids).toEqual([waiting]);
  });

  it('offers reactivate as a filterable audit action', async () => {
    const res = await request.get('/audit-logs/meta').set(headers());
    expect(res.status).toBe(200);
    expect(res.body.actions).toContain('reactivate');
  });
});
