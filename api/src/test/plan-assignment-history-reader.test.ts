// #2125 M6b-31: the Member card's plan history (`GET /user-memberships/member/:id/configuration`'s
// `plans`) takes each assignment from its current plan snapshot instead of the `user_memberships`
// row: the status and dates from the current snapshot, the creator from the anchor snapshot and the
// last modifier from the latest snapshot that recorded one (M6b-30's dual-write).
import { TEST_ASSIGNMENTS } from './assignmentReads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { testAssignmentWrite } from './assignmentFixture';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'History Reader', `phr-${uniq()}@example.com`]);
  return Number(insertId);
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `PHR Plan ${uniq()}`]);
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
async function historyRow(owner: number, um: number) {
  const res = await auth(request.get(`/user-memberships/member/${owner}/configuration`));
  expect(res.status).toBe(200);
  return res.body.plans.find((p: any) => Number(p.id) === um);
}

beforeAll(async () => {
  gymId = await createTestGym('Plan History Reader Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('the Member card plan history reads plan_snapshots', () => {
  it('reports the same creator and modifier as the legacy row after a change through the API', async () => {
    const { owner, um } = await activePlan();
    expect((await auth(request.put(`/user-memberships/${um}`)).send({ status: 'paused' })).status).toBe(200);
    const { rows } = await db.query<any>(
      `SELECT status, created_by, modified_by FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [um]);
    const row = await historyRow(owner, um);
    expect(row.status).toBe(rows[0].status);
    expect(row.created_by).toBe(rows[0].created_by);
    expect(row.modified_by).toBe(rows[0].modified_by);
  });

  it('follows the snapshot when the legacy row disagrees', async () => {
    const { owner, um } = await activePlan();
    await testAssignmentWrite(
      `UPDATE user_memberships SET status = 'cancelled', starts_at = '2001-01-01', modified_by = 'Legacy Only'
        WHERE id = ?`, [um], { mirror: false });
    const row = await historyRow(owner, um);
    expect(row.status).toBe('active');
    expect(row.is_live).toBe(true);
    expect(row.starts_at).not.toBe('2001-01-01');
    expect(row.modified_by).not.toBe('Legacy Only');
  });

  it('reports the latest modifier across the assignment\'s snapshots, not only the current one', async () => {
    const { owner, um } = await activePlan();
    const { rows } = await db.query<any>(
      'SELECT id FROM plan_snapshots WHERE gym_id = ? AND assignment_id = ? ORDER BY id', [gymId, um]);
    await db.query(
      'UPDATE plan_snapshots SET modified_at = ?, modified_by = ? WHERE gym_id = ? AND assignment_id = ?',
      ['2026-01-01 00:00:00', 'Older Person', gymId, um]);
    await db.query('UPDATE plan_snapshots SET modified_at = ?, modified_by = ? WHERE id = ?',
      ['2026-06-01 00:00:00', 'Latest Person', rows[0].id]);
    expect((await historyRow(owner, um)).modified_by).toBe('Latest Person');
  });
});
