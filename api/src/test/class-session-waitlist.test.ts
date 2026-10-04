// #980 stage 2 — the Waitlist setting on one calendar event.
//
// What this file pins down is the half of the ticket that writes member-facing
// state, which is why it is separate from stage 1's `class-session-details`:
// the three modes are editable on the occurrence and nowhere else (§12), moving
// to `disabled` takes everybody off the waiting list and alerts them (§4/§5),
// moving to `closed` deliberately does not, the change and the emptying are one
// transaction (§9), and every move is in the audit log previous → new (§11).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  createTestStaffForMembership,
  eventually,
  request,
  TEST_AUTH_HEADER,
} from './helpers';

let gymId: string;
let otherGymId: string;
let centerId: number;
let spaceId: number;
/** `waitlist_mode = 'open'`, so an occurrence of it inherits an open queue. */
let openActivityId: number;
/** `waitlist_mode = 'disabled'`, for the inheritance assertions. */
let disabledActivityId: number;
let trainerId: number;
let memberIds: number[] = [];

function headers(gid = gymId) {
  return { Authorization: TEST_AUTH_HEADER, 'x-gym-id': gid };
}

function put(id: number, body: Record<string, unknown>, gid = gymId) {
  return request.put(`/class-sessions/${id}`).set(headers(gid)).send(body);
}

async function createSession(opts: {
  activityTypeId?: number;
  waitlistMode?: string | null;
  capacity?: number;
  startsHours?: number;
} = {}): Promise<number> {
  const starts = opts.startsHours ?? 48;
  const { insertId } = await db.query(
    `INSERT INTO calendar_events
       (gym_id, center_id, title, activity_type_id, trainer_membership_id, space_id,
        starts_at, ends_at, capacity, waitlist_mode, status)
     VALUES (?, ?, 'Waitlist Class', ?, ?, ?,
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR),
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), ?, ?, 'scheduled')`,
    [
      gymId, centerId, opts.activityTypeId ?? openActivityId, trainerId, spaceId,
      starts, starts + 1, opts.capacity ?? 1, opts.waitlistMode ?? null,
    ],
  );
  return insertId;
}

/** Puts `count` members on the occurrence's waiting list, in order. */
async function fillWaitlist(sessionId: number, count: number): Promise<number[]> {
  const used = memberIds.slice(0, count);
  for (let i = 0; i < used.length; i++) {
    await db.query(
      `INSERT INTO calendar_event_bookings
         (gym_id, center_id, member_id, calendar_event_id, status, waitlist_position, waitlisted_at)
       VALUES (?, ?, ?, ?, 'waitlisted', ?, UTC_TIMESTAMP())`,
      [gymId, centerId, used[i], sessionId, i + 1],
    );
  }
  return used;
}

async function bookings(sessionId: number) {
  const { rows } = await db.query(
    `SELECT member_id, status, waitlist_position FROM calendar_event_bookings
     WHERE calendar_event_id = ? ORDER BY id ASC`,
    [sessionId],
  );
  return rows;
}

async function notificationsOfType(type: string, entityId: number) {
  const { rows } = await db.query(
    `SELECT member_id, payload FROM member_notifications
     WHERE gym_id = ? AND type = ? AND entity_id = ? ORDER BY id ASC`,
    [gymId, type, entityId],
  );
  return rows;
}

async function auditRows(entityId: number) {
  const { rows } = await db.query(
    `SELECT action, previous_values, new_values FROM audit_logs
     WHERE gym_id = ? AND entity_type = 'class_session' AND entity_id = ?
     ORDER BY id ASC`,
    [gymId, String(entityId)],
  );
  return rows;
}

// `audit_logs.previous_values` / `new_values` are JSON columns, so mysql2 hands
// them back already parsed — a bare `JSON.parse` sees "[object Object]".
const asObject = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);

beforeAll(async () => {
  gymId      = await createTestGym('Waitlist Gym');
  otherGymId = await createTestGym('Waitlist Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');

  const { insertId: cid } = await db.query(
    `INSERT INTO centers (gym_id, name, status) VALUES (?, 'Waitlist Center', 'active')`,
    [gymId],
  );
  centerId = cid;

  const { insertId: sid } = await db.query(
    `INSERT INTO spaces (gym_id, center_id, name, capacity, status) VALUES (?, ?, 'Studio W', 20, 'active')`,
    [gymId, centerId],
  );
  spaceId = sid;

  const { insertId: atOpen } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status, waitlist_mode)
     VALUES (?, ?, 1, 'active', 'open')`,
    [gymId, `WaitlistOpen-${Date.now()}`],
  );
  openActivityId = atOpen;

  const { insertId: atOff } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status, waitlist_mode)
     VALUES (?, ?, 1, 'active', 'disabled')`,
    [gymId, `WaitlistOff-${Date.now()}`],
  );
  disabledActivityId = atOff;

  await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role, status, name)
     VALUES (?, ?, 'trainer_performance', 'active', 'Coach W')`,
    [`waitlist-trainer-${Date.now()}`, gymId],
  );
  const { rows: tr } = await db.query(
    `SELECT id FROM gym_memberships WHERE gym_id = ? AND name = 'Coach W' ORDER BY id DESC LIMIT 1`,
    [gymId],
  );
  trainerId = tr[0].id;
  // #986: a trainer is an active Staff record, not a coach role on the login.
  await createTestStaffForMembership(gymId, trainerId, 'Coach', 'W');

  for (let i = 0; i < 4; i++) {
    const { insertId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
      [gymId, `Waitlist Member ${i}`, `waitlist-${Date.now()}-${i}@example.com`],
    );
    memberIds.push(insertId);
  }
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('PUT /class-sessions/:id — the Waitlist setting (#980 §3)', () => {
  it('writes the occurrence\'s own mode and reports it beside the effective one', async () => {
    const id = await createSession();

    const res = await put(id, { waitlist_mode: 'closed' });
    expect(res.status).toBe(200);
    expect(res.body.waitlist_mode).toBe('closed');
    expect(res.body.effective_waitlist_mode).toBe('closed');
  });

  it('inherits the Activity Type\'s mode until the occurrence has one of its own', async () => {
    const id = await createSession({ activityTypeId: disabledActivityId });
    const before = await request.get(`/class-sessions/${id}`).set(headers());
    expect(before.body.waitlist_mode).toBeNull();
    expect(before.body.effective_waitlist_mode).toBe('disabled');

    const res = await put(id, { waitlist_mode: 'open' });
    expect(res.body.effective_waitlist_mode).toBe('open');
  });

  it('restores inheritance when the field is sent null', async () => {
    const id = await createSession({ waitlistMode: 'closed' });
    const res = await put(id, { waitlist_mode: null });
    expect(res.status).toBe(200);
    expect(res.body.waitlist_mode).toBeNull();
    // Back to the Activity Type's own setting, which is `open` here.
    expect(res.body.effective_waitlist_mode).toBe('open');
  });

  it('keeps the stored mode when the request never mentions it', async () => {
    const id = await createSession({ waitlistMode: 'closed' });
    const res = await put(id, { trainer_membership_id: trainerId });
    expect(res.status).toBe(200);
    expect(res.body.waitlist_mode).toBe('closed');
  });

  it('refuses an unknown mode rather than coercing it', async () => {
    const id = await createSession({ waitlistMode: 'open' });
    const res = await put(id, { waitlist_mode: 'enabled' });
    expect(res.status).toBe(400);
    const { rows } = await db.query(`SELECT waitlist_mode FROM calendar_events WHERE id = ?`, [id]);
    expect(rows[0].waitlist_mode).toBe('open');
  });

  it('leaves the Activity Type\'s own default untouched (§12)', async () => {
    const id = await createSession();
    await put(id, { waitlist_mode: 'disabled' });

    const { rows } = await db.query(`SELECT waitlist_mode FROM activity_types WHERE id = ?`, [openActivityId]);
    expect(rows[0].waitlist_mode).toBe('open');
  });

  it('leaves every other occurrence of the same activity alone', async () => {
    const edited    = await createSession({ startsHours: 72 });
    const untouched = await createSession({ startsHours: 96 });
    await put(edited, { waitlist_mode: 'disabled' });

    const { rows } = await db.query(`SELECT waitlist_mode FROM calendar_events WHERE id = ?`, [untouched]);
    expect(rows[0].waitlist_mode).toBeNull();
  });

  it('is 404 for an occurrence of another gym', async () => {
    const id = await createSession();
    const res = await put(id, { waitlist_mode: 'disabled' }, otherGymId);
    expect(res.status).toBe(404);
    const { rows } = await db.query(`SELECT waitlist_mode FROM calendar_events WHERE id = ?`, [id]);
    expect(rows[0].waitlist_mode).toBeNull();
  });
});

describe('Disabling the waiting list empties it (#980 §5)', () => {
  it('takes every waitlisted member off, as cancelled', async () => {
    const id = await createSession({ waitlistMode: 'open' });
    const waiting = await fillWaitlist(id, 3);

    const res = await put(id, { waitlist_mode: 'disabled' });
    expect(res.status).toBe(200);
    expect(res.body.waitlist_count).toBe(0);

    const rows = await bookings(id);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe('cancelled');
      expect(waiting).toContain(row.member_id);
    }
  });

  it('alerts each removed member with waitlist_closed, and nothing else', async () => {
    const id = await createSession({ waitlistMode: 'open', startsHours: 50 });
    const waiting = await fillWaitlist(id, 2);

    await put(id, { waitlist_mode: 'disabled' });

    // The alert is fire-and-forget, so it lands just after the response.
    const closed = await eventually(
      () => notificationsOfType('waitlist_closed', id),
      (rows) => rows.length >= waiting.length,
    );
    expect(closed.map((r: any) => r.member_id).sort()).toEqual([...waiting].sort());
    // §4 — it must not read as a booking cancellation, so the booking
    // vocabulary is never used for this.
    expect(await notificationsOfType('event_cancelled', id)).toHaveLength(0);
    expect(await notificationsOfType('booking_confirmed', id)).toHaveLength(0);
  });

  it('never touches a booked member, and never alerts them', async () => {
    const id = await createSession({ waitlistMode: 'open', capacity: 1, startsHours: 52 });
    const booked = memberIds[3];
    await db.query(
      `INSERT INTO calendar_event_bookings
         (gym_id, center_id, member_id, calendar_event_id, status, booked_at)
       VALUES (?, ?, ?, ?, 'booked', UTC_TIMESTAMP())`,
      [gymId, centerId, booked, id],
    );
    const waiting = await fillWaitlist(id, 1);

    await put(id, { waitlist_mode: 'disabled' });

    const rows = await bookings(id);
    expect(rows.find((r: any) => r.member_id === booked).status).toBe('booked');
    expect(rows.find((r: any) => r.member_id === waiting[0]).status).toBe('cancelled');

    const closed = await eventually(
      () => notificationsOfType('waitlist_closed', id),
      (r) => r.length >= 1,
    );
    expect(closed.map((r: any) => r.member_id)).toEqual([waiting[0]]);
  });

  it('promotes nobody — a closed queue is not a freed place', async () => {
    const id = await createSession({ waitlistMode: 'open', capacity: 5, startsHours: 54 });
    const waiting = await fillWaitlist(id, 2);

    await put(id, { waitlist_mode: 'disabled' });

    const rows = await bookings(id);
    expect(rows.every((r: any) => r.status === 'cancelled')).toBe(true);
    expect(await notificationsOfType('promoted_from_waitlist', id)).toHaveLength(0);
    expect(waiting).toHaveLength(2);
  });

  it('is idempotent: disabling again removes nobody and alerts nobody', async () => {
    const id = await createSession({ waitlistMode: 'open', startsHours: 56 });
    await fillWaitlist(id, 1);
    await put(id, { waitlist_mode: 'disabled' });
    await eventually(() => notificationsOfType('waitlist_closed', id), (r) => r.length >= 1);

    await put(id, { waitlist_mode: 'disabled' });
    expect(await notificationsOfType('waitlist_closed', id)).toHaveLength(1);
  });
});

describe('Closing the waiting list keeps it (#980 §3, the three-state column)', () => {
  it('leaves every waitlisted member, and their order, exactly as they were', async () => {
    const id = await createSession({ waitlistMode: 'open', startsHours: 58 });
    const waiting = await fillWaitlist(id, 3);

    const res = await put(id, { waitlist_mode: 'closed' });
    expect(res.status).toBe(200);
    expect(res.body.waitlist_count).toBe(3);

    const rows = await bookings(id);
    expect(rows.map((r: any) => r.status)).toEqual(['waitlisted', 'waitlisted', 'waitlisted']);
    expect(rows.map((r: any) => r.waitlist_position)).toEqual([1, 2, 3]);
    expect(rows.map((r: any) => r.member_id)).toEqual(waiting);
    expect(await notificationsOfType('waitlist_closed', id)).toHaveLength(0);
  });

  it('stops new joins without removing anybody', async () => {
    const id = await createSession({ waitlistMode: 'closed', startsHours: 60 });
    const res = await request.post('/bookings').set(headers())
      .send({ member_id: memberIds[0], class_session_id: id, waitlist: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('waitlist_not_open');
  });
});

describe('The audit log carries the change (#980 §11)', () => {
  it('records previous → new for the mode, and who it removed', async () => {
    const id = await createSession({ waitlistMode: 'open', startsHours: 62 });
    const waiting = await fillWaitlist(id, 2);

    await put(id, { waitlist_mode: 'disabled' });

    const rows = await eventually(() => auditRows(id), (r) => r.length >= 1);
    const last = rows[rows.length - 1];
    expect(last.action).toBe('update');
    expect(asObject(last.previous_values).waitlist_mode).toBe('open');
    expect(asObject(last.new_values).waitlist_mode).toBe('disabled');
    // The consequence of the change rides the same row rather than becoming a
    // second one: a gym reading `open → disabled` is being told who it cost.
    expect(asObject(last.new_values).removed_waitlist_member_ids.sort())
      .toEqual([...waiting].sort());
  });

  it('records a move from inheriting to an explicit mode', async () => {
    const id = await createSession({ startsHours: 64 });
    await put(id, { waitlist_mode: 'closed' });

    const rows = await eventually(() => auditRows(id), (r) => r.length >= 1);
    const last = rows[rows.length - 1];
    expect(asObject(last.previous_values).waitlist_mode).toBeNull();
    expect(asObject(last.new_values).waitlist_mode).toBe('closed');
    expect(asObject(last.new_values).removed_waitlist_member_ids).toBeUndefined();
  });

  it('writes no audit row when the mode did not actually move', async () => {
    const id = await createSession({ waitlistMode: 'closed', startsHours: 66 });
    await put(id, { waitlist_mode: 'closed' });
    expect(await auditRows(id)).toHaveLength(0);
  });

  it('records the mode beside the other fields of one save (§9)', async () => {
    const id = await createSession({ waitlistMode: 'open', startsHours: 68 });
    await put(id, { waitlist_mode: 'closed', trainer_membership_id: null });

    const rows = await eventually(() => auditRows(id), (r) => r.length >= 1);
    const next = asObject(rows[rows.length - 1].new_values);
    expect(next.waitlist_mode).toBe('closed');
    expect(next.trainer_membership_id).toBeNull();
  });
});

describe('Staff add and remove on the waiting list are alerted (#980 Q2)', () => {
  it('alerts a member staff put on the waiting list', async () => {
    const id = await createSession({ waitlistMode: 'open', startsHours: 70 });
    const res = await request.post('/bookings').set(headers())
      .send({ member_id: memberIds[0], class_session_id: id, waitlist: true });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('waitlisted');

    const joined = await eventually(
      () => notificationsOfType('waitlist_joined', id),
      (r) => r.length >= 1,
    );
    expect(joined.map((r: any) => r.member_id)).toEqual([memberIds[0]]);
  });

  it('alerts a member staff took off the waiting list, as removed and not closed', async () => {
    const id = await createSession({ waitlistMode: 'open', startsHours: 72 });
    const added = await request.post('/bookings').set(headers())
      .send({ member_id: memberIds[1], class_session_id: id, waitlist: true });
    expect(added.status).toBe(201);

    const removal = await request.delete(`/bookings/${added.body.id}`).set(headers());
    expect(removal.status).toBe(204);

    const removed = await eventually(
      () => notificationsOfType('waitlist_removed', id),
      (r) => r.length >= 1,
    );
    expect(removed.map((r: any) => r.member_id)).toEqual([memberIds[1]]);
    // The list itself is still open, so the member may rejoin — which is why
    // this is not `waitlist_closed`.
    expect(await notificationsOfType('waitlist_closed', id)).toHaveLength(0);
  });

  it('raises no waitlist alert when staff cancel an ordinary booking', async () => {
    const id = await createSession({ waitlistMode: 'open', capacity: 5, startsHours: 74 });
    const added = await request.post('/bookings').set(headers())
      .send({ member_id: memberIds[2], class_session_id: id });
    expect(added.body.status).toBe('booked');

    await request.delete(`/bookings/${added.body.id}`).set(headers());
    expect(await notificationsOfType('waitlist_removed', id)).toHaveLength(0);
    expect(await notificationsOfType('waitlist_closed', id)).toHaveLength(0);
  });
});
