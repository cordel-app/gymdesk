// #977 — the Admin app's event execution status, end to end.
//
// The rule itself is unit-tested (`event-execution-status.unit.test.ts`); what
// this file covers is that the two admin-facing routers actually report it,
// over real rows and real booking aggregates, and that the two explicit
// transitions (`Mark as completed`, `Cancel event`) land where the ticket says
// they do.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  eventually,
  request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let centerId: number;
let activityTypeId: number;
let trainerMembershipId: number;

const FROM = '2020-01-01T00:00:00';
const TO   = '2099-12-31T23:59:59';

function headers(gid = gymId) {
  return { Authorization: TEST_AUTH_HEADER, 'x-gym-id': gid };
}

/** A session whose window is relative to now, so "has it ended" is real. */
async function createSession(opts: {
  startsHours: number;
  endsHours: number;
  status?: string;
  trainer?: boolean;
}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events
       (gym_id, center_id, title, activity_type_id, trainer_membership_id, starts_at, ends_at, status)
     VALUES (?, ?, 'Personal Training', ?, ?,
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR),
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), ?)`,
    [
      gymId, centerId, activityTypeId, opts.trainer === false ? null : trainerMembershipId,
      opts.startsHours, opts.endsHours, opts.status ?? 'scheduled',
    ],
  );
  return insertId;
}

/** A manual calendar entry (activity_type_id IS NULL) over the same window. */
async function createManualEvent(opts: { startsHours: number; endsHours: number }): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, starts_at, ends_at, status)
     VALUES (?, ?, 'Open slot',
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR),
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), 'scheduled')`,
    [gymId, centerId, opts.startsHours, opts.endsHours],
  );
  return insertId;
}

async function createMember(): Promise<number> {
  const email = `exec-status-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Exec Member', ?)`,
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
  status: 'booked' | 'waitlisted' | 'cancelled' = 'booked',
  attendance: 'pending' | 'present' | 'absent' = 'present',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_event_bookings
       (gym_id, center_id, member_id, calendar_event_id, status, attendance_status, booked_at)
     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [gymId, centerId, memberId, eventId, status, attendance],
  );
  return insertId;
}

async function fetchSession(id: number, gid = gymId) {
  const res = await request.get(`/class-sessions/${id}`).set(headers(gid));
  return res;
}

beforeAll(async () => {
  gymId      = await createTestGym('Exec Status Gym');
  otherGymId = await createTestGym('Exec Status Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');

  const { insertId: cid } = await db.query(
    `INSERT INTO centers (gym_id, name, status) VALUES (?, 'Exec Center', 'active')`,
    [gymId],
  );
  centerId = cid;

  const { insertId: atid } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, ?, 4, 'active')`,
    [gymId, `ExecClass-${Date.now()}`],
  );
  activityTypeId = atid;

  await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role, status, name)
     VALUES (?, ?, 'trainer_performance', 'active', 'Coach E')`,
    [`exec-trainer-${Date.now()}`, gymId],
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

describe('GET /class-sessions reports the execution status (#977)', () => {
  it('leaves a future session scheduled', async () => {
    const id = await createSession({ startsHours: 24, endsHours: 25 });
    const res = await fetchSession(id);
    expect(res.status).toBe(200);
    expect(res.body.execution_status).toBe('scheduled');
  });

  it('reports a passed, unbooked slot as not_used with no staff action', async () => {
    const id = await createSession({ startsHours: -3, endsHours: -2 });
    const res = await fetchSession(id);
    expect(res.status).toBe(200);
    // Nothing was written to get here: the stored status is untouched.
    expect(res.body.status).toBe('scheduled');
    expect(res.body.execution_status).toBe('not_used');
    expect(Number(res.body.booked_count)).toBe(0);
  });

  it('keeps a passed, booked session awaiting confirmation', async () => {
    const id = await createSession({ startsHours: -3, endsHours: -2 });
    await book(await createMember(), id);
    const res = await fetchSession(id);
    expect(res.body.execution_status).toBe('scheduled');
  });

  it('does not count a waitlisted or cancelled booking as participation', async () => {
    const id = await createSession({ startsHours: -3, endsHours: -2 });
    await book(await createMember(), id, 'waitlisted');
    await book(await createMember(), id, 'cancelled');
    const res = await fetchSession(id);
    expect(res.body.execution_status).toBe('not_used');
    expect(Number(res.body.waitlist_count)).toBe(1);
  });

  it('reports the waitlist of this session only, not the activity type', async () => {
    const quiet = await createSession({ startsHours: 24, endsHours: 25 });
    const busy  = await createSession({ startsHours: 48, endsHours: 49 });
    await book(await createMember(), busy, 'waitlisted');
    await book(await createMember(), busy, 'waitlisted');

    expect(Number((await fetchSession(busy)).body.waitlist_count)).toBe(2);
    // Same activity type, same gym — the other occurrence's queue is its own.
    expect(Number((await fetchSession(quiet)).body.waitlist_count)).toBe(0);
  });

  it('carries the field on the list read too', async () => {
    const id = await createSession({ startsHours: -5, endsHours: -4 });
    const res = await request.get(`/class-sessions?from=${FROM}&to=${TO}`).set(headers());
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.id === id);
    expect(row.execution_status).toBe('not_used');
    expect(row).toHaveProperty('waitlist_count');
  });

  it('is invisible to another gym (tenant isolation)', async () => {
    const id = await createSession({ startsHours: -3, endsHours: -2 });
    expect((await fetchSession(id, otherGymId)).status).toBe(404);
  });
});

describe('Explicit transitions outrank the clock (#977)', () => {
  it('marks a passed, booked session as completed and preserves its bookings', async () => {
    const id = await createSession({ startsHours: -3, endsHours: -2 });
    const memberId = await createMember();
    await book(memberId, id, 'booked', 'present');

    const res = await request.post(`/class-sessions/${id}/complete`).set(headers());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.execution_status).toBe('completed');

    // §11 — booking and attendance history survive the confirmation.
    const { rows } = await db.query(
      `SELECT status, attendance_status FROM calendar_event_bookings WHERE calendar_event_id = ?`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('booked');
    expect(rows[0].attendance_status).toBe('present');
  });

  it('allows Completed with zero attendees, overriding not_used', async () => {
    // §5 — the teacher may have held the session with nobody there, and that
    // is a different fact from a slot that simply passed unbooked.
    const id = await createSession({ startsHours: -3, endsHours: -2 });
    expect((await fetchSession(id)).body.execution_status).toBe('not_used');

    const res = await request.post(`/class-sessions/${id}/complete`).set(headers());
    expect(res.status).toBe(200);
    expect(res.body.execution_status).toBe('completed');
    expect(Number(res.body.booked_count)).toBe(0);
  });

  it('records the transition, not just its destination, in the audit log', async () => {
    // §14 — previous → new status, plus `recordAudit`'s own actor and time.
    const id = await createSession({ startsHours: -3, endsHours: -2 });
    await request.post(`/class-sessions/${id}/complete`).set(headers());

    // `recordAudit()` is fire-and-forget and resolves the entity name and the
    // FK enrichment before its INSERT, so the row lands just after the
    // response — reading it straight through passes on an idle database and
    // races the pool's ten connections under a full-suite run (#980 stage 2's
    // own audit assertions use the same helper for this reason).
    const rows = await eventually(
      async () => (await db.query(
        `SELECT action, previous_values, new_values FROM audit_logs
         WHERE gym_id = ? AND entity_type = 'class_session' AND entity_id = ? AND action = 'complete'`,
        [gymId, String(id)],
      )).rows,
      (r) => r.length >= 1,
    );
    expect(rows).toHaveLength(1);
    const previous = typeof rows[0].previous_values === 'string'
      ? JSON.parse(rows[0].previous_values) : rows[0].previous_values;
    const next = typeof rows[0].new_values === 'string'
      ? JSON.parse(rows[0].new_values) : rows[0].new_values;
    expect(previous.status).toBe('scheduled');
    expect(next.status).toBe('completed');
  });

  it('keeps a cancelled slot cancelled rather than not_used, and keeps the event', async () => {
    // §6/§12 — cancelling preserves the event and its booking history.
    const id = await createSession({ startsHours: -3, endsHours: -2 });
    const memberId = await createMember();
    await book(memberId, id);

    const res = await request
      .post(`/class-sessions/${id}/cancel`)
      .set(headers())
      .send({ cancellation_reason: 'Trainer ill' });
    expect(res.status).toBe(204);

    const after = await fetchSession(id);
    expect(after.status).toBe(200);
    expect(after.body.execution_status).toBe('cancelled');
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM calendar_event_bookings WHERE calendar_event_id = ?`,
      [id],
    );
    expect(Number(rows[0].cnt)).toBe(1);
  });

  it('refuses to complete a cancelled session', async () => {
    const id = await createSession({ startsHours: -3, endsHours: -2, status: 'cancelled' });
    const res = await request.post(`/class-sessions/${id}/complete`).set(headers());
    expect(res.status).toBe(400);
  });
});

describe('GET /calendar-events reports it for manual entries too (#977)', () => {
  it('classifies a passed, unbooked manual slot as not_used', async () => {
    const id = await createManualEvent({ startsHours: -3, endsHours: -2 });
    const res = await request.get(`/calendar-events/${id}`).set(headers());
    expect(res.status).toBe(200);
    expect(res.body.execution_status).toBe('not_used');
    expect(Number(res.body.booked_count)).toBe(0);
    expect(Number(res.body.waitlist_count)).toBe(0);
  });

  it('keeps a booked manual slot awaiting confirmation', async () => {
    const id = await createManualEvent({ startsHours: -3, endsHours: -2 });
    await book(await createMember(), id);
    const res = await request.get(`/calendar-events/${id}`).set(headers());
    expect(res.body.execution_status).toBe('scheduled');
  });

  it('gives a draft event no execution status rather than inventing one', async () => {
    const id = await createManualEvent({ startsHours: -3, endsHours: -2 });
    await db.query(`UPDATE calendar_events SET status = 'draft' WHERE id = ?`, [id]);
    const res = await request.get(`/calendar-events/${id}`).set(headers());
    expect(res.body.status).toBe('draft');
    expect(res.body.execution_status).toBeNull();
  });

  it('carries the field on the list read', async () => {
    const id = await createManualEvent({ startsHours: -7, endsHours: -6 });
    const res = await request.get(`/calendar-events?from=${FROM}&to=${TO}`).set(headers());
    const row = res.body.find((r: any) => r.id === id);
    expect(row.execution_status).toBe('not_used');
  });
});
