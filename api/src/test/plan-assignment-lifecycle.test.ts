// #2125 M6b-2: a lifecycle change (pause, resume, cancellation, the end-of-period sweep) on a plan
// snapshot more than one Product Set links is written on a copy made for the owner's Active set: same
// assignment, the previous snapshot left as it was, the Promotion snapshots reused rather than copied.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { findPlanAssignmentDrift } from '../api/plan-assignment-drift';
import { findUnsettledActiveSets, inFlightLinkMove } from '../api/plan-assignment-lifecycle';
import { settlePlanAssignmentLifecycles } from '../api/plan-assignment-settle';
import { deleteUnlinkedPlanSnapshots } from '../api/plan-assignment-sync';
import { loadProductSetSimulationAssignments } from '../api/plan-snapshot-assignments';
import { CANCELS_AT_PERIOD_END_STATUS } from '../domain/assignmentStatus';

const SECRET = 'plan-assignment-lifecycle-secret';
process.env.BILLING_INTERNAL_SECRET = SECRET;

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Lifecycle Member', `pal-${uniq()}@test.com`]);
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
async function promotion(planId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                             only_applicable_for_new_members, paid_months)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, 0, 12)`, [gymId, `PAL Promo ${uniq()}`]);
  await db.query('INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, insertId, planId]);
  await db.query(
    `INSERT INTO promotion_membership_fee_benefits (gym_id, promotion_id, duration_months, enabled, action, value)
     VALUES (?, ?, NULL, 1, 'percentage_discount', 10)`, [gymId, insertId]);
  return Number(insertId);
}
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};
const activate = async (um: number) =>
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
const setStatus = async (um: number, status: 'paused' | 'active') =>
  must(await auth(request.put(`/user-memberships/${um}`)).send({ status }), status);
const cancel = async (um: number) => must(await auth(request.delete(`/user-memberships/${um}`)), 'cancel');
const sweep = async () => must(await request.post('/assignment-lifecycle/run').set('X-Internal-Secret', SECRET), 'sweep');
/** A Draft cloned from the owner's Active set: it links the Active set's plan snapshots unchanged. */
const draftOf = async (memberId: number): Promise<number> =>
  Number(must(await auth(request.post('/product-sets/draft')).send({ member_id: memberId }), 'draft').body.id);
const activateSet = async (setId: number) =>
  must(await auth(request.post(`/product-sets/${setId}/activate`)).send({}), 'activate set');
/** A member with one active plan whose Active set shares its snapshot with the set it superseded. */
async function reusedPlan(): Promise<{ m: number; um: number; planId: number }> {
  const m = await member();
  const planId = await plan();
  const um = await createTestDraftAssignment(gymId, m, planId);
  await activate(um);
  await activateSet(await draftOf(m));
  return { m, um, planId };
}

async function activeSetOf(memberId: number): Promise<number> {
  const { rows } = await db.query<any>(
    "SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'active'", [gymId, memberId]);
  return Number(rows[0].id);
}
interface Link { set: number; setStatus: string; snapshot: number; entitlementOnly: boolean }
async function linksOf(memberId: number): Promise<Link[]> {
  const { rows } = await db.query<any>(
    `SELECT j.product_set_id, p.status, j.plan_snapshot_id, j.entitlement_only
       FROM product_set_plan_snapshots j JOIN product_sets p ON p.id = j.product_set_id
      WHERE p.gym_id = ? AND p.owner_member_id = ? ORDER BY j.product_set_id, j.id`, [gymId, memberId]);
  return rows.map((r: any) => ({
    set: Number(r.product_set_id), setStatus: String(r.status), snapshot: Number(r.plan_snapshot_id),
    entitlementOnly: Number(r.entitlement_only) === 1,
  }));
}
async function snapshot(id: number) {
  const { rows } = await db.query<any>(
    `SELECT id, assignment_id, status, copied_from_plan_snapshot_id AS copied_from, promotions_plan_snapshot_id AS holder,
            source_user_membership_id AS um, closed_at, DATE_FORMAT(ends_at, '%Y-%m-%d') AS ends_at
       FROM plan_snapshots WHERE id = ?`, [id]);
  const r = rows[0];
  if (!r) return undefined;
  return {
    id: Number(r.id), assignmentId: Number(r.assignment_id), status: String(r.status),
    copiedFrom: r.copied_from == null ? null : Number(r.copied_from), holder: r.holder == null ? null : Number(r.holder),
    um: r.um == null ? null : Number(r.um), closedAt: r.closed_at, endsAt: r.ends_at as string | null,
  };
}
const linkOfSet = async (memberId: number, setId: number) => (await linksOf(memberId)).filter((l) => l.set === setId);
async function driftOf(um: number) {
  const report = await findPlanAssignmentDrift(db, gymId);
  return report.checks.flatMap((c) => c.sample.filter((r) => Number(r.user_membership_id) === um).map((r) => ({ check: c.name, ...r })));
}
const promotionSnapshotCount = async () => {
  const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM plan_promotion_snapshots WHERE gym_id = ?', [gymId]);
  return Number(rows[0].n);
};

beforeAll(async () => {
  gymId = await createTestGym('Plan Assignment Lifecycle Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('a lifecycle change on a plan snapshot two Product Sets link', () => {
  it('pausing writes a copy for the Active set and leaves the superseded set and its snapshot alone', async () => {
    const { m, um } = await reusedPlan();
    const active = await activeSetOf(m);
    const before = await linksOf(m);
    const shared = before.find((l) => l.set === active)!.snapshot;
    expect(before.filter((l) => l.snapshot === shared)).toHaveLength(2);

    await setStatus(um, 'paused');

    const after = await linksOf(m);
    const superseded = after.find((l) => l.setStatus === 'superseded')!;
    expect(superseded.snapshot).toBe(shared);
    const [link] = await linkOfSet(m, active);
    expect(link.snapshot).not.toBe(shared);
    const copy = (await snapshot(link.snapshot))!;
    const original = (await snapshot(shared))!;
    expect(copy).toMatchObject({ status: 'paused', copiedFrom: shared, um, assignmentId: original.assignmentId });
    expect(original.status).not.toBe('paused');
    expect(await driftOf(um)).toEqual([]);
  });

  it('resuming a plan whose paused snapshot is its set\'s own writes it in place, with no further copy', async () => {
    const { m, um } = await reusedPlan();
    const active = await activeSetOf(m);
    await setStatus(um, 'paused');
    const [paused] = await linkOfSet(m, active);

    await setStatus(um, 'active');

    const [resumed] = await linkOfSet(m, active);
    expect(resumed.snapshot).toBe(paused.snapshot);
    expect((await snapshot(resumed.snapshot))!.status).toBe('active');
    expect(await driftOf(um)).toEqual([]);
  });

  it('an in-flight Draft follows a pause, so committing it does not bring the previous status back', async () => {
    const m = await member();
    const um = await createTestDraftAssignment(gymId, m, await plan());
    await activate(um);
    const active = await activeSetOf(m);
    const draft = await draftOf(m);
    const [shared] = await linkOfSet(m, active);

    await setStatus(um, 'paused');

    const [activeLink] = await linkOfSet(m, active);
    const [draftLink] = await linkOfSet(m, draft);
    expect(activeLink.snapshot).not.toBe(shared.snapshot);
    expect(draftLink.snapshot).toBe(activeLink.snapshot);
    expect((await snapshot(activeLink.snapshot))!.status).toBe('paused');
    // The original is no longer linked, and is kept: it is the assignment's anchor.
    const original = (await snapshot(shared.snapshot))!;
    expect(original).toMatchObject({ status: 'active', assignmentId: shared.snapshot });
    expect(await driftOf(um)).toEqual([]);
  });

  it('a second plan of the member is paused on its own snapshot and the first plan is untouched', async () => {
    const m = await member();
    const first = await createTestDraftAssignment(gymId, m, await plan());
    await activate(first);
    const second = await createTestDraftAssignment(gymId, m, await plan());
    await activate(second);

    await setStatus(first, 'paused');

    const active = await activeSetOf(m);
    const snaps = await Promise.all((await linkOfSet(m, active)).map((l) => snapshot(l.snapshot)));
    expect(snaps.find((s) => s!.um === first)!.status).toBe('paused');
    expect(snaps.find((s) => s!.um === second)!.status).toBe('active');
    expect(await driftOf(first)).toEqual([]);
    expect(await driftOf(second)).toEqual([]);
  });
});

describe('Promotion snapshots of a lifecycle copy', () => {
  it('are the source\'s own records: none is created, and the paused plan still prices with them', async () => {
    const m = await member();
    const planId = await plan();
    const um = await createTestDraftAssignment(gymId, m, planId, { config: { base_price: 100 } });
    must(await auth(request.post(`/user-memberships/${um}/promotions`)).send({ promotion_id: await promotion(planId) }), 'apply');
    await activate(um);
    await activateSet(await draftOf(m));
    const active = await activeSetOf(m);
    const [shared] = await linkOfSet(m, active);
    const { rows: held } = await db.query<any>(
      'SELECT id FROM plan_promotion_snapshots WHERE plan_snapshot_id = ? ORDER BY id', [shared.snapshot]);
    expect(held).toHaveLength(1);
    const total = await promotionSnapshotCount();

    await setStatus(um, 'paused');

    const [link] = await linkOfSet(m, active);
    const copy = (await snapshot(link.snapshot))!;
    expect(copy).toMatchObject({ status: 'paused', holder: shared.snapshot });
    expect(await promotionSnapshotCount()).toBe(total);
    const { rows: still } = await db.query<any>(
      'SELECT id FROM plan_promotion_snapshots WHERE plan_snapshot_id = ? ORDER BY id', [shared.snapshot]);
    expect(still.map((r: any) => Number(r.id))).toEqual(held.map((r: any) => Number(r.id)));
    const { rows: onCopy } = await db.query<any>('SELECT id FROM plan_promotion_snapshots WHERE plan_snapshot_id = ?', [copy.id]);
    expect(onCopy).toEqual([]);

    const assignments = await loadProductSetSimulationAssignments(gymId, active);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].promotions).toHaveLength(1);

    // A second lifecycle change keeps pointing at the same records.
    await activateSet(await draftOf(m));
    await setStatus(um, 'paused');
    const [again] = await linkOfSet(m, await activeSetOf(m));
    expect((await snapshot(again.snapshot))!.holder).toBe(shared.snapshot);
    expect(await promotionSnapshotCount()).toBe(total);
  });

  it('the snapshot that holds them is not deleted while a copy reuses them', async () => {
    const { m, um } = await reusedPlan();
    await setStatus(um, 'paused');
    const [link] = await linkOfSet(m, await activeSetOf(m));
    const copy = (await snapshot(link.snapshot))!;
    const holder = copy.holder!;
    // Not the anchor's protection: point the copy at a snapshot that is nobody's anchor and has no link.
    const { insertId } = await db.query(
      `INSERT INTO plan_snapshots (gym_id, member_id, membership_plan_id, status, starts_at, assignment_id)
       SELECT gym_id, member_id, membership_plan_id, 'superseded', starts_at, assignment_id FROM plan_snapshots WHERE id = ?`, [holder]);
    await db.query('UPDATE plan_snapshots SET promotions_plan_snapshot_id = ? WHERE id = ?', [insertId, copy.id]);

    await db.transaction((tx) => deleteUnlinkedPlanSnapshots(tx, gymId, [Number(insertId)]));
    expect(await snapshot(Number(insertId))).toBeDefined();

    await db.query('UPDATE plan_snapshots SET promotions_plan_snapshot_id = ? WHERE id = ?', [holder, copy.id]);
    await db.transaction((tx) => deleteUnlinkedPlanSnapshots(tx, gymId, [Number(insertId)]));
    expect(await snapshot(Number(insertId))).toBeUndefined();
  });
});

describe('cancelling a plan', () => {
  it('gives the new Active set a copy that cancels at the period end, and leaves the previous set\'s snapshot as it was', async () => {
    const { m, um } = await reusedPlan();
    const previous = await activeSetOf(m);
    const [before] = await linkOfSet(m, previous);
    const stateBefore = (await snapshot(before.snapshot))!;

    await cancel(um);

    const active = await activeSetOf(m);
    expect(active).not.toBe(previous);
    const [carried] = await linkOfSet(m, active);
    expect(carried.entitlementOnly).toBe(true);
    expect(carried.snapshot).not.toBe(before.snapshot);
    const copy = (await snapshot(carried.snapshot))!;
    expect(copy).toMatchObject({
      status: CANCELS_AT_PERIOD_END_STATUS, um, assignmentId: stateBefore.assignmentId, copiedFrom: before.snapshot,
    });
    expect(copy.endsAt).not.toBeNull();
    expect(copy.closedAt).not.toBeNull();
    // The previous Product Set still links the snapshot it had, which did not take the cancellation.
    expect((await linkOfSet(m, previous))[0].snapshot).toBe(before.snapshot);
    const original = (await snapshot(before.snapshot))!;
    expect(original.status).not.toBe(CANCELS_AT_PERIOD_END_STATUS);
    expect(original.endsAt).toBe(stateBefore.endsAt);
    expect(await driftOf(um)).toEqual([]);
  });

  it('the end-of-period sweep cancels the Active set\'s copy and a Draft stops carrying the plan', async () => {
    const { m, um } = await reusedPlan();
    await cancel(um);
    const active = await activeSetOf(m);
    const [carried] = await linkOfSet(m, active);
    const draft = await draftOf(m);
    expect((await linkOfSet(m, draft)).map((l) => l.snapshot)).toEqual([carried.snapshot]);

    await db.query('UPDATE user_memberships SET ends_at = DATE_SUB(UTC_DATE(), INTERVAL 1 DAY) WHERE id = ?', [um]);
    await sweep();

    const [ended] = await linkOfSet(m, active);
    expect(ended.entitlementOnly).toBe(true);
    const copy = (await snapshot(ended.snapshot))!;
    expect(copy).toMatchObject({ status: 'cancelled', um });
    expect(ended.snapshot).not.toBe(carried.snapshot);
    expect(await linkOfSet(m, draft)).toEqual([]);
    expect(await driftOf(um)).toEqual([]);
  });
});

describe('the repair of changes made before the writer existed', () => {
  it('a dry run lists the Active set and writes nothing; executing settles it with a copy', async () => {
    const { m, um } = await reusedPlan();
    const active = await activeSetOf(m);
    const [before] = await linkOfSet(m, active);
    // What a pause looked like before this stage: the assignment moved, the shared snapshot did not.
    await db.query("UPDATE user_memberships SET status = 'paused' WHERE id = ?", [um]);
    expect((await findUnsettledActiveSets(db, gymId)).map((s) => s.productSetId)).toContain(active);

    const dry = await settlePlanAssignmentLifecycles({ gymId, execute: false });
    expect(dry.found).toBeGreaterThanOrEqual(1);
    expect(dry.settled).toBe(0);
    expect((await linkOfSet(m, active))[0].snapshot).toBe(before.snapshot);

    const done = await settlePlanAssignmentLifecycles({ gymId, execute: true });
    expect(done.remaining).toBe(0);
    const [after] = await linkOfSet(m, active);
    expect(after.snapshot).not.toBe(before.snapshot);
    expect((await snapshot(after.snapshot))!.status).toBe('paused');
    expect((await snapshot(before.snapshot))!.status).not.toBe('paused');
    expect(await driftOf(um)).toEqual([]);
  });
});

describe('inFlightLinkMove', () => {
  it('a pause or a resume is followed, whatever the link', () => {
    for (const status of ['active', 'paused']) {
      expect(inFlightLinkMove(status, false)).toBe('follow');
      expect(inFlightLinkMove(status, true)).toBe('follow');
    }
  });
  it('a plan cancelling at its period end is followed only where it is carried for entitlement', () => {
    expect(inFlightLinkMove(CANCELS_AT_PERIOD_END_STATUS, true)).toBe('follow');
    expect(inFlightLinkMove(CANCELS_AT_PERIOD_END_STATUS, false)).toBe('keep');
  });
  it('a plan that ended is dropped where it was carried for entitlement, and a billable link is never touched', () => {
    for (const status of ['cancelled', 'expired']) {
      expect(inFlightLinkMove(status, true)).toBe('drop');
      expect(inFlightLinkMove(status, false)).toBe('keep');
    }
  });
});
