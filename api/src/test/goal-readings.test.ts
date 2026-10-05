// Tests for the reading history of an Assigned Personal Goal (#1037 stage 2) —
// both halves of it, because the thread's `Q3` puts readings on the staff
// surface (`/member-personal-goals`) *and* the member's own
// (`/me/personal-goals`), over one set of helpers. A reading recorded on either
// side is the same row and must read back the same way, which is what the
// cross-surface cases below are for.
//
// The rules under test that are not obvious from the routes:
//   * the five computed header fields ride on every assignment-shaped read;
//   * changing the initial reading **adds** a period and overwrites nothing;
//   * progress is measured from the *active* initial reading (§25);
//   * a member reaches their own readings and nobody else's (§35).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const STAFF = '/member-personal-goals';
const ME = '/me/personal-goals';

/** Unique per run, so a re-run against the same database cannot collide. */
const RUN = `${Date.now()}`;

let gymId: string;
let otherGymId: string;
/** The gym whose member is the authenticated `/me` caller. */
let memberGymId: string;

let memberId: number;
let otherGymMemberId: number;
/** The `members` row the `/me` routes resolve the caller to. */
let selfMemberId: number;

let gymGoalId: number;
let otherGymGoalId: number;
let memberGymGoalId: number;
let secondMemberGymGoalId: number;

async function createMember(gym: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gym, name, `${name.replace(/\s+/g, '.').toLowerCase()}.${RUN}@example.com`],
  );
  return insertId as number;
}

async function createGymGoal(gym: string, name: string, target?: { value: number; unit: string }): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO personal_goals (gym_id, name, target_value, target_unit, status)
     VALUES (?, ?, ?, ?, 'active')`,
    [gym, name, target?.value ?? null, target?.unit ?? null],
  );
  return insertId as number;
}

function staff(method: 'get' | 'post' | 'put' | 'delete', path: string, gym = gymId) {
  return (request as any)[method](path)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gym);
}

/** The `/me` caller is a member of `memberGymId`; the mock resolves to TEST_USER_ID. */
function me(method: 'get' | 'post' | 'put' | 'delete', path: string, gym = memberGymId) {
  return (request as any)[method](path)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gym);
}

/** Assigns a goal through the staff route and returns the created assignment. */
async function assign(body: Record<string, unknown> = {}) {
  const res = await staff('post', STAFF).send({
    member_id: memberId, personal_goal_id: gymGoalId, ...body,
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function addReading(id: number, body: Record<string, unknown>) {
  const res = await staff('post', `${STAFF}/${id}/readings`).send(body);
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async () => {
  gymId = await createTestGym('Readings Gym');
  await createTestMembership(gymId, 'admin');

  otherGymId = await createTestGym('Readings Other Gym');
  await createTestMembership(otherGymId, 'admin');

  memberGymId = await createTestGym('Readings Member Gym');
  await createTestMembership(memberGymId, 'member');

  memberId = await createMember(gymId, `Readings Member ${RUN}`);
  otherGymMemberId = await createMember(otherGymId, `Readings Foreign Member ${RUN}`);

  const email = `readings-self-${RUN}@test.com`;
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id)
     VALUES (?, 'Readings Self', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [memberGymId, email, TEST_USER_ID],
  );
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM members WHERE clerk_user_id = ?',
    [TEST_USER_ID],
  );
  selfMemberId = rows[0].id;

  gymGoalId = await createGymGoal(gymId, `Readings Goal ${RUN}`, { value: 70, unit: 'kg' });
  otherGymGoalId = await createGymGoal(otherGymId, `Readings Foreign Goal ${RUN}`, { value: 70, unit: 'kg' });
  memberGymGoalId = await createGymGoal(memberGymId, `Readings My Goal ${RUN}`, { value: 70, unit: 'kg' });
  secondMemberGymGoalId = await createGymGoal(memberGymId, `Readings My Second Goal ${RUN}`, { value: 80, unit: 'kg' });
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('goal readings — auth', () => {
  it('returns 401 without auth', async () => {
    expect((await request.get(`${STAFF}/1/readings`)).status).toBe(401);
    expect((await request.post(`${STAFF}/1/readings`).send({ value: 80 })).status).toBe(401);
    expect((await request.post(`${STAFF}/1/initial-reading`).send({ value: 80 })).status).toBe(401);
    expect((await request.get(`${ME}/1/readings`)).status).toBe(401);
  });

  it('returns 403 on a write for a read-only role', async () => {
    const frontDeskGym = await createTestGym('Readings Front Desk Gym');
    await createTestMembership(frontDeskGym, 'front_desk');
    const member = await createMember(frontDeskGym, `Readings FD Member ${RUN}`);
    const goal = await createGymGoal(frontDeskGym, `Readings FD Goal ${RUN}`);
    const { insertId } = await db.query(
      'INSERT INTO member_personal_goals (gym_id, member_id, personal_goal_id) VALUES (?, ?, ?)',
      [frontDeskGym, member, goal],
    );

    const read = await staff('get', `${STAFF}/${insertId}/readings`, frontDeskGym);
    expect(read.status).toBe(200);
    const write = await staff('post', `${STAFF}/${insertId}/readings`, frontDeskGym).send({ value: 80 });
    expect(write.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (§35)
// ---------------------------------------------------------------------------

describe('goal readings — tenant isolation', () => {
  it('hides another gym\'s assignment from every reading route', async () => {
    const { insertId } = await db.query(
      'INSERT INTO member_personal_goals (gym_id, member_id, personal_goal_id) VALUES (?, ?, ?)',
      [otherGymId, otherGymMemberId, otherGymGoalId],
    );

    expect((await staff('get', `${STAFF}/${insertId}/readings`)).status).toBe(404);
    expect((await staff('post', `${STAFF}/${insertId}/readings`).send({ value: 80 })).status).toBe(404);
    expect((await staff('post', `${STAFF}/${insertId}/initial-reading`).send({ value: 80 })).status).toBe(404);

    // Nothing was written under the other gym either.
    const { rows } = await db.query(
      'SELECT id FROM member_personal_goal_readings WHERE member_personal_goal_id = ?',
      [insertId],
    );
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Recording readings
// ---------------------------------------------------------------------------

describe('goal readings — recording', () => {
  it('reports the ticket\'s own scenario 1 end to end', async () => {
    // §4: the initial reading may be established as the goal is assigned, and
    // §4's "reuse the existing timestamp" takes it from `start_date`.
    const assignment = await assign({
      target_value: 70, target_unit: 'kg',
      start_date: '2026-09-01',
      initial_reading: 80,
    });
    expect(assignment.initial_reading).toBe(80);
    expect(assignment.latest_reading).toBe(80);
    expect(assignment.progress_percent).toBe(0);
    expect(assignment.initial_reading_at).toBe('2026-09-01T00:00:00.000Z');

    await addReading(assignment.id, { value: 78, recorded_at: '2026-09-08' });
    await addReading(assignment.id, { value: 77, recorded_at: '2026-09-15' });
    const after = await addReading(assignment.id, { value: 75, recorded_at: '2026-09-22' });

    expect(after.initial_reading).toBe(80);
    expect(after.latest_reading).toBe(75);
    expect(after.progress_percent).toBe(50);
    expect(after.reading_count).toBe(4);
    // Chronological (§17); the history list reverses it (§19).
    expect(after.readings.map((r: any) => r.value)).toEqual([80, 78, 77, 75]);
    expect(after.readings.map((r: any) => r.is_initial)).toEqual([true, false, false, false]);
    expect(after.readings.every((r: any) => r.period === 0)).toBe(true);

    // §30: the header fields of the assignment itself are recomputed on read.
    const read = await staff('get', `${STAFF}/${assignment.id}`);
    expect(read.status).toBe(200);
    expect(read.body.latest_reading).toBe(75);
    expect(read.body.progress_percent).toBe(50);
  });

  it('defaults the time to now and keeps several readings on one date (§32/§33)', async () => {
    const assignment = await assign({ personal_goal_id: gymGoalId, member_id: await createMember(gymId, `Readings Same Day ${RUN}`) });
    await addReading(assignment.id, { value: 82.4, recorded_at: '2026-09-22T09:00:00Z' });
    const body = await addReading(assignment.id, { value: 81.9, recorded_at: '2026-09-22T18:00:00Z' });
    const now = await addReading(assignment.id, { value: 81 });

    expect(body.readings.map((r: any) => r.value)).toEqual([82.4, 81.9]);
    expect(now.reading_count).toBe(3);
    expect(now.latest_reading).toBe(81);
  });

  it('validates the value and the time (§31)', async () => {
    const assignment = await assign({ member_id: await createMember(gymId, `Readings Validation ${RUN}`) });

    for (const body of [{}, { value: 'heavy' }, { value: -1 }]) {
      const res = await staff('post', `${STAFF}/${assignment.id}/readings`).send(body);
      expect(res.status).toBe(400);
    }
    const future = await staff('post', `${STAFF}/${assignment.id}/readings`)
      .send({ value: 80, recorded_at: '2126-09-22' });
    expect(future.status).toBe(400);

    const { rows } = await db.query(
      'SELECT id FROM member_personal_goal_readings WHERE member_personal_goal_id = ?',
      [assignment.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses an initial reading that is not a number when the goal is assigned', async () => {
    const res = await staff('post', STAFF).send({
      member_id: await createMember(gymId, `Readings Bad Initial ${RUN}`),
      personal_goal_id: gymGoalId,
      initial_reading: 'heavy',
    });
    expect(res.status).toBe(400);
  });

  it('reports no readings rather than zero progress for an assignment that has none', async () => {
    const assignment = await assign({ member_id: await createMember(gymId, `Readings Empty ${RUN}`) });
    expect(assignment.initial_reading).toBeNull();
    expect(assignment.latest_reading).toBeNull();
    expect(assignment.progress_percent).toBeNull();
    expect(assignment.reading_count).toBe(0);

    const readings = await staff('get', `${STAFF}/${assignment.id}/readings`);
    expect(readings.status).toBe(200);
    expect(readings.body.readings).toEqual([]);
  });

  it('carries the summary on the list, in one query per page', async () => {
    const member = await createMember(gymId, `Readings Listed ${RUN}`);
    const assignment = await assign({ member_id: member, target_value: 70, target_unit: 'kg', initial_reading: 80 });
    await addReading(assignment.id, { value: 75 });

    const res = await staff('get', `${STAFF}?member_id=${member}`);
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: any) => i.id === assignment.id);
    expect(row.initial_reading).toBe(80);
    expect(row.latest_reading).toBe(75);
    expect(row.progress_percent).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Initial-reading periods (§21–§25, §28)
// ---------------------------------------------------------------------------

describe('goal readings — initial-reading periods', () => {
  it('adds a period and overwrites nothing (scenario 3)', async () => {
    const assignment = await assign({
      member_id: await createMember(gymId, `Readings Rebaseline ${RUN}`),
      target_value: 70, target_unit: 'kg', initial_reading: 80, start_date: '2026-09-01',
    });
    await addReading(assignment.id, { value: 78, recorded_at: '2026-09-08' });
    await addReading(assignment.id, { value: 73, recorded_at: '2026-09-29' });

    const res = await staff('post', `${STAFF}/${assignment.id}/initial-reading`)
      .send({ value: 76, recorded_at: '2026-09-30' });
    expect(res.status).toBe(201);

    // §25: progress is measured from 76, not from the 80 it started at.
    expect(res.body.initial_reading).toBe(76);
    expect(res.body.latest_reading).toBe(76);
    expect(res.body.progress_percent).toBe(0);

    // §28: every historical reading is still there, the superseded initial
    // reading included, and the new boundary opens period 1 (§38).
    expect(res.body.readings.map((r: any) => r.value)).toEqual([80, 78, 73, 76]);
    expect(res.body.readings.map((r: any) => r.is_initial)).toEqual([true, false, false, true]);
    expect(res.body.readings.map((r: any) => r.period)).toEqual([0, 0, 0, 1]);

    // A later measurement joins the new period and is measured from it.
    const next = await addReading(assignment.id, { value: 73 });
    expect(next.initial_reading).toBe(76);
    expect(next.latest_reading).toBe(73);
    expect(next.progress_percent).toBe(50);
    expect(next.readings[next.readings.length - 1].period).toBe(1);
  });

  it('supports any number of changes (scenario 4)', async () => {
    const assignment = await assign({
      member_id: await createMember(gymId, `Readings Three Periods ${RUN}`),
      target_value: 70, target_unit: 'kg', initial_reading: 80, start_date: '2026-09-01',
    });
    await staff('post', `${STAFF}/${assignment.id}/initial-reading`).send({ value: 76, recorded_at: '2026-09-22' });
    const res = await staff('post', `${STAFF}/${assignment.id}/initial-reading`).send({ value: 74, recorded_at: '2026-10-01' });
    expect(res.status).toBe(201);
    expect(res.body.readings.map((r: any) => r.period)).toEqual([0, 1, 2]);
    expect(res.body.initial_reading).toBe(74);
  });

  it('measures a gain goal in the other direction with no stored direction', async () => {
    const gainGoal = await createGymGoal(gymId, `Readings Gain Goal ${RUN}`, { value: 80, unit: 'kg' });
    const assignment = await assign({
      member_id: await createMember(gymId, `Readings Gain ${RUN}`),
      personal_goal_id: gainGoal, target_value: 80, target_unit: 'kg', initial_reading: 70,
    });
    const res = await addReading(assignment.id, { value: 75 });
    expect(res.progress_percent).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// The member's own readings (§35)
// ---------------------------------------------------------------------------

describe('goal readings — the member\'s own', () => {
  async function myGoal(goalId = memberGymGoalId, body: Record<string, unknown> = {}) {
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: TEST_USER_ID } as any);
    const res = await me('post', ME).send({ personal_goal_id: goalId, ...body });
    expect(res.status).toBe(201);
    return res.body;
  }

  it('records a reading, a new baseline, and reads its own history back', async () => {
    const goal = await myGoal(memberGymGoalId, {
      target_value: 70, target_unit: 'kg', initial_reading: 80, start_date: '2026-09-01',
    });
    expect(goal.initial_reading).toBe(80);
    expect(goal.progress_percent).toBe(0);

    const added = await me('post', `${ME}/${goal.id}/readings`).send({ value: 75, recorded_at: '2026-09-22' });
    expect(added.status).toBe(201);
    expect(added.body.latest_reading).toBe(75);
    expect(added.body.progress_percent).toBe(50);
    // The member is not shown who recorded a measurement.
    expect(added.body.readings[0].created_by_name).toBeUndefined();

    const rebased = await me('post', `${ME}/${goal.id}/initial-reading`).send({ value: 76, recorded_at: '2026-09-23' });
    expect(rebased.status).toBe(201);
    expect(rebased.body.initial_reading).toBe(76);
    expect(rebased.body.readings.map((r: any) => r.value)).toEqual([80, 75, 76]);

    const list = await me('get', ME);
    expect(list.status).toBe(200);
    const row = list.body.goals.find((g: any) => g.id === goal.id);
    expect(row.initial_reading).toBe(76);
    expect(row.reading_count).toBe(3);
  });

  it('records the member as the actor, which the staff surface can see', async () => {
    const goal = await myGoal(secondMemberGymGoalId, { target_value: 80, target_unit: 'kg', initial_reading: 70 });
    await me('post', `${ME}/${goal.id}/readings`).send({ value: 75 });

    const { rows } = await db.query<{ created_by_type: string }>(
      `SELECT created_by_type FROM member_personal_goal_readings
       WHERE member_personal_goal_id = ? ORDER BY id ASC`,
      [goal.id],
    );
    expect(rows.map((r) => r.created_by_type)).toEqual(['member', 'member']);
  });

  it('refuses another member\'s assignment whatever id the URL carries', async () => {
    const strangerId = await createMember(memberGymId, `Readings Stranger ${RUN}`);
    const { insertId } = await db.query(
      'INSERT INTO member_personal_goals (gym_id, member_id, personal_goal_id) VALUES (?, ?, ?)',
      [memberGymId, strangerId, memberGymGoalId],
    );

    expect((await me('get', `${ME}/${insertId}/readings`)).status).toBe(404);
    expect((await me('post', `${ME}/${insertId}/readings`).send({ value: 80 })).status).toBe(404);
    expect((await me('post', `${ME}/${insertId}/initial-reading`).send({ value: 80 })).status).toBe(404);

    const { rows } = await db.query(
      'SELECT id FROM member_personal_goal_readings WHERE member_personal_goal_id = ?',
      [insertId],
    );
    expect(rows).toHaveLength(0);
    expect(strangerId).toBeGreaterThan(0);
    expect(selfMemberId).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Append-only (§34)
// ---------------------------------------------------------------------------

describe('goal readings — append-only', () => {
  it('offers no edit and no delete on either surface', async () => {
    const assignment = await assign({ member_id: await createMember(gymId, `Readings Immutable ${RUN}`), initial_reading: 80 });
    const { rows } = await db.query<{ id: number }>(
      'SELECT id FROM member_personal_goal_readings WHERE member_personal_goal_id = ?',
      [assignment.id],
    );
    const readingId = rows[0].id;

    expect((await staff('put', `${STAFF}/${assignment.id}/readings/${readingId}`).send({ value: 70 })).status).toBe(404);
    expect((await staff('delete', `${STAFF}/${assignment.id}/readings/${readingId}`)).status).toBe(404);
    expect((await me('delete', `${ME}/${assignment.id}/readings/${readingId}`)).status).toBe(404);
  });

  it('keeps a removed assignment\'s readings, which a soft delete never touches', async () => {
    const assignment = await assign({ member_id: await createMember(gymId, `Readings Removed ${RUN}`), initial_reading: 80 });
    await addReading(assignment.id, { value: 75 });

    expect((await staff('delete', `${STAFF}/${assignment.id}`)).status).toBe(204);
    const { rows } = await db.query(
      'SELECT id FROM member_personal_goal_readings WHERE member_personal_goal_id = ?',
      [assignment.id],
    );
    expect(rows).toHaveLength(2);

    // The assignment itself is gone from every read, readings included.
    expect((await staff('get', `${STAFF}/${assignment.id}/readings`)).status).toBe(404);
  });
});
