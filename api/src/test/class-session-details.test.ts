// #980 stage 1 — editing an occurrence's Trainer and Space from the event.
//
// The route already accepted both fields; what this file pins down is the
// ticket's own rules around that: the two move together in one write (§9), the
// Activity Type's defaults are not touched by an occurrence's override (§12),
// the existing slot and center validation still applies (§7), and every change
// leaves an audit row carrying previous → new for the fields that moved and
// nothing else (§11).

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
let otherCenterId: number;
let spaceId: number;
let secondSpaceId: number;
let otherCenterSpaceId: number;
let inactiveSpaceId: number;
let activityTypeId: number;
let shareableActivityTypeId: number;
let trainerId: number;
let secondTrainerId: number;

function headers(gid = gymId) {
  return { Authorization: TEST_AUTH_HEADER, 'x-gym-id': gid };
}

async function createSession(opts: {
  trainer?: number | null;
  space?: number | null;
  activityTypeId?: number;
  startsHours?: number;
} = {}): Promise<number> {
  const starts = opts.startsHours ?? 48;
  const { insertId } = await db.query(
    `INSERT INTO calendar_events
       (gym_id, center_id, title, activity_type_id, trainer_membership_id, space_id,
        starts_at, ends_at, status)
     VALUES (?, ?, 'Personal Training', ?, ?, ?,
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR),
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), 'scheduled')`,
    [
      gymId, centerId, opts.activityTypeId ?? activityTypeId,
      opts.trainer === undefined ? trainerId : opts.trainer,
      opts.space === undefined ? spaceId : opts.space,
      starts, starts + 1,
    ],
  );
  return insertId;
}

function put(id: number, body: Record<string, unknown>, gid = gymId) {
  return request.put(`/class-sessions/${id}`).set(headers(gid)).send(body);
}

async function auditRows(entityId: number) {
  const { rows } = await db.query(
    `SELECT action, previous_values, new_values
     FROM audit_logs
     WHERE gym_id = ? AND entity_type = 'class_session' AND entity_id = ?
     ORDER BY id ASC`,
    [gymId, String(entityId)],
  );
  return rows;
}

async function createTrainer(label: string): Promise<number> {
  await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role, status, name)
     VALUES (?, ?, 'trainer_performance', 'active', ?)`,
    [`details-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, gymId, label],
  );
  const { rows } = await db.query(
    `SELECT id FROM gym_memberships WHERE gym_id = ? AND name = ? ORDER BY id DESC LIMIT 1`,
    [gymId, label],
  );
  return rows[0].id;
}

beforeAll(async () => {
  gymId      = await createTestGym('Session Details Gym');
  otherGymId = await createTestGym('Session Details Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');

  const { insertId: cid } = await db.query(
    `INSERT INTO centers (gym_id, name, status) VALUES (?, 'Details Center', 'active')`,
    [gymId],
  );
  centerId = cid;
  const { insertId: cid2 } = await db.query(
    `INSERT INTO centers (gym_id, name, status) VALUES (?, 'Details Other Center', 'active')`,
    [gymId],
  );
  otherCenterId = cid2;

  const space = async (name: string, center: number, status = 'active') => {
    const { insertId } = await db.query(
      `INSERT INTO spaces (gym_id, center_id, name, capacity, status) VALUES (?, ?, ?, 20, ?)`,
      [gymId, center, name, status],
    );
    return insertId as number;
  };
  spaceId            = await space('Studio D1', centerId);
  secondSpaceId      = await space('Studio D2', centerId);
  otherCenterSpaceId = await space('Studio Elsewhere', otherCenterId);
  inactiveSpaceId    = await space('Studio Closed', centerId, 'inactive');

  const { insertId: atid } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status, default_space_id, default_trainer_membership_id)
     VALUES (?, ?, 6, 'active', ?, NULL)`,
    [gymId, `DetailsClass-${Date.now()}`, spaceId],
  );
  activityTypeId = atid;

  const { insertId: atid2 } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status, is_shareable)
     VALUES (?, ?, 6, 'active', 1)`,
    [gymId, `DetailsShareable-${Date.now()}`],
  );
  shareableActivityTypeId = atid2;

  trainerId       = await createTrainer('Coach D1');
  secondTrainerId = await createTrainer('Coach D2');

  // The Activity Type's default trainer is the one §12 must leave alone.
  await db.query(
    `UPDATE activity_types SET default_trainer_membership_id = ? WHERE id = ?`,
    [trainerId, activityTypeId],
  );
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('PUT /class-sessions/:id — Trainer and Space on one occurrence (#980 §6/§7/§9)', () => {
  it('writes both fields in one request and returns the new values', async () => {
    const id = await createSession();

    const res = await put(id, { trainer_membership_id: secondTrainerId, space_id: secondSpaceId });
    expect(res.status).toBe(200);
    expect(res.body.trainer_membership_id).toBe(secondTrainerId);
    expect(res.body.trainer_name).toBe('Coach D2');
    expect(res.body.space_id).toBe(secondSpaceId);
    expect(res.body.space_name).toBe('Studio D2');
  });

  it('leaves the Activity Type\'s own defaults untouched (§12)', async () => {
    const id = await createSession();
    await put(id, { trainer_membership_id: secondTrainerId, space_id: secondSpaceId });

    const { rows } = await db.query(
      `SELECT default_space_id, default_trainer_membership_id FROM activity_types WHERE id = ?`,
      [activityTypeId],
    );
    expect(rows[0].default_space_id).toBe(spaceId);
    expect(rows[0].default_trainer_membership_id).toBe(trainerId);
  });

  it('leaves every other occurrence of the same activity alone', async () => {
    const edited = await createSession({ startsHours: 72 });
    const untouched = await createSession({ startsHours: 96 });

    await put(edited, { trainer_membership_id: secondTrainerId });

    const { rows } = await db.query(
      `SELECT trainer_membership_id FROM calendar_events WHERE id = ?`,
      [untouched],
    );
    expect(rows[0].trainer_membership_id).toBe(trainerId);
  });

  it('clears the trainer when the field is sent empty, and keeps the space', async () => {
    const id = await createSession();
    const res = await put(id, { trainer_membership_id: null });
    expect(res.status).toBe(200);
    expect(res.body.trainer_membership_id).toBeNull();
    expect(res.body.space_id).toBe(spaceId);
  });

  it('keeps a field the request never mentioned', async () => {
    const id = await createSession();
    const res = await put(id, { space_id: secondSpaceId });
    expect(res.status).toBe(200);
    expect(res.body.trainer_membership_id).toBe(trainerId);
  });

  it('refuses a space belonging to another center (400), writing nothing', async () => {
    const id = await createSession();
    const res = await put(id, { trainer_membership_id: secondTrainerId, space_id: otherCenterSpaceId });
    expect(res.status).toBe(400);

    // §9: a rejected save leaves the occurrence exactly as it was — including
    // the trainer the same request tried to change.
    const { rows } = await db.query(
      `SELECT trainer_membership_id, space_id FROM calendar_events WHERE id = ?`,
      [id],
    );
    expect(rows[0].trainer_membership_id).toBe(trainerId);
    expect(rows[0].space_id).toBe(spaceId);
  });

  it('refuses an inactive space (400)', async () => {
    const id = await createSession();
    const res = await put(id, { space_id: inactiveSpaceId });
    expect(res.status).toBe(400);
  });

  it('refuses a trainer from another gym (404)', async () => {
    const { insertId: foreignTrainer } = await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, name)
       VALUES (?, ?, 'trainer_performance', 'active', 'Foreign Coach')`,
      [`details-foreign-${Date.now()}`, otherGymId],
    );
    const id = await createSession();
    const res = await put(id, { trainer_membership_id: foreignTrainer });
    expect(res.status).toBe(404);
  });

  it('answers 404 for an occurrence of another gym', async () => {
    const id = await createSession();
    const res = await put(id, { trainer_membership_id: secondTrainerId }, otherGymId);
    expect(res.status).toBe(404);
  });

  it('answers 401 without authentication', async () => {
    const id = await createSession();
    const res = await request.put(`/class-sessions/${id}`).set({ 'x-gym-id': gymId }).send({ space_id: secondSpaceId });
    expect(res.status).toBe(401);
  });

  it('still applies the shared-slot rule when the move re-occupies a taken slot (§7)', async () => {
    // Two non-shareable occurrences cannot share one (trainer, space, time).
    const host = await createSession({ startsHours: 120, trainer: trainerId, space: spaceId });
    const mover = await createSession({ startsHours: 120, trainer: secondTrainerId, space: secondSpaceId });
    expect(host).toBeTruthy();

    const res = await put(mover, { trainer_membership_id: trainerId, space_id: spaceId });
    expect(res.status).toBe(409);
    expect(['slot_fully_occupied', 'slot_not_shareable', 'activity_not_shareable', 'sharing_not_authorized'])
      .toContain(res.body.code);
  });
});

describe('PUT /class-sessions/:id — the audit row (#980 §11)', () => {
  it('records previous → new for the fields that changed, and only those', async () => {
    const id = await createSession();
    await put(id, { trainer_membership_id: secondTrainerId, space_id: secondSpaceId });

    const rows = await eventually(() => auditRows(id), (r) => r.length > 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('update');

    const previous = JSON.parse(rows[0].previous_values);
    const next = JSON.parse(rows[0].new_values);
    // The FK is enriched to `{ id, name }`, so the log reads as names.
    expect(previous.trainer_membership.name).toBe('Coach D1');
    expect(next.trainer_membership.name).toBe('Coach D2');
    expect(previous.space.name).toBe('Studio D1');
    expect(next.space.name).toBe('Studio D2');
    // Nothing else moved, so nothing else is in the payload.
    expect(Object.keys(next).sort()).toEqual(['space', 'trainer_membership']);
  });

  it('writes no audit row for a save that changed nothing', async () => {
    const id = await createSession();
    const res = await put(id, { trainer_membership_id: trainerId, space_id: spaceId });
    expect(res.status).toBe(200);

    // Give the fire-and-forget writer the same chance it gets above.
    const rows = await eventually(() => auditRows(id), (r) => r.length > 0, 1000);
    expect(rows).toHaveLength(0);
  });

  it('records a cleared field as NULL', async () => {
    const id = await createSession();
    await put(id, { trainer_membership_id: null });

    const rows = await eventually(() => auditRows(id), (r) => r.length > 0);
    expect(rows).toHaveLength(1);
    const previous = JSON.parse(rows[0].previous_values);
    const next = JSON.parse(rows[0].new_values);
    expect(previous.trainer_membership.name).toBe('Coach D1');
    expect(next.trainer_membership_id).toBeNull();
  });

  it('records a time change made through the shared-slot write path', async () => {
    // With a trainer *and* a space, a move re-checks the slot under
    // `FOR UPDATE` — a different branch of the route, ending at the same
    // audit row, which is why the two were unified rather than copied.
    const id = await createSession();
    const starts = new Date(Date.now() + 200 * 3600 * 1000);
    const ends = new Date(starts.getTime() + 3600 * 1000);
    const res = await put(id, { starts_at: starts.toISOString(), ends_at: ends.toISOString() });
    expect(res.status).toBe(200);

    const rows = await eventually(() => auditRows(id), (r) => r.length > 0);
    expect(rows).toHaveLength(1);
    expect(Object.keys(JSON.parse(rows[0].new_values)).sort()).toEqual(['ends_at', 'starts_at']);
  });

  it('records the professional service when it is the only change', async () => {
    // A gym-owned service, enabled for this gym — the set
    // `validateProfessionalServiceId()` accepts. It cascades with the gym.
    const { insertId: serviceId } = await db.query(
      `INSERT INTO professional_services (gym_id, name, is_system) VALUES (?, ?, 0)`,
      [gymId, `Details Service ${Date.now()}`],
    );
    await db.query(
      `INSERT INTO gym_professional_services (gym_id, professional_service_id, status)
       VALUES (?, ?, 'active')`,
      [gymId, serviceId],
    );

    const id = await createSession();
    const res = await put(id, { professional_service_id: serviceId });
    expect(res.status).toBe(200);

    const rows = await eventually(() => auditRows(id), (r) => r.length > 0);
    expect(rows).toHaveLength(1);
    expect(Object.keys(JSON.parse(rows[0].new_values))).toEqual(['professional_service']);
  });
});

describe('GET /class-sessions/:id — what the panel reads (#980 §8)', () => {
  it('projects the occurrence\'s own trainer, space and professional service', async () => {
    const id = await createSession();
    const res = await request.get(`/class-sessions/${id}`).set(headers());
    expect(res.status).toBe(200);
    // The scheduled trainer is the field the editor writes; the covering
    // trainer (#193) is reported beside it and is not part of this form.
    expect(res.body).toMatchObject({
      trainer_membership_id: trainerId,
      trainer_name: 'Coach D1',
      space_id: spaceId,
      space_name: 'Studio D1',
      center_id: centerId,
    });
    expect(res.body).toHaveProperty('effective_trainer_name');
    expect(res.body).toHaveProperty('professional_service_name');
  });
});
