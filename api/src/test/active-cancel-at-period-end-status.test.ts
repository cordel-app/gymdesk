// #2659 stage 1 — `active_cancel_at_period_end` is a stored assignment status
// that nothing writes yet, and every reader gives it the answer it gives a
// `cancelled` row. These tests store the value directly (the way stage 2's
// writers will) and check the readers against a `cancelled` twin.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, legacyAssignmentQuery, request,
} from './helpers';
import { ASSIGNMENT_STATUSES, CANCELS_AT_PERIOD_END_STATUS } from '../domain/assignmentStatus';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const today = () => new Date().toISOString().slice(0, 10);

async function createMember(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'ACPE Member', `acpe-${uniq()}@test.com`],
  );
  return insertId;
}

async function createAssignment(memberId: number, status: string, startsAt: string, endsAt: string | null): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `ACPE Plan ${uniq()}`],
  );
  const { insertId } = await legacyAssignmentQuery(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, ends_at, base_price)
     VALUES (?, ?, ?, ?, ?, ?, 40)`,
    [gymId, memberId, planId, status, startsAt, endsAt],
  );
  return insertId;
}

const authed = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

beforeAll(async () => {
  gymId = await createTestGym('ACPE Status Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('user_memberships.status — active_cancel_at_period_end (#2659 stage 1)', () => {
  it('the CHECK accepts exactly the declared statuses', async () => {
    const { rows: checks } = await db.query(
      `SELECT cc.CHECK_CLAUSE AS clause
         FROM information_schema.CHECK_CONSTRAINTS cc
        WHERE cc.CONSTRAINT_SCHEMA = DATABASE() AND cc.CONSTRAINT_NAME = 'user_memberships_status_check'`,
    );
    const values = [...String(checks[0].clause).replace(/\\/g, '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(values).toEqual([...ASSIGNMENT_STATUSES].sort());
  });

  it('reads Cancels on End Date until ends_at, then Cancelled — exactly like a cancelled row', async () => {
    const memberId = await createMember();
    const storedFuture = await createAssignment(memberId, CANCELS_AT_PERIOD_END_STATUS, '2026-01-01', '2099-12-31');
    const storedToday = await createAssignment(memberId, CANCELS_AT_PERIOD_END_STATUS, '2026-01-01', today());
    const storedPast = await createAssignment(memberId, CANCELS_AT_PERIOD_END_STATUS, '2020-01-01', '2020-12-31');
    const legacyFuture = await createAssignment(memberId, 'cancelled', '2026-01-01', '2099-12-31');

    const res = await authed(request.get(`/user-memberships/member/${memberId}/configuration`));
    expect(res.status).toBe(200);
    const byId = new Map<number, any>(res.body.plans.map((p: any) => [p.id, p]));
    expect(byId.get(storedFuture).lifecycle_status).toBe('cancels_on_end_date');
    expect(byId.get(storedToday).lifecycle_status).toBe('cancels_on_end_date');
    expect(byId.get(storedPast).lifecycle_status).toBe('cancelled');
    expect(byId.get(storedFuture).status).toBe(CANCELS_AT_PERIOD_END_STATUS);
    // Same grouping as the derived twin: in the current group until it ends, never live.
    for (const id of [storedFuture, legacyFuture]) {
      expect(byId.get(id).is_current).toBe(true);
      expect(Number(byId.get(id).is_live)).toBe(0);
    }
    expect(byId.get(storedPast).is_current).toBe(false);

    const list = await authed(request.get(`/user-memberships?member_id=${memberId}&lifecycle_status=cancels_on_end_date`));
    expect(list.status).toBe(200);
    const listed = (Array.isArray(list.body) ? list.body : list.body.rows ?? list.body.data).map((r: any) => r.id).sort();
    expect(listed).toEqual([storedFuture, storedToday, legacyFuture].sort());

    const byStatus = await authed(request.get(`/user-memberships?member_id=${memberId}&status=${CANCELS_AT_PERIOD_END_STATUS}`));
    expect(byStatus.status).toBe(200);
  });

  it('cannot be cancelled again, and no PUT moves a plan into it', async () => {
    const memberId = await createMember();
    const ending = await createAssignment(memberId, CANCELS_AT_PERIOD_END_STATUS, '2026-01-01', '2099-12-31');
    const del = await authed(request.delete(`/user-memberships/${ending}`));
    expect(del.status).toBe(404);
    const { rows } = await db.query('SELECT status FROM user_memberships WHERE id = ?', [ending]);
    expect(rows[0].status).toBe(CANCELS_AT_PERIOD_END_STATUS);

    const active = await createAssignment(memberId, 'active', '2026-01-01', null);
    const put = await authed(request.put(`/user-memberships/${active}`).send({ status: CANCELS_AT_PERIOD_END_STATUS }));
    expect(put.status).toBe(400);
    const { rows: after } = await db.query('SELECT status FROM user_memberships WHERE id = ?', [active]);
    expect(after[0].status).toBe('active');
  });
});
