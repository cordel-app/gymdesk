// #2125 M6b-20: the Membership Fee pricing loader (`loadFeeAssignment()` / `loadFeeAssignments()`,
// behind every staff and member fee read and the nightly pricing) and the configuration overlay
// (`withAssignmentConfig()`, behind the Assigned Plans list and card) take the assignment from its
// current plan snapshot. Each test makes the snapshot and the legacy `user_memberships` row
// disagree and asserts the snapshot wins.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { loadFeeAssignment, loadFeeAssignments } from '../api/membership-fee-pricing';
import { withAssignmentConfig } from '../api/assignment-config';
import { currentAssignmentSnapshotSql } from '../domain/planAssignments';
import { testAssignmentWrite } from './assignmentFixture';

let gymId: string;
let otherGymId: string;
let centerId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};
const day = (v: unknown) => new Date(v as string).toISOString().slice(0, 10);

async function running(): Promise<number> {
  const m = Number(must(await auth(request.post('/members'))
    .send({ name: 'Fee Reader', email: `pfr-${uniq()}@test.com`, default_center_id: centerId }), 'member').body.id);
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `PFR Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 30, '2020-01-01', 'active')`, [gymId, planId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  const um = await createTestDraftAssignment(gymId, m, Number(planId));
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
  return um;
}
async function currentSnapshotId(um: number): Promise<number> {
  const { rows } = await db.query<any>(
    `SELECT ${currentAssignmentSnapshotSql('a.anchor_plan_snapshot_id', 'a.gym_id')} AS id
       FROM plan_snapshots a WHERE a.gym_id = ? AND a.anchor_plan_snapshot_id = ? LIMIT 1`, [gymId, um]);
  return Number(rows[0].id);
}

beforeAll(async () => {
  gymId = await createTestGym('Assignment Fee Readers Gym');
  otherGymId = await createTestGym('Assignment Fee Readers Other Gym');
  await createTestMembership(gymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'PFR Center', 'active']));
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('the Membership Fee pricing loader reads the assignment from plan_snapshots', () => {
  it('reports the current snapshot\'s start date, not the legacy row\'s', async () => {
    const um = await running();
    await db.query("UPDATE plan_snapshots SET starts_at = '2026-01-05' WHERE id = ?", [await currentSnapshotId(um)]);
    await testAssignmentWrite("UPDATE user_memberships SET starts_at = '2025-03-09' WHERE id = ?", [um], { mirror: false });
    const row = await loadFeeAssignment(gymId, um);
    expect(row).not.toBeNull();
    expect(Number(row!.id)).toBe(um);
    expect(day(row!.starts_at)).toBe('2026-01-05');
    const many = await loadFeeAssignments(gymId, [um, um]);
    expect([...many.keys()]).toEqual([um]);
    expect(day(many.get(um)!.starts_at)).toBe('2026-01-05');
  });

  it('answers nothing for another gym\'s assignment or an unknown id', async () => {
    const um = await running();
    expect(await loadFeeAssignment(otherGymId, um)).toBeNull();
    expect(await loadFeeAssignment(gymId, 999999999)).toBeNull();
    expect((await loadFeeAssignments(otherGymId, [um])).size).toBe(0);
  });
});

describe('withAssignmentConfig overlays the current snapshot\'s configuration', () => {
  it('overlays the snapshot\'s fee and leaves a row it cannot place alone', async () => {
    const um = await running();
    await db.query('UPDATE plan_snapshots SET membership_fee_price = 42 WHERE id = ?', [await currentSnapshotId(um)]);
    const [row] = await withAssignmentConfig(gymId, [{ id: um, membership_fee_price: null } as any]);
    expect(Number(row.membership_fee_price)).toBe(42);
    const [foreign] = await withAssignmentConfig(otherGymId, [{ id: um, membership_fee_price: 7 } as any]);
    expect(foreign.membership_fee_price).toBe(7);
  });

  it('the Assigned Plan card reports the overlaid fee', async () => {
    const um = await running();
    await db.query('UPDATE plan_snapshots SET membership_fee_price = 55 WHERE id = ?', [await currentSnapshotId(um)]);
    const res = must(await auth(request.get(`/user-memberships/${um}`)), 'get');
    expect(Number(res.body.membership_fee_price)).toBe(55);
  });
});
