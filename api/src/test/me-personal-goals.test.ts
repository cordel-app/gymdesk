// Tests for me-personal-goals.ts — the Members App's My Goals section (#1036)
//
// The member manages **their own** Personal Goal assignments: assign an
// existing Gym Goal, edit the target they agreed, remove it. What they cannot
// do is create a Goal definition, reach another member's assignment, or set a
// progress status.
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

let gymId: string;
let memberId: number;
/** This gym's own Personal Goal. */
let gymGoalId: number;
/** A seeded System goal (`gym_id IS NULL`), assignable by every gym. */
let systemGoalId: number;

const ROOT = '/me/personal-goals';

function asMember(method: 'get' | 'post' | 'put' | 'delete', path: string, gid: string = gymId) {
  return (request as any)[method](path)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gid);
}

async function assignDirect(gid: string, mid: number, goalId: number, extra: Record<string, unknown> = {}) {
  const columns = ['gym_id', 'member_id', 'personal_goal_id', ...Object.keys(extra)];
  const values = [gid, mid, goalId, ...Object.values(extra)];
  const { insertId } = await db.query(
    `INSERT INTO member_personal_goals (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
    values,
  );
  return insertId as number;
}

beforeAll(async () => {
  gymId = await createTestGym('My Goals Gym');
  await createTestMembership(gymId, 'member');

  const email = `me-goals-${Date.now()}@test.com`;
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id)
     VALUES (?, 'Goals Member', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, email, TEST_USER_ID],
  );
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM members WHERE clerk_user_id = ?',
    [TEST_USER_ID],
  );
  memberId = rows[0].id;

  const { insertId } = await db.query(
    `INSERT INTO personal_goals (gym_id, name, description, target_value, target_unit, status)
     VALUES (?, 'Run a 10k', 'The gym''s own goal', 10, 'km', 'active')`,
    [gymId],
  );
  gymGoalId = insertId;

  const { rows: sys } = await db.query<{ id: number }>(
    "SELECT id FROM personal_goals WHERE gym_id IS NULL AND slug = 'weight_loss' LIMIT 1",
  );
  systemGoalId = sys[0].id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('auth and gating', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get(ROOT).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-member gym role', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'goals-admin-user' } as any);
    const roleGymId = await createTestGym('Goals Role Guard Gym');
    await createTestMembership(roleGymId, 'admin', 'goals-admin-user');
    const res = await request.get(ROOT)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', roleGymId);
    expect(res.status).toBe(403);
  });

  // A member with no `members` row in the gym is not an error: the page shows
  // its empty state, exactly as /me/nutrition-plan answers `{ plan: null }`.
  it('answers empty lists for a caller with no member profile', async () => {
    const clerkId = `goals-noprofile-${Date.now()}`;
    const otherGym = await createTestGym('Goals No Profile Gym');
    await createTestMembership(otherGym, 'member', clerkId);

    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerkId } as any);
    const res = await request.get(ROOT)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGym);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ goals: [], past_goals: [] });
  });
});

describe('GET / — my goals and my past goals', () => {
  it('splits live from past exactly where the unique index does', async () => {
    const live = await assignDirect(gymId, memberId, gymGoalId, { target_value: 10, target_unit: 'km' });
    const achieved = await assignDirect(gymId, memberId, systemGoalId, { status: 'achieved' });
    const removed = await assignDirect(gymId, memberId, systemGoalId, {
      status: 'abandoned', deleted_at: new Date(),
    });

    const res = await asMember('get', ROOT);
    expect(res.status).toBe(200);
    const liveIds = res.body.goals.map((g: any) => g.id);
    const pastIds = res.body.past_goals.map((g: any) => g.id);
    expect(liveIds).toContain(live);
    expect(pastIds).toEqual(expect.arrayContaining([achieved, removed]));
    expect(liveIds).not.toContain(achieved);

    await db.query('DELETE FROM member_personal_goals WHERE id IN (?, ?, ?)', [live, achieved, removed]);
  });

  it('reports target_value as a number and the dates as YYYY-MM-DD', async () => {
    const id = await assignDirect(gymId, memberId, gymGoalId, {
      target_value: 7.5, target_unit: 'km', start_date: '2026-01-02', target_date: '2026-03-04',
    });
    const res = await asMember('get', ROOT);
    const row = res.body.goals.find((g: any) => g.id === id);
    expect(row.target_value).toBe(7.5);
    expect(row.start_date).toBe('2026-01-02');
    expect(row.target_date).toBe('2026-03-04');
    expect(row.end_date).toBeNull();
    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [id]);
  });

  // #1034 §7 / §8 — a rename of the Gym Goal must not move an assignment.
  it('reports the name snapshot rather than the catalogue\'s current name', async () => {
    const { insertId: goalId } = await db.query(
      `INSERT INTO personal_goals (gym_id, name, status) VALUES (?, 'Original Name', 'active')`,
      [gymId],
    );
    const id = await assignDirect(gymId, memberId, goalId, { goal_name: 'Original Name' });
    await db.query('UPDATE personal_goals SET name = ? WHERE id = ?', ['Renamed', goalId]);

    const res = await asMember('get', ROOT);
    expect(res.body.goals.find((g: any) => g.id === id).goal_name).toBe('Original Name');

    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [id]);
    await db.query('DELETE FROM personal_goals WHERE id = ?', [goalId]);
  });

  it('falls back to the live name for a row assigned before the snapshot existed', async () => {
    const id = await assignDirect(gymId, memberId, gymGoalId);
    const res = await asMember('get', ROOT);
    expect(res.body.goals.find((g: any) => g.id === id).goal_name).toBe('Run a 10k');
    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [id]);
  });

  it('never returns another member\'s assignment', async () => {
    const { insertId: otherMemberId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Someone Else', ?)`,
      [gymId, `other-goals-${Date.now()}@test.com`],
    );
    const theirs = await assignDirect(gymId, otherMemberId, gymGoalId);

    const res = await asMember('get', ROOT);
    const allIds = [...res.body.goals, ...res.body.past_goals].map((g: any) => g.id);
    expect(allIds).not.toContain(theirs);

    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [theirs]);
    await db.query('DELETE FROM members WHERE id = ?', [otherMemberId]);
  });
});

describe('GET /available — what may still be added (§6, §7, Q3)', () => {
  it('offers the gym\'s own goals and the System ones', async () => {
    const res = await asMember('get', `${ROOT}/available`);
    expect(res.status).toBe(200);
    const ids = res.body.goals.map((g: any) => g.id);
    expect(ids).toContain(gymGoalId);
    expect(ids).toContain(systemGoalId);
  });

  it('carries the catalogue target the dialog pre-fills from (§5)', async () => {
    const res = await asMember('get', `${ROOT}/available`);
    const row = res.body.goals.find((g: any) => g.id === gymGoalId);
    expect(row.target_value).toBe(10);
    expect(row.target_unit).toBe('km');
    expect(row.slug).toBeNull();
  });

  it('leaves out a goal the member already holds live', async () => {
    const id = await assignDirect(gymId, memberId, gymGoalId);
    const res = await asMember('get', `${ROOT}/available`);
    expect(res.body.goals.map((g: any) => g.id)).not.toContain(gymGoalId);
    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [id]);
  });

  // §12 — removing one puts it back in the selector, and so does finishing it.
  it('offers a goal the member removed, achieved or abandoned again', async () => {
    const removed = await assignDirect(gymId, memberId, gymGoalId, { deleted_at: new Date() });
    const achieved = await assignDirect(gymId, memberId, systemGoalId, { status: 'achieved' });
    const res = await asMember('get', `${ROOT}/available`);
    const ids = res.body.goals.map((g: any) => g.id);
    expect(ids).toContain(gymGoalId);
    expect(ids).toContain(systemGoalId);
    await db.query('DELETE FROM member_personal_goals WHERE id IN (?, ?)', [removed, achieved]);
  });

  it('leaves out a goal the gym has retired', async () => {
    const { insertId: retired } = await db.query(
      `INSERT INTO personal_goals (gym_id, name, status) VALUES (?, 'Retired Goal', 'deleted')`,
      [gymId],
    );
    const res = await asMember('get', `${ROOT}/available`);
    expect(res.body.goals.map((g: any) => g.id)).not.toContain(retired);
    await db.query('DELETE FROM personal_goals WHERE id = ?', [retired]);
  });

  it('never offers another gym\'s goal', async () => {
    const otherGym = await createTestGym('Goals Other Catalogue Gym');
    const { insertId: theirGoal } = await db.query(
      `INSERT INTO personal_goals (gym_id, name, status) VALUES (?, 'Their Goal', 'active')`,
      [otherGym],
    );
    const res = await asMember('get', `${ROOT}/available`);
    expect(res.body.goals.map((g: any) => g.id)).not.toContain(theirGoal);
  });
});

describe('POST / — assigning a goal to myself (§4, §8)', () => {
  const created: number[] = [];
  afterAll(async () => {
    if (created.length) {
      await db.query(`DELETE FROM member_personal_goals WHERE id IN (${created.map(() => '?').join(',')})`, created);
    }
  });

  it('assigns a goal and inherits the catalogue target as its snapshot', async () => {
    const res = await asMember('post', ROOT).send({ personal_goal_id: gymGoalId });
    expect(res.status).toBe(201);
    created.push(res.body.id);
    expect(res.body.goal_name).toBe('Run a 10k');
    expect(res.body.target_value).toBe(10);
    expect(res.body.target_unit).toBe('km');
    expect(res.body.status).toBe('in_progress');
    expect(res.body.end_date).toBeNull();

    // The row records the member as its actor (migration 222).
    const { rows } = await db.query<{ created_by_type: string }>(
      'SELECT created_by_type FROM member_personal_goals WHERE id = ?', [res.body.id],
    );
    expect(rows[0].created_by_type).toBe('member');
  });

  it('refuses a second live assignment of the same goal (§7)', async () => {
    const res = await asMember('post', ROOT).send({ personal_goal_id: gymGoalId });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
  });

  it('keeps the snapshot when the Gym Goal is re-targeted afterwards', async () => {
    await db.query('UPDATE personal_goals SET target_value = 42 WHERE id = ?', [gymGoalId]);
    const res = await asMember('get', ROOT);
    expect(res.body.goals.find((g: any) => g.id === created[0]).target_value).toBe(10);
    await db.query('UPDATE personal_goals SET target_value = 10 WHERE id = ?', [gymGoalId]);
  });

  it('takes a submitted target as the per-member override', async () => {
    const res = await asMember('post', ROOT).send({
      personal_goal_id: systemGoalId, target_value: 5, target_unit: 'kg', start_date: '2026-02-01',
    });
    expect(res.status).toBe(201);
    created.push(res.body.id);
    expect(res.body.target_value).toBe(5);
    expect(res.body.start_date).toBe('2026-02-01');
  });

  it('treats an explicit null as a clear rather than an inheritance', async () => {
    const id = created.pop()!;
    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [id]);
    const res = await asMember('post', ROOT).send({
      personal_goal_id: systemGoalId, target_value: null, target_unit: null,
    });
    expect(res.status).toBe(201);
    created.push(res.body.id);
    expect(res.body.target_value).toBeNull();
    expect(res.body.target_unit).toBeNull();
  });

  it('refuses a goal id that is not in this gym\'s catalogue', async () => {
    const otherGym = await createTestGym('Goals Foreign Assign Gym');
    const { insertId: theirGoal } = await db.query(
      `INSERT INTO personal_goals (gym_id, name, status) VALUES (?, 'Foreign', 'active')`,
      [otherGym],
    );
    const res = await asMember('post', ROOT).send({ personal_goal_id: theirGoal });
    expect(res.status).toBe(404);
  });

  it('refuses a retired goal', async () => {
    const { insertId: retired } = await db.query(
      `INSERT INTO personal_goals (gym_id, name, status) VALUES (?, 'Gone', 'deleted')`,
      [gymId],
    );
    const res = await asMember('post', ROOT).send({ personal_goal_id: retired });
    expect(res.status).toBe(404);
    await db.query('DELETE FROM personal_goals WHERE id = ?', [retired]);
  });

  it('requires a goal, and validates the target pair and the dates', async () => {
    expect((await asMember('post', ROOT).send({})).status).toBe(400);

    const { insertId: freeGoal } = await db.query(
      `INSERT INTO personal_goals (gym_id, name, status) VALUES (?, 'Validation Goal', 'active')`,
      [gymId],
    );
    const unit = await asMember('post', ROOT).send({ personal_goal_id: freeGoal, target_unit: 'kg' });
    expect(unit.status).toBe(400);
    const dates = await asMember('post', ROOT).send({
      personal_goal_id: freeGoal, start_date: '2026-06-01', target_date: '2026-01-01',
    });
    expect(dates.status).toBe(400);
    await db.query('DELETE FROM personal_goals WHERE id = ?', [freeGoal]);
  });

  // §15/§18 — the member is never named by the request.
  it('ignores a member_id in the body', async () => {
    const { insertId: otherMemberId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Not Me', ?)`,
      [gymId, `not-me-${Date.now()}@test.com`],
    );
    const { insertId: goalId } = await db.query(
      `INSERT INTO personal_goals (gym_id, name, status) VALUES (?, 'Body Member Goal', 'active')`,
      [gymId],
    );
    const res = await asMember('post', ROOT).send({ personal_goal_id: goalId, member_id: otherMemberId });
    expect(res.status).toBe(201);
    created.push(res.body.id);

    const { rows } = await db.query<{ member_id: number }>(
      'SELECT member_id FROM member_personal_goals WHERE id = ?', [res.body.id],
    );
    expect(rows[0].member_id).toBe(memberId);
    await db.query('DELETE FROM members WHERE id = ?', [otherMemberId]);
  });

  // §14 — progress is not the member's to set.
  it('ignores a status in the body', async () => {
    const { insertId: goalId } = await db.query(
      `INSERT INTO personal_goals (gym_id, name, status) VALUES (?, 'Status Body Goal', 'active')`,
      [gymId],
    );
    const res = await asMember('post', ROOT).send({ personal_goal_id: goalId, status: 'achieved' });
    expect(res.status).toBe(201);
    created.push(res.body.id);
    expect(res.body.status).toBe('in_progress');
  });
});

describe('PUT /:id — editing my own target (§9)', () => {
  it('writes the assignment and leaves the Gym Goal alone', async () => {
    const id = await assignDirect(gymId, memberId, gymGoalId, {
      goal_name: 'Run a 10k', target_value: 10, target_unit: 'km',
    });
    const res = await asMember('put', `${ROOT}/${id}`).send({ target_value: 15 });
    expect(res.status).toBe(200);
    expect(res.body.target_value).toBe(15);

    const { rows } = await db.query<{ target_value: string }>(
      'SELECT target_value FROM personal_goals WHERE id = ?', [gymGoalId],
    );
    expect(Number(rows[0].target_value)).toBe(10);
    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [id]);
  });

  it('is partial — a field the body omits keeps what it is stored with', async () => {
    const id = await assignDirect(gymId, memberId, gymGoalId, {
      target_value: 10, target_unit: 'km', notes: 'keep me',
    });
    const res = await asMember('put', `${ROOT}/${id}`).send({ target_value: 12 });
    expect(res.body.notes).toBe('keep me');
    expect(res.body.target_unit).toBe('km');
    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [id]);
  });

  // The pair is checked against the row the write produces, not the body.
  it('refuses a clear that would leave a unit qualifying nothing', async () => {
    const id = await assignDirect(gymId, memberId, gymGoalId, { target_value: 10, target_unit: 'km' });
    const res = await asMember('put', `${ROOT}/${id}`).send({ target_value: null });
    expect(res.status).toBe(400);
    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [id]);
  });

  it('never re-points the assignment at another goal', async () => {
    const id = await assignDirect(gymId, memberId, gymGoalId);
    await asMember('put', `${ROOT}/${id}`).send({ personal_goal_id: systemGoalId, target_value: 1 });
    const { rows } = await db.query<{ personal_goal_id: number }>(
      'SELECT personal_goal_id FROM member_personal_goals WHERE id = ?', [id],
    );
    expect(rows[0].personal_goal_id).toBe(gymGoalId);
    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [id]);
  });

  it('404s another member\'s assignment (§15)', async () => {
    const { insertId: otherMemberId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Victim', ?)`,
      [gymId, `victim-${Date.now()}@test.com`],
    );
    const theirs = await assignDirect(gymId, otherMemberId, gymGoalId, { target_value: 1, target_unit: 'km' });

    const res = await asMember('put', `${ROOT}/${theirs}`).send({ target_value: 99 });
    expect(res.status).toBe(404);
    const { rows } = await db.query<{ target_value: string }>(
      'SELECT target_value FROM member_personal_goals WHERE id = ?', [theirs],
    );
    expect(Number(rows[0].target_value)).toBe(1);

    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [theirs]);
    await db.query('DELETE FROM members WHERE id = ?', [otherMemberId]);
  });

  it('404s an assignment of another gym', async () => {
    const otherGym = await createTestGym('Goals Other Tenant Gym');
    const { insertId: otherMemberId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Other Tenant Member', ?)`,
      [otherGym, `other-tenant-${Date.now()}@test.com`],
    );
    const { insertId: theirGoal } = await db.query(
      `INSERT INTO personal_goals (gym_id, name, status) VALUES (?, 'Other Tenant Goal', 'active')`,
      [otherGym],
    );
    const theirs = await assignDirect(otherGym, otherMemberId, theirGoal);

    const res = await asMember('put', `${ROOT}/${theirs}`).send({ target_value: 1 });
    expect(res.status).toBe(404);
  });

  it('404s a removed assignment', async () => {
    const id = await assignDirect(gymId, memberId, gymGoalId, { deleted_at: new Date() });
    const res = await asMember('put', `${ROOT}/${id}`).send({ target_value: 1 });
    expect(res.status).toBe(404);
    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [id]);
  });
});

describe('DELETE /:id — removing my own goal (§11, §12, Q4)', () => {
  it('soft-deletes it, stamps the end date and keeps the Gym Goal', async () => {
    const id = await assignDirect(gymId, memberId, gymGoalId, { goal_name: 'Run a 10k' });
    const res = await asMember('delete', `${ROOT}/${id}`);
    expect(res.status).toBe(204);

    const { rows } = await db.query<{ deleted_at: Date | null; end_date: Date | null; status: string; deleted_by_type: string }>(
      'SELECT deleted_at, end_date, status, deleted_by_type FROM member_personal_goals WHERE id = ?', [id],
    );
    expect(rows[0].deleted_at).not.toBeNull();
    expect(rows[0].end_date).not.toBeNull();
    // The progress status is left exactly where it was (migration 212).
    expect(rows[0].status).toBe('in_progress');
    expect(rows[0].deleted_by_type).toBe('member');

    const { rows: goalRows } = await db.query('SELECT id FROM personal_goals WHERE id = ?', [gymGoalId]);
    expect(goalRows).toHaveLength(1);

    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [id]);
  });

  it('keeps an end date that was already recorded', async () => {
    const id = await assignDirect(gymId, memberId, gymGoalId, {
      status: 'achieved', end_date: '2026-03-01',
    });
    await asMember('delete', `${ROOT}/${id}`);
    const { rows } = await db.query<{ end_date: Date }>(
      'SELECT end_date FROM member_personal_goals WHERE id = ?', [id],
    );
    expect(new Date(rows[0].end_date).toISOString().slice(0, 10)).toBe('2026-03-01');
    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [id]);
  });

  it('lets the goal be assigned again, as a brand new row', async () => {
    const first = await asMember('post', ROOT).send({ personal_goal_id: systemGoalId });
    expect(first.status).toBe(201);
    expect((await asMember('delete', `${ROOT}/${first.body.id}`)).status).toBe(204);

    const second = await asMember('post', ROOT).send({ personal_goal_id: systemGoalId });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);

    await db.query('DELETE FROM member_personal_goals WHERE id IN (?, ?)', [first.body.id, second.body.id]);
  });

  it('409s a goal that is already removed', async () => {
    const id = await assignDirect(gymId, memberId, gymGoalId, { deleted_at: new Date() });
    expect((await asMember('delete', `${ROOT}/${id}`)).status).toBe(409);
    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [id]);
  });

  it('404s another member\'s assignment and leaves it alone (§15)', async () => {
    const { insertId: otherMemberId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Untouched', ?)`,
      [gymId, `untouched-${Date.now()}@test.com`],
    );
    const theirs = await assignDirect(gymId, otherMemberId, gymGoalId);

    expect((await asMember('delete', `${ROOT}/${theirs}`)).status).toBe(404);
    const { rows } = await db.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM member_personal_goals WHERE id = ?', [theirs],
    );
    expect(rows[0].deleted_at).toBeNull();

    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [theirs]);
    await db.query('DELETE FROM members WHERE id = ?', [otherMemberId]);
  });
});
