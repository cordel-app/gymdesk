// #2125 M6b-6: a plan that ended (replaced, or cancelled with nothing left to run) says so on the
// snapshot that states the assignment. Where a cancelled plan's snapshot is shared by older Product
// Sets, the owner's Active set carries a copy for the record; where one superseded set alone links
// it, the status is kept in place.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { findPlanAssignmentDrift } from '../api/plan-assignment-drift';
import { findUnsettledActiveSets } from '../api/plan-assignment-lifecycle';
import { settlePlanAssignmentLifecycles } from '../api/plan-assignment-settle';
import { deleteUnlinkedPlanSnapshots } from '../api/plan-assignment-sync';
import { currentAssignmentSnapshotSql } from '../domain/planAssignments';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Closed Status Member', `pacs-${uniq()}@test.com`]);
  return Number(insertId);
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gymId, `PACS Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
const activate = async (um: number, onConflict: 'add' | 'replace' = 'add') =>
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: onConflict }), 'activate');
/** A Draft cloned from the owner's Active set: it links the Active set's plan snapshots unchanged. */
const draftOf = async (memberId: number): Promise<number> =>
  Number(must(await auth(request.post('/product-sets/draft')).send({ member_id: memberId }), 'draft').body.id);
const activateSet = async (setId: number) =>
  must(await auth(request.post(`/product-sets/${setId}/activate`)).send({}), 'activate set');

/** A member with one running plan. `reused`: its snapshot is shared by the Active set and the set it superseded. */
async function runningPlan(reused: boolean, startsAt?: string): Promise<{ m: number; um: number }> {
  const m = await member();
  const um = await createTestDraftAssignment(gymId, m, await plan(), { startsAt });
  await activate(um);
  if (reused) await activateSet(await draftOf(m));
  return { m, um };
}
/** Replaces every running plan of the member with a new one; answers the new assignment. */
async function replacePlans(m: number): Promise<number> {
  const next = await createTestDraftAssignment(gymId, m, await plan());
  await activate(next, 'replace');
  return next;
}

async function activeSetOf(memberId: number): Promise<number> {
  const { rows } = await db.query<any>(
    "SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'active'", [gymId, memberId]);
  return Number(rows[0].id);
}
interface Snapshot {
  id: number; assignmentId: number; status: string; copiedFrom: number | null; closedAt: unknown; endsAt: string | null;
}
const SNAPSHOT_COLUMNS = `s.id, s.assignment_id, s.status, s.copied_from_plan_snapshot_id AS copied_from, s.closed_at,
                          DATE_FORMAT(s.ends_at, '%Y-%m-%d') AS ends_at`;
const toSnapshot = (r: any): Snapshot => ({
  id: Number(r.id), assignmentId: Number(r.assignment_id), status: String(r.status),
  copiedFrom: r.copied_from == null ? null : Number(r.copied_from), closedAt: r.closed_at, endsAt: r.ends_at,
});
/** Every snapshot of the assignment the `user_memberships` row is, oldest first. */
async function snapshotsOf(um: number): Promise<Snapshot[]> {
  const { rows } = await db.query<any>(
    `SELECT ${SNAPSHOT_COLUMNS} FROM plan_snapshots s
      WHERE s.gym_id = ? AND s.source_user_membership_id = ? ORDER BY s.id`, [gymId, um]);
  return rows.map(toSnapshot);
}
/** The snapshot that states the assignment now (`currentAssignmentSnapshotSql()`). */
async function currentOf(um: number): Promise<Snapshot> {
  const [anchor] = await snapshotsOf(um);
  const { rows } = await db.query<any>(
    `SELECT ${SNAPSHOT_COLUMNS} FROM plan_snapshots s
      WHERE s.id = ${currentAssignmentSnapshotSql('?', '?')}`, [anchor.assignmentId, gymId]);
  return toSnapshot(rows[0]);
}
interface Link { set: number; setStatus: string; entitlementOnly: boolean }
async function linksTo(snapshotId: number): Promise<Link[]> {
  const { rows } = await db.query<any>(
    `SELECT j.product_set_id, p.status, j.entitlement_only
       FROM product_set_plan_snapshots j JOIN product_sets p ON p.id = j.product_set_id
      WHERE j.plan_snapshot_id = ? ORDER BY j.product_set_id`, [snapshotId]);
  return rows.map((r: any) => ({
    set: Number(r.product_set_id), setStatus: String(r.status), entitlementOnly: Number(r.entitlement_only) === 1,
  }));
}
async function assignment(um: number) {
  const { rows } = await db.query<any>(
    "SELECT status, closed_at, DATE_FORMAT(ends_at, '%Y-%m-%d') AS ends_at FROM user_memberships WHERE id = ?", [um]);
  return { status: String(rows[0].status), closedAt: rows[0].closed_at, endsAt: rows[0].ends_at as string | null };
}
const lastWeek = () => new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
/** Cancelling a plan that started last week and was never paid ends it at once. */
const cancel = async (um: number) => must(await auth(request.delete(`/user-memberships/${um}`)), 'cancel');
/** What `npm run plan-assignments:validate` reports for the assignment. */
async function driftOf(um: number) {
  const report = await findPlanAssignmentDrift(db, gymId);
  return report.checks.flatMap((c) => c.sample.filter((r) => Number(r.user_membership_id) === um).map((r) => ({ check: c.name, ...r })));
}
const unsettled = async () => (await findUnsettledActiveSets(db, gymId)).map((s) => s.productSetId);

beforeAll(async () => {
  gymId = await createTestGym('Plan Assignment Closed Status Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('a replaced plan', () => {
  it.each([[true], [false]])('reads superseded on the snapshot that states it, and the new Active set carries nothing (reused: %s)', async (reused) => {
    const { m, um } = await runningPlan(reused);

    const next = await replacePlans(m);

    expect((await assignment(um)).status).toBe('superseded');
    const current = await currentOf(um);
    expect(current.status).toBe('superseded');
    expect(current.closedAt).not.toBeNull();
    const active = await activeSetOf(m);
    expect((await linksTo(current.id)).map((l) => l.setStatus)).toEqual(['superseded']);
    // The new plan is the Active set's own running plan, and nothing is left to settle.
    expect((await assignment(next)).status).toBe('active');
    expect((await currentOf(next)).status).toBe('active');
    expect(await unsettled()).not.toContain(active);
  });
});

describe('a plan cancelled with nothing left to run', () => {
  it('reads cancelled on a copy the plan-less Active set carries when older Product Sets share its snapshot', async () => {
    const { m, um } = await runningPlan(true, lastWeek());
    const [original] = await snapshotsOf(um);

    await cancel(um);

    const closed = await assignment(um);
    expect(closed.status).toBe('cancelled');
    const current = await currentOf(um);
    expect(current).toMatchObject({
      status: 'cancelled', assignmentId: original.assignmentId, copiedFrom: original.id, endsAt: closed.endsAt,
    });
    expect(current.closedAt).not.toBeNull();
    const active = await activeSetOf(m);
    expect(await linksTo(current.id)).toEqual([{ set: active, setStatus: 'active', entitlementOnly: true }]);
    expect((await snapshotsOf(um))[0].status).toBe(original.status);
    // The Member has no running plan, and a new Draft does not bring the cancelled one back.
    expect((await linksTo(current.id)).length).toBe(1);
    await draftOf(m);
    expect((await linksTo(current.id)).map((l) => l.set)).toEqual([active]);
    expect(await driftOf(um)).toEqual([]);
  });

  it('keeps cancelled, not superseded, on the snapshot its superseded set alone links', async () => {
    const { m, um } = await runningPlan(false, lastWeek());
    const [original] = await snapshotsOf(um);

    await cancel(um);

    expect((await assignment(um)).status).toBe('cancelled');
    const all = await snapshotsOf(um);
    expect(all.map((s) => s.id)).toEqual([original.id]);
    expect(all[0].status).toBe('cancelled');
    expect((await linksTo(original.id)).map((l) => l.setStatus)).toEqual(['superseded']);
    expect(await unsettled()).not.toContain(await activeSetOf(m));
    expect((await driftOf(um)).filter((d: any) => String(d.fields ?? '').includes('status'))).toEqual([]);
  });
});

describe('the repair of plans that ended before this stage', () => {
  /** A cancelled plan as it was left before M6b-6: no copy, the shared snapshot still reading active. */
  async function endedBeforeThisStage(): Promise<{ m: number; um: number; active: number; original: number }> {
    const { m, um } = await runningPlan(true, lastWeek());
    await cancel(um);
    const copy = await currentOf(um);
    const active = await activeSetOf(m);
    await db.query('DELETE FROM product_set_plan_snapshots WHERE product_set_id = ? AND plan_snapshot_id = ?', [active, copy.id]);
    await db.transaction((tx) => deleteUnlinkedPlanSnapshots(tx, gymId, [copy.id]));
    const [original] = await snapshotsOf(um);
    expect((await currentOf(um)).id).toBe(original.id);
    expect(original.status).toBe('active');
    return { m, um, active, original: original.id };
  }

  it('a dry run lists the owner\'s Active set and writes nothing; executing states the plan as ended', async () => {
    const { um, active, original } = await endedBeforeThisStage();
    expect(await unsettled()).toContain(active);

    const dry = await settlePlanAssignmentLifecycles({ gymId, execute: false });
    expect(dry.settled).toBe(0);
    expect((await currentOf(um)).id).toBe(original);

    const done = await settlePlanAssignmentLifecycles({ gymId, execute: true });
    expect(done.remaining).toBe(0);
    const current = await currentOf(um);
    expect(current).toMatchObject({ status: 'cancelled', copiedFrom: original });
    expect(await linksTo(current.id)).toEqual([{ set: active, setStatus: 'active', entitlementOnly: true }]);
  });

  it('a plan a changed plan took over is stated as superseded', async () => {
    const { um, active, original } = await endedBeforeThisStage();
    await db.query("UPDATE user_memberships SET status = 'superseded' WHERE id = ?", [um]);
    expect(await unsettled()).toContain(active);

    await settlePlanAssignmentLifecycles({ gymId, execute: true });

    expect(await currentOf(um)).toMatchObject({ status: 'superseded', copiedFrom: original });
    expect(await unsettled()).toEqual([]);
  });
});
