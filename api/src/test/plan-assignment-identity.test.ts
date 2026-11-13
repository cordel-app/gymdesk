// #2125 M6b-1 (migration 419): `plan_snapshots.assignment_id` is the stable identity of a Membership Plan
// assignment, the assignment-level facts are dual-written beside `user_memberships`, an assignment's
// anchor snapshot is not deletable while another snapshot of it survives, and the read-only drift check
// reports where the two records disagree.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { findPlanAssignmentDrift } from '../api/plan-assignment-drift';
import { deleteUnlinkedPlanSnapshots } from '../api/plan-assignment-sync';
import { copyPlanSnapshotToVersion } from '../api/plan-snapshot-add';
import { discardDraftSet, ownPlanSnapshot } from '../api/plan-snapshot-ownership';
import { createDraft } from '../api/product-sets';
import { snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { CANCELS_AT_PERIOD_END_STATUS } from '../domain/assignmentStatus';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require('../infra/migrations/419_plan_assignment_identity.js');

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Identity Member', `pai-${uniq()}@test.com`]);
  return Number(insertId);
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gymId, `PAI Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
async function activate(um: number, onConflict: 'add' | 'replace' = 'add'): Promise<void> {
  const res = await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: onConflict });
  if (res.status >= 300) throw new Error(`activate: ${res.status} ${JSON.stringify(res.body)}`);
}
/** Every plan snapshot naming the assignment, oldest first. */
async function snapshotsOf(um: number) {
  const { rows } = await db.query<any>(
    `SELECT id, assignment_id, status, purchased_at, replace_on_activation, replaces_assignment_id
       FROM plan_snapshots WHERE gym_id = ? AND source_user_membership_id = ? ORDER BY id`, [gymId, um]);
  return rows.map((r: any) => ({
    id: Number(r.id), assignmentId: r.assignment_id == null ? null : Number(r.assignment_id), status: String(r.status),
    purchasedAt: r.purchased_at, replaceOnActivation: Number(r.replace_on_activation),
    replacesAssignmentId: r.replaces_assignment_id == null ? null : Number(r.replaces_assignment_id),
  }));
}
const check = async (name: string) => (await findPlanAssignmentDrift(db, gymId)).checks.find((c) => c.name === name)!;
/** A Draft Product Set of a new owner with one plan snapshot of its own (no `user_memberships` row). */
async function draftSet(owner?: number): Promise<{ owner: number; set: number; snapshot: number }> {
  const o = owner ?? await member();
  const planId = await plan();
  const set = await db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: o, membershipPlanId: planId, startsAt: TODAY, actor: { name: 'T', type: 'staff' } });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 10, startsAt: TODAY });
    return d.productSet.id;
  });
  const { rows } = await db.query<any>('SELECT plan_snapshot_id AS id FROM product_set_plan_snapshots WHERE product_set_id = ?', [set]);
  return { owner: o, set, snapshot: Number(rows[0].id) };
}
const assignmentIdOf = async (snapshotId: number) => {
  const { rows } = await db.query<any>('SELECT assignment_id FROM plan_snapshots WHERE id = ?', [snapshotId]);
  return rows[0] ? (rows[0].assignment_id == null ? null : Number(rows[0].assignment_id)) : undefined;
};

beforeAll(async () => {
  gymId = await createTestGym('Plan Assignment Identity Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('assignment identity', () => {
  it('a new assignment is anchored on its first snapshot and keeps that identity when it is activated, paused and resumed', async () => {
    const um = await createTestDraftAssignment(gymId, await member(), await plan());
    const [draft] = await snapshotsOf(um);
    expect(draft.assignmentId).toBe(draft.id);
    expect(draft.purchasedAt).toBeNull();

    await activate(um);
    let [snap] = await snapshotsOf(um);
    expect(snap).toMatchObject({ id: draft.id, assignmentId: draft.id, status: 'active' });
    expect(snap.purchasedAt).not.toBeNull();

    expect((await auth(request.put(`/user-memberships/${um}`)).send({ status: 'paused' })).status).toBe(200);
    [snap] = await snapshotsOf(um);
    expect(snap).toMatchObject({ assignmentId: draft.id, status: 'paused' });

    expect((await auth(request.put(`/user-memberships/${um}`)).send({ status: 'active' })).status).toBe(200);
    [snap] = await snapshotsOf(um);
    expect(snap).toMatchObject({ assignmentId: draft.id, status: 'active' });

    const report = await findPlanAssignmentDrift(db, gymId);
    for (const c of report.checks) {
      expect(c.sample.filter((r) => Number(r.user_membership_id) === um), c.name).toEqual([]);
    }
  });

  it('a second plan of the same member is a second assignment, and no key limits the member to one', async () => {
    const m = await member();
    const first = await createTestDraftAssignment(gymId, m, await plan());
    await activate(first);
    const second = await createTestDraftAssignment(gymId, m, await plan());
    await activate(second, 'add');
    const a = (await snapshotsOf(first)).at(-1)!;
    const b = (await snapshotsOf(second)).at(-1)!;
    expect(a.assignmentId).not.toBeNull();
    expect(b.assignmentId).not.toBeNull();
    expect(a.assignmentId).not.toBe(b.assignmentId);
    expect((await check('assignment_id_names_two_assignments')).count).toBe(0);
    expect((await check('assignment_identity_split')).count).toBe(0);
  });

  it('a Draft that replaces a plan names the replaced assignment, and the replacement is its own assignment', async () => {
    const m = await member();
    const um = await createTestDraftAssignment(gymId, m, await plan());
    await activate(um);
    const [original] = await snapshotsOf(um);

    const res = await auth(request.post(`/user-memberships/${um}/assign-new-plan`))
      .send({ membership_plan_id: await plan(), starts_at: TODAY });
    expect(res.status).toBe(201);
    const [replacement] = await snapshotsOf(Number(res.body.id));
    expect(replacement.assignmentId).toBe(replacement.id);
    expect(replacement.replacesAssignmentId).toBe(original.assignmentId);

    await activate(Number(res.body.id), 'replace');
    expect((await snapshotsOf(Number(res.body.id)))[0]).toMatchObject({
      assignmentId: replacement.id, status: 'active', replacesAssignmentId: original.assignmentId,
    });
    // The replaced assignment keeps its identity as history.
    expect((await snapshotsOf(um))[0]).toMatchObject({ assignmentId: original.assignmentId, status: 'superseded' });
  });

  it('a copy for another Product Set is the same assignment; a copy that drops the assignment is a new one', async () => {
    const a = await draftSet();
    const b = await draftSet(await member());
    const same = await db.transaction((tx) => copyPlanSnapshotToVersion(tx, gymId, a.snapshot, b.set, { keepAssignment: true }));
    const fresh = await db.transaction((tx) => copyPlanSnapshotToVersion(tx, gymId, a.snapshot, b.set, { keepAssignment: false }));
    expect(await assignmentIdOf(a.snapshot)).toBe(a.snapshot);
    expect(await assignmentIdOf(same)).toBe(a.snapshot);
    expect(await assignmentIdOf(fresh)).toBe(fresh);
  });

  it('copy-on-write of a shared snapshot keeps the assignment identity', async () => {
    const a = await draftSet();
    const b = await draftSet(await member());
    await db.query('INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [b.set, a.snapshot]);
    const own = await db.transaction((tx) => ownPlanSnapshot(tx, gymId, b.set, a.snapshot));
    expect(own).not.toBe(a.snapshot);
    expect(await assignmentIdOf(own)).toBe(a.snapshot);
  });
});

describe('the identity anchor', () => {
  it('is not deleted while another snapshot of the assignment survives, and goes once none does', async () => {
    const a = await draftSet();
    const b = await draftSet(await member());
    const copy = await db.transaction((tx) => copyPlanSnapshotToVersion(tx, gymId, a.snapshot, b.set, { keepAssignment: true }));

    // Discarding the Draft that holds the anchor keeps the anchor: the copy still names it.
    expect(await db.transaction((tx) => discardDraftSet(tx, gymId, a.set))).toBe(true);
    expect(await assignmentIdOf(a.snapshot)).toBe(a.snapshot);
    expect(await assignmentIdOf(copy)).toBe(a.snapshot);

    // The database refuses it too, whoever asks.
    await expect(db.query('DELETE FROM plan_snapshots WHERE id = ?', [a.snapshot])).rejects.toThrow();

    // Once the copy is gone, so is the anchor (one call: dependants first, then the anchor).
    await db.query('DELETE FROM product_set_plan_snapshots WHERE plan_snapshot_id = ?', [copy]);
    await db.transaction((tx) => deleteUnlinkedPlanSnapshots(tx, gymId, [a.snapshot, copy]));
    expect(await assignmentIdOf(copy)).toBeUndefined();
    expect(await assignmentIdOf(a.snapshot)).toBeUndefined();
  });

  it('a discarded Draft takes its own snapshot with it', async () => {
    const a = await draftSet();
    expect(await db.transaction((tx) => discardDraftSet(tx, gymId, a.set))).toBe(true);
    expect(await assignmentIdOf(a.snapshot)).toBeUndefined();
  });

  it('a snapshot a Product Set still links is never deleted', async () => {
    const a = await draftSet();
    await db.transaction((tx) => deleteUnlinkedPlanSnapshots(tx, gymId, [a.snapshot]));
    expect(await assignmentIdOf(a.snapshot)).toBe(a.snapshot);
  });
});

describe('the drift check', () => {
  it('stores a cancellation at period end under its own status on an un-shared snapshot', async () => {
    const um = await createTestDraftAssignment(gymId, await member(), await plan());
    await activate(um);
    const [snap] = await snapshotsOf(um);
    // The assignment's own stored value, written the way the sweep and the cancel write it.
    await db.query('UPDATE user_memberships SET status = ?, ends_at = UTC_DATE() WHERE id = ?', [CANCELS_AT_PERIOD_END_STATUS, um]);
    const { syncPlanSnapshotsForAssignment } = await import('../api/plan-snapshot-sync');
    await db.transaction((tx) => syncPlanSnapshotsForAssignment(tx, gymId, um));
    expect((await snapshotsOf(um))[0]).toMatchObject({ id: snap.id, status: CANCELS_AT_PERIOD_END_STATUS });
  });

  it('a cancelled plan is not reported: the cancellation is written on a copy of the shared snapshot (M6b-2)', async () => {
    const um = await createTestDraftAssignment(gymId, await member(), await plan());
    await activate(um);
    expect((await auth(request.delete(`/user-memberships/${um}`))).status).toBe(204);
    expect((await check('lifecycle_mismatch')).sample.find((r) => Number(r.user_membership_id) === um)).toBeUndefined();
    const snaps = await snapshotsOf(um);
    expect(snaps.at(-1)).toMatchObject({ assignmentId: snaps[0].id, status: CANCELS_AT_PERIOD_END_STATUS });
  });

  it('reports a lifecycle change that never reached the shared snapshot, marked shared', async () => {
    const um = await createTestDraftAssignment(gymId, await member(), await plan());
    await activate(um);
    expect((await auth(request.delete(`/user-memberships/${um}`))).status).toBe(204);
    // What the sweep's change looks like when nothing re-syncs the set that carries the plan.
    const { rows: carried } = await db.query<any>(
      `SELECT j.product_set_id AS set_id, j.plan_snapshot_id AS id FROM product_set_plan_snapshots j
         JOIN plan_snapshots s ON s.id = j.plan_snapshot_id WHERE s.source_user_membership_id = ? AND j.entitlement_only = 1`, [um]);
    const { rows: other } = await db.query<any>("SELECT id FROM product_sets WHERE gym_id = ? AND id <> ? ORDER BY id DESC LIMIT 1", [gymId, carried[0].set_id]);
    await db.query('INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id, entitlement_only) VALUES (?, ?, 1)', [other[0].id, carried[0].id]);
    await db.query("UPDATE user_memberships SET status = 'cancelled' WHERE id = ?", [um]);
    const row = (await check('lifecycle_mismatch')).sample.find((r) => Number(r.user_membership_id) === um);
    expect(row).toBeDefined();
    expect(String(row!.fields)).toContain('status');
    expect(Number(row!.shared)).toBe(1);
    expect((await findPlanAssignmentDrift(db, gymId)).clean).toBe(false);
    await db.query('DELETE FROM product_set_plan_snapshots WHERE product_set_id = ? AND plan_snapshot_id = ?', [other[0].id, carried[0].id]);
  });

  it('reports a snapshot with no identity and one that names the wrong anchor, and the backfill repairs both', async () => {
    const um = await createTestDraftAssignment(gymId, await member(), await plan());
    const [snap] = await snapshotsOf(um);
    const other = await draftSet();

    await db.query('UPDATE plan_snapshots SET assignment_id = ? WHERE id = ?', [other.snapshot, snap.id]);
    await db.query('UPDATE plan_snapshots SET assignment_id = NULL WHERE id = ?', [other.snapshot]);
    expect((await check('assignment_identity_split')).sample.map((r) => Number(r.plan_snapshot_id))).toContain(snap.id);
    expect((await check('snapshot_without_assignment_id')).sample.map((r) => Number(r.plan_snapshot_id))).toContain(other.snapshot);

    // The migration's backfill, run again: it converges on the same identities (repeatable).
    const knex = { raw: async (sql: string) => { const r: any = await db.query(sql); return [{ affectedRows: Number(r.rowCount ?? 0) }]; } };
    await migration.backfillPlanAssignmentIdentity(knex);
    await migration.backfillPlanAssignmentIdentity(knex);
    expect(await assignmentIdOf(snap.id)).toBe(snap.id);
    expect(await assignmentIdOf(other.snapshot)).toBe(other.snapshot);
    expect((await check('assignment_identity_split')).count).toBe(0);
    expect((await check('snapshot_without_assignment_id')).count).toBe(0);
  });

  it('is scoped to the gym it is asked about', async () => {
    const otherGym = await createTestGym('Plan Assignment Identity Other Gym');
    const report = await findPlanAssignmentDrift(db, otherGym);
    expect(report.clean).toBe(true);
  });
});
