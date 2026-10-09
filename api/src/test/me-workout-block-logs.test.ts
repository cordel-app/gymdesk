// Tests for #1009 — `POST /me/workout-block-logs` answered 500 for every member
// who marked a workout block complete, and the endpoint had no test, which is
// why it went unnoticed.
//
// The handler snapshotted `wb.result_type` into `workout_block_logs.result_type`.
// Migration 074 (#154) moved the result type from the block down to the exercise
// instance and dropped `workout_blocks.result_type`, so the pre-insert SELECT
// answered `Unknown column 'wb.result_type' in 'field list'`. The same column
// had become unfillable in the log table too — NOT NULL under migration 042's
// pre-#154 CHECK vocabulary (`None`/`Time`/…), a vocabulary stored nowhere else
// after #154, and four of the current `result_types` slugs (`rpe`, `rest_time`,
// `pace`, `speed`) have no member of it at all.
//
// Migration 209 dropped it rather than re-vocabularying it, because nothing read
// it: every reader is a blanket projection (`SELECT *` here, `SELECT wbl.*` in
// exercise-logs.ts) and no consumer touched the field. So the invariant asserted
// below is that a block log carries **no result type**, while `result_value` —
// the free text the member typed for the block — round-trips untouched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

const OTHER_USER_ID = 'me-wbl-other-user';

let gymId: string;
let otherGymId: string;
let memberId: number;
let blockId: number;
/** A block of another member's plan, inside the caller's own gym. */
let foreignMemberBlockId: number;
/** A block of another gym entirely. */
let otherGymBlockId: number;

/**
 * `members.clerk_user_id` is globally unique, so the two members that carry one
 * are upserted and then read back by it — the same shape the sibling `me-*`
 * suites use, which is what keeps a suite that failed mid-run (leaving its gym
 * behind) from blocking every later run with a duplicate key.
 */
async function createMember(gid: string, name: string, clerkUserId: string | null): Promise<number> {
  const email = `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
  if (clerkUserId === null) {
    const { insertId } = await db.query(
      `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, NULL)`,
      [gid, name, email],
    );
    return insertId;
  }
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), name = VALUES(name), email = VALUES(email),
                             deleted_at = NULL`,
    [gid, name, email, clerkUserId],
  );
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM members WHERE clerk_user_id = ?', [clerkUserId],
  );
  return rows[0].id;
}

/** An active plan with one workout and one block; returns the block's id. */
async function createBlock(gid: string, mid: number, resultUnit: string | null = null): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO training_plans (gym_id, member_id, name, status, start_date)
     VALUES (?, ?, 'Block Log Plan', 'active', CURRENT_DATE)`,
    [gid, mid],
  );
  await db.query(
    `INSERT INTO member_training_plans (gym_id, member_id, training_plan_id, status) VALUES (?, ?, ?, 'active')`,
    [gid, mid, planId],
  );
  const { insertId: workoutId } = await db.query(
    `INSERT INTO workouts (gym_id, training_plan_id, name, position, scheduled_weekday) VALUES (?, ?, 'Day 1', 1, 1)`,
    [gid, planId],
  );
  const { insertId } = await db.query(
    `INSERT INTO workout_blocks (gym_id, workout_id, position, type, result_unit) VALUES (?, ?, 1, 'Circuit', ?)`,
    [gid, workoutId, resultUnit],
  );
  return insertId;
}

const asMember = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

beforeAll(async () => {
  gymId = await createTestGym('Me Block Logs Gym');
  otherGymId = await createTestGym('Me Block Logs Other Gym');
  await createTestMembership(gymId, 'member');

  memberId = await createMember(gymId, 'Block Log Member', TEST_USER_ID);
  blockId = await createBlock(gymId, memberId, 'minutes');

  const foreignMemberId = await createMember(gymId, 'Other Member', null);
  foreignMemberBlockId = await createBlock(gymId, foreignMemberId);

  const otherGymMemberId = await createMember(otherGymId, 'Other Gym Member', OTHER_USER_ID);
  otherGymBlockId = await createBlock(otherGymId, otherGymMemberId);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('POST /me/workout-block-logs (#1009)', () => {
  it('logs a completed block for the caller', async () => {
    const res = await asMember(request.post('/me/workout-block-logs')).send({
      workout_block_id: blockId,
      logged_date: '2026-10-02',
      result_value: '21.5',
      notes: 'Felt strong',
    }).expect(201);

    expect(res.body.workout_block_id).toBe(blockId);
    expect(res.body.member_id).toBe(memberId);
    expect(res.body.gym_id).toBe(gymId);
    expect(res.body.result_value).toBe('21.5');
    expect(res.body.notes).toBe('Felt strong');
  });

  it('carries no result type — #154 moved it to the exercise instance', async () => {
    const res = await asMember(request.post('/me/workout-block-logs')).send({
      workout_block_id: blockId,
      logged_date: '2026-10-03',
      result_value: '7',
    }).expect(201);

    // The snapshot migration 209 dropped. A block has no single result type to
    // snapshot, so the row must not grow one back under any name.
    expect(res.body).not.toHaveProperty('result_type');
    expect(res.body.result_value).toBe('7');

    const { rows } = await db.query<Record<string, unknown>>(
      'SELECT * FROM workout_block_logs WHERE id = ?', [res.body.id],
    );
    expect(Object.keys(rows[0])).not.toContain('result_type');
  });

  it('accepts a block log with no result value at all', async () => {
    // An untyped, optional free-text value: the member app sends null when the
    // input is empty, which is how "I finished it, no number" is expressed now.
    const res = await asMember(request.post('/me/workout-block-logs')).send({
      workout_block_id: blockId,
      logged_date: '2026-10-04',
    }).expect(201);

    expect(res.body.result_value).toBeNull();
    expect(res.body.notes).toBeNull();
  });

  it('stores numeric result values of any magnitude for a unit block', async () => {
    // `rpe`, `rest_time`, `pace` and `speed` have no member of migration 042's
    // CHECK vocabulary, which is part of why that column is gone rather than
    // re-vocabularied — none of these may be refused.
    for (const [index, value] of ['8.5', '90', '4.5', '14.2'].entries()) {
      const res = await asMember(request.post('/me/workout-block-logs')).send({
        workout_block_id: blockId,
        logged_date: `2026-11-0${index + 1}`,
        result_value: value,
      }).expect(201);
      expect(res.body.result_value).toBe(value);
    }
  });

  it('requires workout_block_id and logged_date', async () => {
    await asMember(request.post('/me/workout-block-logs')).send({ logged_date: '2026-10-02' }).expect(400);
    await asMember(request.post('/me/workout-block-logs')).send({ workout_block_id: blockId }).expect(400);
  });

  it('rejects an unauthenticated request', async () => {
    await request.post('/me/workout-block-logs')
      .set('x-gym-id', gymId)
      .send({ workout_block_id: blockId, logged_date: '2026-10-02' })
      .expect(401);
  });

  it('rejects a caller whose role is not member', async () => {
    const adminGymId = await createTestGym('Me Block Logs Admin Gym');
    await createTestMembership(adminGymId, 'admin');

    await request.post('/me/workout-block-logs')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', adminGymId)
      .send({ workout_block_id: blockId, logged_date: '2026-10-02' })
      .expect(403);
  });

  it('refuses a block belonging to another member of the same gym', async () => {
    await asMember(request.post('/me/workout-block-logs')).send({
      workout_block_id: foreignMemberBlockId,
      logged_date: '2026-10-02',
    }).expect(403);
  });

  it('refuses a block of another gym', async () => {
    await asMember(request.post('/me/workout-block-logs')).send({
      workout_block_id: otherGymBlockId,
      logged_date: '2026-10-02',
    }).expect(403);
  });

  it('refuses a soft-deleted block', async () => {
    const deletedBlockId = await createBlock(gymId, memberId);
    await db.query('UPDATE workout_blocks SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [deletedBlockId]);

    await asMember(request.post('/me/workout-block-logs')).send({
      workout_block_id: deletedBlockId,
      logged_date: '2026-10-02',
    }).expect(403);
  });
});

describe('result value vs block unit (#1232)', () => {
  it('refuses a result value on a block with no result unit', async () => {
    const noUnitBlockId = await createBlock(gymId, memberId);
    await asMember(request.post('/me/workout-block-logs')).send({
      workout_block_id: noUnitBlockId, logged_date: '2026-10-02', result_value: '5',
    }).expect(400);
    await asMember(request.post('/me/workout-block-logs')).send({
      workout_block_id: noUnitBlockId, logged_date: '2026-10-02',
    }).expect(201);
  });
});

describe('PUT /me/workout-block-logs/:id (#1009)', () => {
  it('edits the caller\'s own log without reintroducing a result type', async () => {
    const created = await asMember(request.post('/me/workout-block-logs')).send({
      workout_block_id: blockId,
      logged_date: '2026-10-05',
      result_value: '18',
    }).expect(201);

    const res = await asMember(request.put(`/me/workout-block-logs/${created.body.id}`))
      .send({ result_value: '17.7', notes: 'PR' })
      .expect(200);

    expect(res.body.result_value).toBe('17.7');
    expect(res.body.notes).toBe('PR');
    expect(res.body).not.toHaveProperty('result_type');
    expect(res.body.modified_by_member_id).toBe(memberId);
  });

  it('404s a log that is not the caller\'s', async () => {
    const { insertId } = await db.query(
      `INSERT INTO workout_block_logs (gym_id, member_id, workout_block_id, logged_date, result_value)
       VALUES (?, (SELECT member_id FROM training_plans tp
                   JOIN workouts w ON w.training_plan_id = tp.id
                   JOIN workout_blocks b ON b.workout_id = w.id
                   WHERE b.id = ?), ?, '2026-10-02', 'theirs')`,
      [gymId, foreignMemberBlockId, foreignMemberBlockId],
    );

    await asMember(request.put(`/me/workout-block-logs/${insertId}`))
      .send({ result_value: '5' })
      .expect(404);
  });
});

describe('GET /me/workout-block-logs (#1009)', () => {
  it('lists the caller\'s own logs, newest first, with no result type', async () => {
    const res = await asMember(request.get('/me/workout-block-logs')).expect(200);

    expect(res.body.length).toBeGreaterThan(0);
    for (const log of res.body) {
      expect(log.member_id).toBe(memberId);
      expect(log.gym_id).toBe(gymId);
      expect(log).not.toHaveProperty('result_type');
    }
    const dates = res.body.map((l: any) => String(l.logged_date));
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('never lists another member\'s logs', async () => {
    const res = await asMember(request.get('/me/workout-block-logs')).expect(200);
    expect(res.body.map((l: any) => l.workout_block_id)).not.toContain(foreignMemberBlockId);
  });
});
