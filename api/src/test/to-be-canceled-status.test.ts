// #3007 stage 2(a) — `to_be_canceled` is a stored assignment status that nothing writes yet, and
// every reader gives it the answer it gives `active`. The value is stored directly (the way the
// next stage's writer will) and read against an `active` twin.

import { TEST_ASSIGNMENTS } from './assignmentReads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, legacyAssignmentQuery, request,
  snapshotTestAssignment,
} from './helpers';
import {
  ASSIGNMENT_STATUSES, PENDING_CANCELLATION_STATUS, RUNNING_ASSIGNMENT_STATUSES, entitledAssignmentSql,
  isRunningAssignmentStatus,
} from '../domain/assignmentStatus';
import { LIVE_ASSIGNMENT_STATUSES } from '../domain/oneActivePlan';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const authed = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function createMember(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'TBC Member', `tbc-${uniq()}@test.com`]);
  return insertId;
}

async function createAssignment(memberId: number, status: string): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`, [gymId, `TBC Plan ${uniq()}`]);
  const { insertId } = await legacyAssignmentQuery(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, ends_at, base_price)
     VALUES (?, ?, ?, ?, '2026-01-01', NULL, 40)`, [gymId, memberId, planId, status]);
  await snapshotTestAssignment(insertId);
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('TBC Status Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('to_be_canceled declarations (#3007 stage 2a)', () => {
  it('is a stored status and a running, live one', () => {
    expect(ASSIGNMENT_STATUSES).toContain(PENDING_CANCELLATION_STATUS);
    expect([...RUNNING_ASSIGNMENT_STATUSES].sort()).toEqual(['active', PENDING_CANCELLATION_STATUS].sort());
    expect(isRunningAssignmentStatus(PENDING_CANCELLATION_STATUS)).toBe(true);
    expect(isRunningAssignmentStatus('paused')).toBe(false);
    expect(LIVE_ASSIGNMENT_STATUSES).toContain(PENDING_CANCELLATION_STATUS);
    expect(entitledAssignmentSql('pa')).toContain(`'${PENDING_CANCELLATION_STATUS}'`);
  });
});

describe('to_be_canceled in the database and the readers (#3007 stage 2a)', () => {
  it('both CHECKs accept the value', async () => {
    const memberId = await createMember();
    const id = await createAssignment(memberId, PENDING_CANCELLATION_STATUS);
    const { rows: um } = await db.query(`SELECT status FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [id]);
    const { rows: snap } = await db.query('SELECT status FROM plan_snapshots WHERE anchor_plan_snapshot_id = ?', [id]);
    expect(um[0].status).toBe(PENDING_CANCELLATION_STATUS);
    expect(snap[0].status).toBe(PENDING_CANCELLATION_STATUS);
  });

  it("reads like a running plan on the Member card (live, current), its derived status To Be Canceled (#3302)", async () => {
    const memberId = await createMember();
    const running = await createAssignment(memberId, PENDING_CANCELLATION_STATUS);
    const twin = await createAssignment(memberId, 'active');
    const res = await authed(request.get(`/user-memberships/member/${memberId}/configuration`));
    expect(res.status).toBe(200);
    const byId = new Map<number, any>(res.body.plans.map((p: any) => [p.id, p]));
    for (const id of [running, twin]) {
      expect(Number(byId.get(id).is_live)).toBe(1);
      expect(byId.get(id).is_current).toBe(true);
    }
    // #3302: the derived status names the pending cancellation; the twin stays Active.
    expect(byId.get(running).lifecycle_status).toBe(PENDING_CANCELLATION_STATUS);
    expect(byId.get(twin).lifecycle_status).toBe('active');
    expect(byId.get(running).status).toBe(PENDING_CANCELLATION_STATUS);
  });

  it('counts for the plan-level active guards and no PUT moves a plan into it', async () => {
    const memberId = await createMember();
    const running = await createAssignment(memberId, PENDING_CANCELLATION_STATUS);
    const { rows } = await db.query(
      `SELECT COUNT(*) AS n FROM plan_snapshots pa WHERE pa.anchor_plan_snapshot_id = ?
         AND pa.status IN ('active', 'to_be_canceled')`, [running]);
    expect(Number(rows[0].n)).toBe(1);

    const active = await createAssignment(memberId, 'active');
    const put = await authed(request.put(`/user-memberships/${active}`).send({ status: PENDING_CANCELLATION_STATUS }));
    expect(put.status).toBe(400);
    const { rows: after } = await db.query(`SELECT status FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [active]);
    expect(after[0].status).toBe('active');
  });
});
