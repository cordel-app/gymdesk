// #2125 M4a — a Product Set edits only the plan snapshots it owns, and "inherited" can be derived from a link.
// M4b-1 — the sync reads a set's plans from the junction and never writes a snapshot another set links.
// M4b-2 — locking a Draft copies nothing; a writer copies only the plan it edits, right before writing it.
// M4b-3 — `cloneConfiguration()` links the predecessor's plans; the primary plan is the set's first link and
// survives its own copy-on-write; a version that reuses a plan unchanged keeps the plan's assignment.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft } from '../api/product-sets';
import { activateWithEvents, snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { addCoverage } from '../api/product-sets';
import { cloneConfiguration } from '../api/product-set-bridge';
import { primaryPlanSnapshotId, primaryPlanSnapshotSql } from '../api/plan-snapshot-lines';
import { ownPlanSnapshot, discardDraftSet } from '../api/plan-snapshot-ownership';
import { copyPlanSnapshotToVersion } from '../api/plan-snapshot-add';
import { addCoveredMember, isRefusal, lockDraft, setMembershipFeePrice, type LockedDraft } from '../api/product-set-draft';
import { planSnapshotInheritedSql } from '../api/plan-snapshot-lines';
import { syncPlanSnapshot } from '../api/plan-snapshot-sync';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

beforeAll(async () => { gymId = await createTestGym('Snapshot ownership gym'); });
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `own-${uniq()}@example.com`]);
  return insertId;
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '2')`, [gymId, `Own-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 20, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
/** Two Product Sets of one owner, B after A; returns A's plan snapshot. */
async function twoSets(): Promise<{ a: number; b: number; snapshot: number }> {
  const owner = await member();
  const planId = await plan();
  const a = await db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 20, startsAt: TODAY });
    await tx.query("UPDATE product_sets SET status = 'superseded' WHERE id = ?", [d.productSet.id]);
    return d.productSet.id;
  });
  const b = await db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    return d.productSet.id;
  });
  await db.query('UPDATE product_sets SET previous_product_set_id = ? WHERE id = ?', [a, b]);
  const { rows } = await db.query<any>('SELECT plan_snapshot_id FROM product_set_plan_snapshots WHERE product_set_id = ?', [a]);
  return { a, b, snapshot: Number(rows[0].plan_snapshot_id) };
}
const linked = async (setId: number) =>
  (await db.query<any>('SELECT plan_snapshot_id AS s FROM product_set_plan_snapshots WHERE product_set_id = ? ORDER BY 1', [setId])).rows.map((r: any) => Number(r.s));
/** The set's links in the order they were made — the first is its primary plan (M4b-3). */
const linkedInOrder = async (setId: number) =>
  (await db.query<any>('SELECT plan_snapshot_id AS s FROM product_set_plan_snapshots WHERE product_set_id = ? ORDER BY id', [setId])).rows.map((r: any) => Number(r.s));

describe('ownPlanSnapshot (#2125 M4a)', () => {
  it('returns the snapshot untouched when no other Product Set uses it', async () => {
    const { a, snapshot } = await twoSets();
    expect(await db.transaction((tx) => ownPlanSnapshot(tx, gymId, a, snapshot))).toBe(snapshot);
    expect(await linked(a)).toEqual([snapshot]);
  });

  it('copies a shared snapshot for the set being edited and leaves the other set\'s alone', async () => {
    const { a, b, snapshot } = await twoSets();
    await db.query('INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [b, snapshot]);

    const own = await db.transaction((tx) => ownPlanSnapshot(tx, gymId, b, snapshot));
    expect(own).not.toBe(snapshot);
    expect(await linked(b)).toEqual([own]);
    expect(await linked(a)).toEqual([snapshot]);

    // The copy carries the same configuration and beneficiaries, and editing it does not touch the original.
    const { rows } = await db.query<any>('SELECT membership_fee_price AS fee FROM plan_snapshots WHERE id IN (?, ?) ORDER BY id', [snapshot, own]);
    expect(rows.map((r: any) => Number(r.fee))).toEqual([20, 20]);
    const { rows: ben } = await db.query<any>('SELECT plan_snapshot_id FROM plan_snapshot_beneficiaries WHERE plan_snapshot_id IN (?, ?)', [snapshot, own]);
    expect(ben).toHaveLength(2);
    await db.query('UPDATE plan_snapshots SET membership_fee_price = 99 WHERE id = ?', [own]);
    const { rows: orig } = await db.query<any>('SELECT membership_fee_price AS fee FROM plan_snapshots WHERE id = ?', [snapshot]);
    expect(Number(orig[0].fee)).toBe(20);

    // The copy records its source (#2125 M5a), so the edited plan still reads as inherited by the Draft,
    // which is what keeps a new Plan Promotion off it.
    const { rows: lineage } = await db.query<any>(
      `SELECT copied_from_plan_snapshot_id AS src, ${planSnapshotInheritedSql('s', '?')} AS inh FROM plan_snapshots s WHERE s.id = ?`,
      [b, own]);
    expect(Number(lineage[0].src)).toBe(snapshot);
    expect(Number(lineage[0].inh)).toBe(1);
  });
});

describe('planSnapshotInheritedSql (#2125 M4a)', () => {
  it('is true for a snapshot the previous Product Set also links, false for one the set added', async () => {
    const { b, snapshot } = await twoSets();
    const inherited = async (setId: number, snapId: number) => Number((await db.query<any>(
      `SELECT ${planSnapshotInheritedSql('s', '?')} AS i FROM plan_snapshots s WHERE s.id = ?`, [setId, snapId])).rows[0].i);
    // Not linked by B's predecessor and not flagged: added by B.
    const { rows: own } = await db.query<any>('SELECT plan_snapshot_id FROM product_set_plan_snapshots WHERE product_set_id = ?', [b]);
    expect(own).toHaveLength(0);
    // The original is linked by A, B's previous: seen from B it carries over.
    expect(await inherited(b, snapshot)).toBe(1);
    // A snapshot nobody else links, copied from nothing, is new.
    const { insertId } = await db.query(
      `INSERT INTO plan_snapshots (gym_id, product_set_id, member_id, membership_plan_id, status, starts_at)
       SELECT gym_id, ?, member_id, membership_plan_id, 'draft', starts_at FROM plan_snapshots WHERE id = ?`, [b, snapshot]);
    expect(await inherited(b, Number(insertId))).toBe(0);
    // A copy of an inherited snapshot (an edited inherited plan, M5a) is inherited through its lineage.
    const { insertId: copyId } = await db.query(
      `INSERT INTO plan_snapshots (gym_id, product_set_id, member_id, membership_plan_id, status, starts_at, copied_from_plan_snapshot_id)
       SELECT gym_id, ?, member_id, membership_plan_id, 'draft', starts_at, id FROM plan_snapshots WHERE id = ?`, [b, snapshot]);
    expect(await inherited(b, Number(copyId))).toBe(1);
  });
});

describe('a Draft writer copies only the plan it edits (#2125 M4b-2)', () => {
  const share = (setId: number, snapId: number) =>
    db.query('INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [setId, snapId]);
  const fee = async (snapId: number) =>
    Number((await db.query<any>('SELECT membership_fee_price AS f FROM plan_snapshots WHERE id = ?', [snapId])).rows[0].f);
  const beneficiaries = async (snapId: number) =>
    Number((await db.query<any>('SELECT COUNT(*) AS n FROM plan_snapshot_beneficiaries WHERE plan_snapshot_id = ?', [snapId])).rows[0].n);
  const locked = async (tx: any, setId: number): Promise<LockedDraft> => {
    const d = await lockDraft(tx, gymId, setId);
    if (isRefusal(d)) throw new Error(d.kind);
    return d;
  };

  it('locking a Draft leaves a plan it shares with the previous set shared', async () => {
    const { a, b, snapshot } = await twoSets();
    await share(b, snapshot);
    await db.transaction((tx) => locked(tx, b));
    // Until M4b-2 the lock copied every linked snapshot; an unmodified plan is reused, not copied.
    expect(await linked(b)).toEqual([snapshot]);
    expect(await linked(a)).toEqual([snapshot]);
  });

  it('a fee edit copies the plan for the Draft and leaves the other set on the original', async () => {
    const { a, b, snapshot } = await twoSets();
    await share(b, snapshot);
    await db.transaction(async (tx) => {
      expect(await setMembershipFeePrice(tx, await locked(tx, b), 30)).toEqual({ ok: true });
    });
    const mine = await linked(b);
    expect(mine).toHaveLength(1);
    expect(mine[0]).not.toBe(snapshot);
    expect(await linked(a)).toEqual([snapshot]);
    expect(await fee(mine[0])).toBe(30);
    expect(await fee(snapshot)).toBe(20);
  });

  it('a coverage change copies the plan it covers and not the other plan the Draft shares', async () => {
    const { a, b, snapshot } = await twoSets();
    // The previous set holds a second plan; the Draft reuses both unchanged.
    const second = await db.transaction((tx) => copyPlanSnapshotToVersion(tx, gymId, snapshot, a));
    await share(b, snapshot);
    await share(b, second);
    const other = await member();
    await db.transaction(async (tx) => {
      expect(await addCoveredMember(tx, await locked(tx, b), other)).toEqual({ ok: true });
    });
    const mine = await linked(b);
    expect(mine).toHaveLength(2);
    expect(mine).toContain(second);
    const copy = mine.find((id) => id !== second)!;
    expect(copy).not.toBe(snapshot);
    expect(await linked(a)).toEqual([snapshot, second]);
    // Only the copy gained the beneficiary; the two originals are exactly as they were.
    expect(await beneficiaries(copy)).toBe(2);
    expect(await beneficiaries(snapshot)).toBe(1);
    expect(await beneficiaries(second)).toBe(1);
  });
});

describe('discardDraftSet (#2125 M4b-0)', () => {
  it('discarding a Draft keeps a snapshot another set still links, and only a Draft is deleted', async () => {
    const { a, b, snapshot } = await twoSets();
    // The snapshot's own set pointer is the Draft's; the superseded A links it too.
    await db.query('UPDATE plan_snapshots SET product_set_id = ? WHERE id = ?', [b, snapshot]);
    await db.query('INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [b, snapshot]);
    expect(await db.transaction((tx) => discardDraftSet(tx, gymId, b))).toBe(true);
    const { rows } = await db.query<any>('SELECT product_set_id FROM plan_snapshots WHERE id = ?', [snapshot]);
    expect(Number(rows[0].product_set_id)).toBe(a);
    // A (superseded) is not a Draft: nothing is deleted.
    expect(await db.transaction((tx) => discardDraftSet(tx, gymId, a))).toBe(false);
  });
});

describe('syncPlanSnapshot and a shared plan snapshot (#2125 M4b-1)', () => {
  const state = async (snapId: number) => {
    const { rows } = await db.query<any>(
      `SELECT status, starts_at, ends_at, closed_at, member_id, source_user_membership_id,
              (SELECT COUNT(*) FROM plan_snapshot_beneficiaries b WHERE b.plan_snapshot_id = s.id) AS beneficiaries
         FROM plan_snapshots s WHERE id = ?`, [snapId]);
    return rows[0];
  };

  it('keeps a link the column disagrees with, and leaves a snapshot two sets link exactly as it is', async () => {
    const { a, b, snapshot } = await twoSets();
    await db.transaction((tx) => syncPlanSnapshot(tx, gymId, a));
    const before = await state(snapshot);
    expect(before.status).toBe('superseded');

    // The Draft B reuses A's plan unchanged: a link, not a copy. The snapshot's own column still names A.
    await db.query('INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [b, snapshot]);
    await db.query('UPDATE product_sets SET starts_at = DATE_ADD(starts_at, INTERVAL 7 DAY) WHERE id = ?', [b]);

    await db.transaction((tx) => syncPlanSnapshot(tx, gymId, b));
    // The junction is the record of the link: the sync does not drop it because the column says A.
    expect(await linked(b)).toEqual([snapshot]);
    expect(await linked(a)).toEqual([snapshot]);
    // Shared, so immutable: no status, date, member, assignment or beneficiary of it moved for B...
    expect(await state(snapshot)).toEqual(before);
    // ...nor for A, which also links it.
    await db.transaction((tx) => syncPlanSnapshot(tx, gymId, a));
    expect(await state(snapshot)).toEqual(before);
  });

  it('moves a snapshot again once the set owns it alone', async () => {
    const { a, b, snapshot } = await twoSets();
    await db.transaction((tx) => syncPlanSnapshot(tx, gymId, a));
    const before = await state(snapshot);
    await db.query('INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [b, snapshot]);
    await db.query('UPDATE product_sets SET starts_at = DATE_ADD(starts_at, INTERVAL 7 DAY) WHERE id = ?', [b]);

    const own = await db.transaction((tx) => ownPlanSnapshot(tx, gymId, b, snapshot));
    await db.transaction((tx) => syncPlanSnapshot(tx, gymId, b));
    expect(await linked(b)).toEqual([own]);
    const copy = await state(own);
    expect(copy.status).toBe('draft');
    const { rows: setB } = await db.query<any>('SELECT starts_at FROM product_sets WHERE id = ?', [b]);
    expect(copy.starts_at).toEqual(setB[0].starts_at);
    expect(copy.starts_at).not.toEqual(before.starts_at);
    // The original is still A's alone and untouched.
    expect(await linked(a)).toEqual([snapshot]);
    expect(await state(snapshot)).toEqual(before);
  });
});

describe('cloneConfiguration links the predecessor\'s plans (#2125 M4b-3)', () => {
  /** A with two plans (its own and a second one), active; B a Draft after it, cloned from A. */
  async function cloned(): Promise<{ a: number; b: number; snapshot: number; second: number }> {
    const { a, b, snapshot } = await twoSets();
    await db.query("UPDATE product_sets SET status = 'active' WHERE id = ?", [a]);
    const second = await db.transaction((tx) => copyPlanSnapshotToVersion(tx, gymId, snapshot, a));
    await db.transaction((tx) => cloneConfiguration(tx, gymId, a, b));
    return { a, b, snapshot, second };
  }
  const snapshotCount = async () =>
    Number((await db.query<any>('SELECT COUNT(*) AS n FROM plan_snapshots WHERE gym_id = ?', [gymId])).rows[0].n);
  const fee = async (snapId: number) =>
    Number((await db.query<any>('SELECT membership_fee_price AS f FROM plan_snapshots WHERE id = ?', [snapId])).rows[0].f);

  it('a Draft cloned from the active set links the same snapshots, in the same order, and copies none', async () => {
    const { a, b, snapshot } = await twoSets();
    await db.query("UPDATE product_sets SET status = 'active' WHERE id = ?", [a]);
    await db.transaction((tx) => syncPlanSnapshot(tx, gymId, a));
    const second = await db.transaction((tx) => copyPlanSnapshotToVersion(tx, gymId, snapshot, a));
    const before = await snapshotCount();
    await db.transaction((tx) => cloneConfiguration(tx, gymId, a, b));
    // Until M4b-3 the clone copied every plan as an inherited snapshot of B.
    expect(await snapshotCount()).toBe(before);
    expect(await linkedInOrder(b)).toEqual([snapshot, second]);
    expect(await linkedInOrder(a)).toEqual([snapshot, second]);
    expect(await db.transaction((tx) => primaryPlanSnapshotId(tx, gymId, b))).toBe(snapshot);
    // Seen from B, both carry over from A.
    const { rows } = await db.query<any>(
      `SELECT ${planSnapshotInheritedSql('s', '?')} AS i FROM plan_snapshots s WHERE s.id IN (?, ?) ORDER BY s.id`, [b, snapshot, second]);
    expect(rows.map((r: any) => Number(r.i))).toEqual([1, 1]);
    // The shared snapshot keeps the state it had: still the active set's, not the Draft's.
    const { rows: st } = await db.query<any>('SELECT status FROM plan_snapshots WHERE id = ?', [snapshot]);
    expect(st[0].status).toBe('active');
  });

  it('editing the primary plan keeps it primary although its copy carries the highest id', async () => {
    const { a, b, snapshot, second } = await cloned();
    await db.transaction(async (tx) => {
      const d = await lockDraft(tx, gymId, b);
      if (isRefusal(d)) throw new Error(d.kind);
      expect(await setMembershipFeePrice(tx, d, 30)).toEqual({ ok: true });
    });
    const mine = await linkedInOrder(b);
    expect(mine).toHaveLength(2);
    const copy = mine[0];
    expect(copy).not.toBe(snapshot);
    expect(copy).toBeGreaterThan(second);
    // The copy took the link's place: first link, so still the primary — by both spellings.
    expect(mine).toEqual([copy, second]);
    expect(await db.transaction((tx) => primaryPlanSnapshotId(tx, gymId, b))).toBe(copy);
    const { rows } = await db.query<any>(`SELECT ${primaryPlanSnapshotSql('?', '?')} AS id`, [b, gymId]);
    expect(Number(rows[0].id)).toBe(copy);
    expect(await fee(copy)).toBe(30);
    expect(await fee(snapshot)).toBe(20);
    // A is untouched: its own two plans, in its own order.
    expect(await linkedInOrder(a)).toEqual([snapshot, second]);
  });

  it('discarding the Draft leaves the shared snapshots to the active set and deletes only its own copy', async () => {
    const { a, b, snapshot, second } = await cloned();
    await db.transaction(async (tx) => {
      const d = await lockDraft(tx, gymId, b);
      if (isRefusal(d)) throw new Error(d.kind);
      await setMembershipFeePrice(tx, d, 30);
    });
    const [copy] = await linkedInOrder(b);
    expect(await db.transaction((tx) => discardDraftSet(tx, gymId, b))).toBe(true);
    const { rows } = await db.query<any>('SELECT id FROM plan_snapshots WHERE id IN (?, ?, ?) ORDER BY id', [snapshot, second, copy]);
    expect(rows.map((r: any) => Number(r.id))).toEqual([snapshot, second]);
    expect(await linkedInOrder(a)).toEqual([snapshot, second]);
  });
});

describe('activating a version that reuses the plan unchanged keeps its assignment (#2125 M4b-3)', () => {
  async function activeSet(): Promise<{ owner: number; planId: number; a: number; um: number; snapshot: number }> {
    const owner = await member();
    const planId = await plan();
    const a = await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
      if (d.kind !== 'created') throw new Error(d.kind);
      await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 20, startsAt: TODAY });
      await addCoverage(tx, { gymId, productSetId: d.productSet.id, memberId: owner, isOwner: true });
      const out = await activateWithEvents(tx, { gymId, productSetId: d.productSet.id, today: TODAY });
      if (out.kind !== 'ok') throw new Error(out.kind);
      return d.productSet.id;
    });
    const { rows } = await db.query<any>('SELECT user_membership_id FROM product_sets WHERE id = ?', [a]);
    const snapshot = (await linked(a))[0];
    return { owner, planId, a, um: Number(rows[0].user_membership_id), snapshot };
  }
  /** A successor Draft cloned from A, optionally with its fee edited, then activated. */
  async function successor(owner: number, planId: number, a: number, edit: boolean): Promise<number> {
    return db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
      if (d.kind !== 'created') throw new Error(d.kind);
      await cloneConfiguration(tx, gymId, a, d.productSet.id);
      if (edit) {
        const locked = await lockDraft(tx, gymId, d.productSet.id);
        if (isRefusal(locked)) throw new Error(locked.kind);
        await setMembershipFeePrice(tx, locked, 30);
      }
      const out = await activateWithEvents(tx, { gymId, productSetId: d.productSet.id, today: TODAY });
      if (out.kind !== 'ok') throw new Error(out.kind);
      return d.productSet.id;
    });
  }
  const assignments = async (owner: number) =>
    (await db.query<any>('SELECT id, status FROM user_memberships WHERE member_id = ? AND gym_id = ? ORDER BY id', [owner, gymId])).rows
      .map((r: any) => ({ id: Number(r.id), status: String(r.status) }));
  const snapshotState = async (snapId: number) => {
    const { rows } = await db.query<any>('SELECT status, source_user_membership_id AS um FROM plan_snapshots WHERE id = ?', [snapId]);
    return { status: String(rows[0].status), um: rows[0].um == null ? null : Number(rows[0].um) };
  };

  it('an unchanged plan: the successor takes the assignment over, closes nothing, and the snapshot stays shared', async () => {
    const { owner, planId, a, um, snapshot } = await activeSet();
    const b = await successor(owner, planId, a, false);
    // Until M4b-3 every successor closed the assignment as superseded and opened a same-plan one.
    expect(await assignments(owner)).toEqual([{ id: um, status: 'active' }]);
    const { rows } = await db.query<any>('SELECT id, status, user_membership_id AS um FROM product_sets WHERE id IN (?, ?) ORDER BY id', [a, b]);
    expect(rows.map((r: any) => [String(r.status), Number(r.um)])).toEqual([['superseded', um], ['active', um]]);
    expect(await linked(a)).toEqual([snapshot]);
    expect(await linked(b)).toEqual([snapshot]);
    expect(await snapshotState(snapshot)).toEqual({ status: 'active', um });
  });

  it('an edited plan: the successor opens its own assignment and the predecessor keeps the original', async () => {
    const { owner, planId, a, um, snapshot } = await activeSet();
    const b = await successor(owner, planId, a, true);
    const rows = await assignments(owner);
    expect(rows.map((r) => r.status)).toEqual(['superseded', 'active']);
    expect(rows[0].id).toBe(um);
    const successorUm = rows[1].id;
    const { rows: setB } = await db.query<any>('SELECT user_membership_id AS um FROM product_sets WHERE id = ?', [b]);
    expect(Number(setB[0].um)).toBe(successorUm);
    const [copy] = await linked(b);
    expect(copy).not.toBe(snapshot);
    expect(await linked(a)).toEqual([snapshot]);
    expect(await snapshotState(copy)).toEqual({ status: 'active', um: successorUm });
    expect((await snapshotState(snapshot)).um).toBe(um);
  });
});
