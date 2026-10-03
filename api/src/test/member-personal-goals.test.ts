// Tests for member-personal-goals.ts router (#948 §4 — Assigned Personal Goals)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const PATH = '/member-personal-goals';

/** Unique per run, so a re-run against the same database cannot collide. */
const RUN = `${Date.now()}`;

let gymId: string;
let otherGymId: string;
let frontDeskGymId: string;

let memberId: number;
let otherMemberId: number;
let otherGymMemberId: number;

/** This gym's own catalogue row, and one of migration 206's System seeds. */
let gymGoalId: number;
let secondGymGoalId: number;
let systemGoalId: number;
let otherGymGoalId: number;

async function createMember(gym: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gym, name, `${name.replace(/\s+/g, '.').toLowerCase()}.${RUN}@example.com`],
  );
  return insertId as number;
}

async function createGymGoal(gym: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO personal_goals (gym_id, name, status) VALUES (?, ?, 'active')",
    [gym, name],
  );
  return insertId as number;
}

function post(body: Record<string, unknown>, gym = gymId) {
  return request.post(PATH).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send(body);
}

function put(id: number | string, body: Record<string, unknown>, gym = gymId) {
  return request.put(`${PATH}/${id}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send(body);
}

function del(id: number | string, gym = gymId) {
  return request.delete(`${PATH}/${id}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
}

function list(query = '', gym = gymId) {
  return request.get(`${PATH}${query}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
}

function get(id: number | string, gym = gymId) {
  return request.get(`${PATH}/${id}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
}

/** Assigns a goal and returns the created row, failing loudly if it did not. */
async function assign(body: Record<string, unknown> = {}) {
  const res = await post({ member_id: memberId, personal_goal_id: gymGoalId, ...body });
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async () => {
  gymId = await createTestGym('MPG Test Gym');
  await createTestMembership(gymId, 'admin');

  // Same TEST_USER_ID as an admin of a second gym — lets the tenant-isolation
  // cases pass the auth/module-access middleware and reach the router's own
  // gym_id ownership checks.
  otherGymId = await createTestGym('MPG Other Gym');
  await createTestMembership(otherGymId, 'admin');

  // front_desk has 'R' on NUTRITION: it may list, but every write is a 403.
  frontDeskGymId = await createTestGym('MPG Front Desk Gym');
  await createTestMembership(frontDeskGymId, 'front_desk');

  memberId = await createMember(gymId, `MPG Member ${RUN}`);
  otherMemberId = await createMember(gymId, `MPG Second Member ${RUN}`);
  otherGymMemberId = await createMember(otherGymId, `MPG Foreign Member ${RUN}`);

  gymGoalId = await createGymGoal(gymId, `MPG Gym Goal ${RUN}`);
  secondGymGoalId = await createGymGoal(gymId, `MPG Gym Goal Two ${RUN}`);
  otherGymGoalId = await createGymGoal(otherGymId, `MPG Foreign Goal ${RUN}`);

  const { rows } = await db.query<{ id: number }>(
    "SELECT id FROM personal_goals WHERE gym_id IS NULL AND slug = 'weight_loss'",
  );
  systemGoalId = rows[0]?.id;
});

afterAll(async () => {
  // Every FK is ON DELETE CASCADE and `cleanupTestGyms` names the table
  // explicitly; this suite writes no `gym_id IS NULL` row, so migration 206's
  // seeds are untouched.
  await cleanupTestGyms();
  await db.end();
});

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

describe('assigned personal goals — auth guard', () => {
  it('returns 401 without auth', async () => {
    expect((await request.get(PATH)).status).toBe(401);
    expect((await request.post(PATH).send({})).status).toBe(401);
    expect((await request.put(`${PATH}/1`).send({})).status).toBe(401);
    expect((await request.delete(`${PATH}/1`)).status).toBe(401);
  });

  it('returns 401 when authenticated without an x-gym-id header', async () => {
    const res = await request.get(PATH).set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Role guard — front_desk reads but never writes
// ---------------------------------------------------------------------------

describe('assigned personal goals — role guard', () => {
  it('lets front_desk list', async () => {
    const res = await list('', frontDeskGymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('returns 403 for front_desk on assign, edit and unassign', async () => {
    const created = await assign();
    expect((await post({ member_id: memberId, personal_goal_id: gymGoalId }, frontDeskGymId)).status).toBe(403);
    expect((await put(created.id, { status: 'achieved' }, frontDeskGymId)).status).toBe(403);
    expect((await del(created.id, frontDeskGymId)).status).toBe(403);
    await del(created.id);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('assigned personal goals — assign', () => {
  it('assigns a gym goal with every field and reports the shape back', async () => {
    const res = await post({
      member_id: memberId,
      personal_goal_id: gymGoalId,
      target_value: 5,
      target_unit: 'kg',
      start_date: '2026-01-01',
      target_date: '2026-06-30',
      notes: 'Agreed at the intake session',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      member_id: memberId,
      personal_goal_id: gymGoalId,
      target_unit: 'kg',
      status: 'in_progress',
      notes: 'Agreed at the intake session',
      member_name: `MPG Member ${RUN}`,
      goal_name: `MPG Gym Goal ${RUN}`,
    });
    // A DECIMAL comes back from mysql2 as a string; the router reports a number.
    expect(res.body.target_value).toBe(5);
    expect(typeof res.body.target_value).toBe('number');
    expect(res.body.created_by_type).toBe('staff');
    expect(String(res.body.start_date)).toContain('2026-01-01');
    await del(res.body.id);
  });

  it('defaults the status to in_progress and leaves every optional field empty', async () => {
    const created = await assign();
    expect(created.status).toBe('in_progress');
    expect(created.target_value).toBeNull();
    expect(created.target_unit).toBeNull();
    expect(created.start_date).toBeNull();
    expect(created.target_date).toBeNull();
    expect(created.notes).toBeNull();
    await del(created.id);
  });

  it('assigns a System goal from the shared catalogue', async () => {
    const res = await post({ member_id: memberId, personal_goal_id: systemGoalId });
    expect(res.status).toBe(201);
    expect(res.body.goal_gym_id).toBeNull();
    expect(res.body.goal_slug).toBe('weight_loss');
    await del(res.body.id);
  });

  it('accepts an explicit status on assign', async () => {
    const res = await post({ member_id: memberId, personal_goal_id: gymGoalId, status: 'achieved' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('achieved');
    await del(res.body.id);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('assigned personal goals — validation', () => {
  it('requires member_id and personal_goal_id', async () => {
    expect((await post({ personal_goal_id: gymGoalId })).status).toBe(400);
    expect((await post({ member_id: memberId })).status).toBe(400);
  });

  it('refuses an unknown status', async () => {
    const res = await post({ member_id: memberId, personal_goal_id: gymGoalId, status: 'paused' });
    expect(res.status).toBe(400);
  });

  it('refuses a negative target value and a malformed date', async () => {
    expect((await post({ member_id: memberId, personal_goal_id: gymGoalId, target_value: -1 })).status).toBe(400);
    expect((await post({ member_id: memberId, personal_goal_id: gymGoalId, start_date: '01/01/2026' })).status).toBe(400);
    expect((await post({ member_id: memberId, personal_goal_id: gymGoalId, start_date: '2026-02-31' })).status).toBe(400);
  });

  it('refuses a unit with no value, and a target date before the start date', async () => {
    expect((await post({ member_id: memberId, personal_goal_id: gymGoalId, target_unit: 'kg' })).status).toBe(400);
    const res = await post({
      member_id: memberId, personal_goal_id: gymGoalId,
      start_date: '2026-06-01', target_date: '2026-01-01',
    });
    expect(res.status).toBe(400);
  });

  it('refuses clearing a target value that a stored unit still qualifies', async () => {
    const created = await assign({ target_value: 5, target_unit: 'kg' });
    const res = await put(created.id, { target_value: null });
    expect(res.status).toBe(400);
    // Clearing both together is fine.
    expect((await put(created.id, { target_value: null, target_unit: null })).status).toBe(200);
    await del(created.id);
  });

  it('refuses a target date the stored start date is after', async () => {
    const created = await assign({ start_date: '2026-06-01' });
    expect((await put(created.id, { target_date: '2026-01-01' })).status).toBe(400);
    expect((await put(created.id, { target_date: '2026-12-01' })).status).toBe(200);
    await del(created.id);
  });
});

// ---------------------------------------------------------------------------
// Key invariant: one live, in-progress assignment per (member, goal)
// ---------------------------------------------------------------------------

describe('assigned personal goals — one live assignment per goal', () => {
  it('refuses a second live in-progress assignment of the same goal', async () => {
    const first = await assign();
    const second = await post({ member_id: memberId, personal_goal_id: gymGoalId });
    expect(second.status).toBe(409);
    await del(first.id);
  });

  it('allows the same goal again once the first is achieved, and refuses reopening it', async () => {
    const first = await assign();
    expect((await put(first.id, { status: 'achieved' })).status).toBe(200);
    const second = await post({ member_id: memberId, personal_goal_id: gymGoalId });
    expect(second.status).toBe(201);
    // Reopening the achieved one would collide with the live replacement.
    expect((await put(first.id, { status: 'in_progress' })).status).toBe(409);
    await del(first.id);
    await del(second.id);
  });

  it('allows the same goal for a different member, and a different goal for the same member', async () => {
    const mine = await assign();
    const theirs = await post({ member_id: otherMemberId, personal_goal_id: gymGoalId });
    expect(theirs.status).toBe(201);
    const second = await post({ member_id: memberId, personal_goal_id: secondGymGoalId });
    expect(second.status).toBe(201);
    await del(mine.id);
    await del(theirs.id);
    await del(second.id);
  });

  it('allows re-assigning a goal that was unassigned', async () => {
    const first = await assign();
    expect((await del(first.id)).status).toBe(204);
    const again = await post({ member_id: memberId, personal_goal_id: gymGoalId });
    expect(again.status).toBe(201);
    await del(again.id);
  });
});

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

describe('assigned personal goals — edit', () => {
  it('is a partial update: an unmentioned field keeps what it is stored with', async () => {
    const created = await assign({
      target_value: 5, target_unit: 'kg', start_date: '2026-01-01', notes: 'Original',
    });
    const res = await put(created.id, { status: 'achieved' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'achieved', target_unit: 'kg', notes: 'Original' });
    expect(res.body.target_value).toBe(5);
    expect(String(res.body.start_date)).toContain('2026-01-01');
    expect(res.body.modified_by_type).toBe('staff');
    await del(created.id);
  });

  it('clears a field on an explicit null', async () => {
    const created = await assign({ notes: 'Original', start_date: '2026-01-01' });
    const res = await put(created.id, { notes: null, start_date: null });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBeNull();
    expect(res.body.start_date).toBeNull();
    await del(created.id);
  });

  it('never moves the member or the goal', async () => {
    const created = await assign();
    const res = await put(created.id, { member_id: otherMemberId, personal_goal_id: secondGymGoalId });
    expect(res.status).toBe(200);
    expect(res.body.member_id).toBe(memberId);
    expect(res.body.personal_goal_id).toBe(gymGoalId);
    await del(created.id);
  });

  it('returns 404 for an unknown id', async () => {
    expect((await put(99999999, { status: 'achieved' })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Unassign (soft delete)
// ---------------------------------------------------------------------------

describe('assigned personal goals — unassign', () => {
  it('soft deletes, hides the row from the list and keeps its progress status', async () => {
    const created = await assign({ status: 'achieved' });
    expect((await del(created.id)).status).toBe(204);

    const after = await list(`?member_id=${memberId}`);
    expect(after.body.items.some((r: any) => r.id === created.id)).toBe(false);
    expect((await get(created.id)).status).toBe(404);

    const { rows } = await db.query<{ status: string; deleted_at: string | null; deleted_by_type: string | null }>(
      'SELECT status, deleted_at, deleted_by_type FROM member_personal_goals WHERE id = ?',
      [created.id],
    );
    expect(rows[0].status).toBe('achieved');
    expect(rows[0].deleted_at).not.toBeNull();
    expect(rows[0].deleted_by_type).toBe('staff');
  });

  it('returns 409 when it is already deleted', async () => {
    const created = await assign();
    expect((await del(created.id)).status).toBe(204);
    expect((await del(created.id)).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// List, filters and search
// ---------------------------------------------------------------------------

describe('assigned personal goals — list', () => {
  it('filters by member and by status, and searches member, goal and notes', async () => {
    const mine = await assign({ notes: `needle-${RUN}` });
    const theirs = await post({ member_id: otherMemberId, personal_goal_id: secondGymGoalId });
    expect(theirs.status).toBe(201);
    expect((await put(theirs.id, { status: 'abandoned' })).status).toBe(200);

    const byMember = await list(`?member_id=${memberId}`);
    expect(byMember.status).toBe(200);
    expect(byMember.body.items.every((r: any) => r.member_id === memberId)).toBe(true);
    expect(byMember.body.items.some((r: any) => r.id === mine.id)).toBe(true);

    const byStatus = await list('?status=abandoned');
    expect(byStatus.body.items.every((r: any) => r.status === 'abandoned')).toBe(true);
    expect(byStatus.body.items.some((r: any) => r.id === theirs.id)).toBe(true);

    const byNotes = await list(`?search=needle-${RUN}`);
    expect(byNotes.body.items.map((r: any) => r.id)).toContain(mine.id);

    const byGoal = await list(`?search=${encodeURIComponent(`MPG Gym Goal Two ${RUN}`)}`);
    expect(byGoal.body.items.map((r: any) => r.id)).toContain(theirs.id);

    await del(mine.id);
    await del(theirs.id);
  });

  it('refuses an unknown status filter and a malformed member filter', async () => {
    expect((await list('?status=paused')).status).toBe(400);
    expect((await list('?member_id=abc')).status).toBe(400);
  });

  it('reports the paging envelope', async () => {
    const res = await list('?limit=1&offset=0');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ limit: 1, offset: 0 });
    expect(typeof res.body.total).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('assigned personal goals — tenant isolation', () => {
  it('refuses a member of another gym', async () => {
    const res = await post({ member_id: otherGymMemberId, personal_goal_id: gymGoalId });
    expect(res.status).toBe(404);
  });

  it('refuses a goal of another gym', async () => {
    const res = await post({ member_id: memberId, personal_goal_id: otherGymGoalId });
    expect(res.status).toBe(404);
  });

  it('refuses a goal the gym has deleted from its catalogue', async () => {
    const retired = await createGymGoal(gymId, `MPG Retired Goal ${RUN}`);
    await db.query("UPDATE personal_goals SET status = 'deleted', deleted_at = UTC_TIMESTAMP() WHERE id = ?", [retired]);
    const res = await post({ member_id: memberId, personal_goal_id: retired });
    expect(res.status).toBe(404);
  });

  it("hides another gym's assignment from the list and from every single-row route", async () => {
    const created = await assign();
    expect((await list('', otherGymId)).body.items.some((r: any) => r.id === created.id)).toBe(false);
    expect((await get(created.id, otherGymId)).status).toBe(404);
    expect((await put(created.id, { status: 'achieved' }, otherGymId)).status).toBe(404);
    expect((await del(created.id, otherGymId)).status).toBe(404);
    await del(created.id);
  });
});

// ---------------------------------------------------------------------------
// Statuses endpoint
// ---------------------------------------------------------------------------

describe('assigned personal goals — statuses', () => {
  it('serves the accepted set the writes validate against', async () => {
    const res = await request.get(`${PATH}/statuses`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.statuses).toEqual(['in_progress', 'achieved', 'abandoned']);
  });
});
