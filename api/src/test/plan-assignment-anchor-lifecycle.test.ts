// #2125 M6b-51c-4 (migration 453): an assignment's lifecycle — status, closed time, end date and
// last modifier — is dual-written onto its anchor snapshot by the one writer, so the two records agree
// through every transition, and the anchor is the only snapshot that carries it.
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
    [gymId, 'Anchor Member', `pal-${uniq()}@test.com`]);
  return Number(insertId);
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gymId, `PAL Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
/** The assignment's legacy row and its anchor's lifecycle columns, side by side. */
async function both(um: number) {
  const { rows: legacy } = await db.query<any>(
    `SELECT status, closed_at, ends_at, modified_at, modified_by FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [um]);
  const { rows: anchor } = await db.query<any>(
    `SELECT assignment_status AS status, assignment_closed_at AS closed_at, assignment_ends_at AS ends_at,
            assignment_modified_at AS modified_at, assignment_modified_by AS modified_by
       FROM plan_snapshots WHERE gym_id = ? AND source_user_membership_id = ? AND assignment_id = id`, [gymId, um]);
  return { legacy: legacy[0], anchor: anchor[0] };
}
async function expectInStep(um: number, status: string) {
  const { legacy, anchor } = await both(um);
  expect(anchor).toEqual(legacy);
  expect(anchor.status).toBe(status);
}

beforeAll(async () => {
  gymId = await createTestGym('Plan Assignment Anchor Lifecycle Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('the anchor carries the assignment lifecycle', () => {
  it('follows the assignment from Draft through activation, pause, resume and close', async () => {
    const um = await createTestDraftAssignment(gymId, await member(), await plan());
    await expectInStep(um, 'in_cart');

    const activated = await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' });
    expect(activated.status).toBeLessThan(300);
    await expectInStep(um, 'active');

    expect((await auth(request.put(`/user-memberships/${um}`)).send({ status: 'paused' })).status).toBe(200);
    await expectInStep(um, 'paused');
    expect((await auth(request.put(`/user-memberships/${um}`)).send({ status: 'active' })).status).toBe(200);
    await expectInStep(um, 'active');

    expect((await auth(request.post(`/user-memberships/${um}/close`)).send({})).status).toBeLessThan(300);
    const { legacy, anchor } = await both(um);
    expect(anchor).toEqual(legacy);
    expect(anchor.closed_at).not.toBeNull();
  });

  it('only the anchor carries it: a copy of the snapshot has none', async () => {
    const um = await createTestDraftAssignment(gymId, await member(), await plan());
    await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' });
    const { rows } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM plan_snapshots
        WHERE gym_id = ? AND source_user_membership_id = ? AND assignment_id <> id AND assignment_status IS NOT NULL`,
      [gymId, um]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('a guard that refuses the change leaves both records alone', async () => {
    const um = await createTestDraftAssignment(gymId, await member(), await plan());
    const before = await both(um);
    // A Draft cannot be paused: the transition route refuses it, and nothing is written.
    const res = await auth(request.post(`/user-memberships/${um}/pause`)).send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await both(um)).toEqual(before);
  });

  it('M6b-51d-6: a guard the anchor refuses writes neither record, even when the legacy row would pass it', async () => {
    const um = await createTestDraftAssignment(gymId, await member(), await plan());
    // The legacy row alone says the Draft runs; the anchor says it is in the cart.
    await testAssignmentWrite("UPDATE user_memberships SET status = 'active' WHERE id = ?", [um], { mirror: false });
    const { writeAssignmentLifecycle } = await import('../api/assignment-lifecycle-writer');
    const written = await db.transaction((tx) =>
      writeAssignmentLifecycle(tx, gymId, um, { status: 'paused', from: 'active', actor: 'Test' }));
    expect(written).toBe(0);
    expect((await both(um)).anchor.status).toBe('in_cart');
  });

});
