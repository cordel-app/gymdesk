// #2125 M6b-32: `LIST_SELECT` (`GET /user-memberships`, `GET /user-memberships/:id` and the row every
// write answers with) takes each assignment from its current plan snapshot through
// `ASSIGNMENT_HISTORY_ROWS_SQL`, the Member card's plan history's own source (M6b-31), instead of the
// `user_memberships` row: the lifecycle, the creator and the last modifier, plus the three facts the
// list read off `um.*` (`purchased_at`, `replace_on_activation`, `replaces_user_membership_id`).
import { TEST_ASSIGNMENTS } from './assignmentReads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productSetOfLegacyAssignmentSql } from '../domain/planAssignments';
import { db } from '../infra/db';
import { findPlanAssignmentDrift } from '../api/plan-assignment-drift';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { testAssignmentWrite } from './assignmentFixture';

let gymId: string;
let otherGymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'List Reader', `plr-${uniq()}@example.com`]);
  return Number(insertId);
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `PLR Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 30, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
async function activePlan(): Promise<{ owner: number; um: number }> {
  const owner = await member();
  const um = await createTestDraftAssignment(gymId, owner, await plan());
  const act = await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' });
  expect(act.status).toBeLessThan(300);
  return { owner, um };
}

beforeAll(async () => {
  gymId = await createTestGym('Plan List Reader Gym');
  otherGymId = await createTestGym('Plan List Reader Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
});
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id IN (?, ?)', [gymId, otherGymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('LIST_SELECT reads plan_snapshots', () => {
  it('answers the same lifecycle and modifier as the legacy row after a change through the API', async () => {
    const { um } = await activePlan();
    const put = await auth(request.put(`/user-memberships/${um}`)).send({ status: 'paused' });
    expect(put.status).toBe(200);
    const { rows } = await db.query<any>(
      `SELECT status, created_by, modified_by FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [um]);
    expect(put.body.status).toBe('paused');
    expect(put.body.modified_by).toBe(rows[0].modified_by);

    const one = await auth(request.get(`/user-memberships/${um}`));
    expect(one.status).toBe(200);
    expect(one.body.status).toBe(rows[0].status);
    expect(one.body.lifecycle_status).toBe('paused');
    expect(one.body.created_by).toBe(rows[0].created_by);
  });

  it('follows the snapshot when the legacy row disagrees, in the list and the single read', async () => {
    const { owner, um } = await activePlan();
    await testAssignmentWrite(
      `UPDATE user_memberships SET status = 'cancelled', starts_at = '2001-01-01', modified_by = 'Legacy Only',
              purchased_at = '2001-01-01 00:00:00'
        WHERE id = ?`, [um], { mirror: false });

    const list = await auth(request.get(`/user-memberships?member_id=${owner}`));
    expect(list.status).toBe(200);
    const row = list.body.find((r: any) => Number(r.id) === um);
    expect(row.status).toBe('active');
    expect(row.modified_by).not.toBe('Legacy Only');

    const one = await auth(request.get(`/user-memberships/${um}`));
    expect(one.body.status).toBe('active');
    expect(String(one.body.starts_at).slice(0, 10)).not.toBe('2001-01-01');
    expect(String(one.body.purchased_at ?? '')).not.toContain('2001');
  });

  it('reports the replaced assignment by its legacy id from the snapshot', async () => {
    const { um: replaced } = await activePlan();
    const { um } = await activePlan();
    const { rows } = await db.query<any>(
      'SELECT assignment_id FROM plan_snapshots WHERE gym_id = ? AND source_user_membership_id = ? LIMIT 1',
      [gymId, replaced]);
    await db.query(
      'UPDATE plan_snapshots SET replaces_assignment_id = ? WHERE gym_id = ? AND source_user_membership_id = ?',
      [rows[0].assignment_id, gymId, um]);
    const one = await auth(request.get(`/user-memberships/${um}`));
    expect(Number(one.body.replaces_user_membership_id)).toBe(replaced);
  });

  it('keeps tenant isolation: another gym gets a 404 and lists none of it', async () => {
    const { um } = await activePlan();
    expect((await auth(request.get(`/user-memberships/${um}`), otherGymId)).status).toBe(404);
    const list = await auth(request.get('/user-memberships'), otherGymId);
    expect(list.status).toBe(200);
    expect(list.body.some((r: any) => Number(r.id) === um)).toBe(false);
  });

  it('closing a Pending Payment assignment keeps its set as cancelled, so the closed row is still read', async () => {
    const owner = await member();
    const um = await createTestDraftAssignment(gymId, owner, await plan());
    const pay = await auth(request.post(`/user-memberships/${um}/save-and-pay`)).send({});
    expect(pay.status).toBeLessThan(300);
    expect(pay.body.status ?? 'pending_payment').toBe('pending_payment');

    const closed = await auth(request.post(`/user-memberships/${um}/close`)).send({});
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('cancelled');
    expect(closed.body.ends_at).toBeTruthy();

    const one = await auth(request.get(`/user-memberships/${um}`));
    expect(one.status).toBe(200);
    expect(one.body.status).toBe('cancelled');

    const { rows: sets } = await db.query<any>(
      `SELECT status FROM product_sets WHERE gym_id = ? AND ${productSetOfLegacyAssignmentSql('?', 'product_sets')}`, [gymId, um]);
    expect(sets.map((r: any) => r.status)).toEqual(['cancelled']);
    const { rows: audits } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE gym_id = ? AND entity_type = 'user_membership'
          AND entity_id = ? AND action = 'status_change'
          AND JSON_UNQUOTE(JSON_EXTRACT(new_values, '$.status')) = 'cancelled'`, [gymId, String(um)]);
    expect(Number(audits[0].n)).toBe(1);

    const report = await findPlanAssignmentDrift(db as any, gymId);
    for (const name of ['assignment_without_snapshot']) {
      const check = report.checks.find((c) => c.name === name)!;
      expect(check.sample.some((r: any) => Number(r.user_membership_id) === um)).toBe(false);
    }
  });
});
