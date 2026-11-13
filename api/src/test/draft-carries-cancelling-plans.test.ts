// #2659 stage 3: a Draft Product Set carries the plans the owner is cancelling at
// their period end, for entitlement only — linked (never copied), never billed,
// never projected, never re-opened — and stops carrying them once the sweep has
// moved them to `cancelled`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment,
  createTestGym, createTestMembership, request,
} from './helpers';
import { CANCELS_AT_PERIOD_END_STATUS } from '../domain/assignmentStatus';

const SECRET = 'test-billing-secret-2659-s3';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Carry Member', `carry-${uniq()}@test.com`],
  );
  return insertId as number;
}
async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`,
    [gymId, `Carry Plan ${uniq()}`],
  );
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId as number;
}
const activate = async (um: number) => {
  const res = await request.post(`/user-memberships/${um}/activate`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ on_conflict: 'add' });
  if (res.status >= 300) throw new Error(`activate: ${res.status} ${JSON.stringify(res.body)}`);
};
const cancel = (um: number) =>
  request.delete(`/user-memberships/${um}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const sweep = () => request.post('/assignment-lifecycle/run').set('X-Internal-Secret', SECRET);

async function assignment(um: number) {
  const { rows } = await db.query<{ status: string; ends_at: string }>(
    `SELECT status, DATE_FORMAT(ends_at, '%Y-%m-%d') AS ends_at FROM user_memberships WHERE id = ?`, [um]);
  return rows[0];
}
/** The set's plan links in link order: which assignment each snapshot is the contract of, and the flag. */
async function links(setId: number) {
  const { rows } = await db.query<{ um: number | null; entitlement_only: number }>(
    `SELECT s.source_user_membership_id AS um, j.entitlement_only
       FROM product_set_plan_snapshots j JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
      WHERE j.product_set_id = ? ORDER BY j.id`, [setId]);
  return rows.map((r) => ({ um: r.um == null ? null : Number(r.um), entitlementOnly: Number(r.entitlement_only) === 1 }));
}
async function setOf(um: number, status: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM product_sets WHERE user_membership_id = ? AND status = ? ORDER BY id DESC LIMIT 1', [um, status]);
  return Number(rows[0].id);
}
async function activeSetOf(memberId: number): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'active'`, [gymId, memberId]);
  return Number(rows[0].id);
}

beforeAll(async () => {
  process.env.BILLING_INTERNAL_SECRET = SECRET;
  gymId = await createTestGym('Draft Carries Cancelling Plans Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('a Draft carries the plans cancelling at their period end', () => {
  it('links them for entitlement only, bills and re-opens nothing, and drops them once cancelled', async () => {
    const m = await member();
    const a = await createTestDraftAssignment(gymId, m, await plan(10), { config: { membership_fee_price: 10 } });
    await activate(a);
    const aSnapshotSet = await setOf(a, 'active');
    const { rows: aSnap } = await db.query<{ id: number }>(
      'SELECT plan_snapshot_id AS id FROM product_set_plan_snapshots WHERE product_set_id = ?', [aSnapshotSet]);

    // Cancel A: it runs to its last paid day, and the Active set still carries it, for entitlement only.
    expect((await cancel(a)).status).toBe(204);
    const cancelled = await assignment(a);
    expect(cancelled.status).toBe(CANCELS_AT_PERIOD_END_STATUS);
    const afterCancel = await activeSetOf(m);
    expect(await links(afterCancel)).toEqual([{ um: a, entitlementOnly: true }]);

    // Add Membership Plan: the Draft holds its own plan first and A's same snapshot, linked, not copied.
    const b = await createTestDraftAssignment(gymId, m, await plan(25), { config: { membership_fee_price: 25 } });
    const draft = await setOf(b, 'draft');
    expect(await links(draft)).toEqual([{ um: b, entitlementOnly: false }, { um: a, entitlementOnly: true }]);

    // The Draft's forecast bills B's fee and never A's.
    const forecast = await request.get(`/product-sets/${draft}/billing-event-simulation`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(forecast.status).toBe(200);
    const fees = (forecast.body.dates as any[]).flatMap((d) => d.lines)
      .filter((l: any) => l.kind === 'membership_fee').map((l: any) => Number(l.unit_price));
    expect(fees.length).toBeGreaterThan(0);
    expect(fees.every((f) => f === 25)).toBe(true);
    const { rows: draftSnaps } = await db.query<{ id: number }>(
      'SELECT plan_snapshot_id AS id FROM product_set_plan_snapshots WHERE product_set_id = ? AND entitlement_only = 1', [draft]);
    // #2125 M6b-2: the cancellation is written on a copy made for the set it activated, and that
    // snapshot (not the one the cancelled version still links) is the one the Draft links.
    const { rows: carried } = await db.query<{ id: number }>(
      'SELECT plan_snapshot_id AS id FROM product_set_plan_snapshots WHERE product_set_id = ? AND entitlement_only = 1', [afterCancel]);
    expect(Number(carried[0].id)).not.toBe(Number(aSnap[0].id));
    expect(Number(draftSnaps[0].id)).toBe(Number(carried[0].id));

    // Commit B: A keeps its status and end date, no event of the new set charges A's fee.
    await activate(b);
    expect(await assignment(a)).toEqual(cancelled);
    expect((await assignment(b)).status).toBe('active');
    const active = await activeSetOf(m);
    const activeLinks = await links(active);
    expect(activeLinks.filter((l) => !l.entitlementOnly).map((l) => l.um)).toEqual([b]);
    expect(activeLinks.filter((l) => l.entitlementOnly).map((l) => l.um)).toEqual([a]);
    const { rows: aFees } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM billing_events be JOIN billing_event_lines l ON l.billing_event_id = be.id
        WHERE be.product_set_id = ? AND l.kind = 'membership_fee' AND l.regular_unit_price = 10`, [active]);
    expect(Number(aFees[0].n)).toBe(0);
    const { rows: bFees } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM billing_events be JOIN billing_event_lines l ON l.billing_event_id = be.id
        WHERE be.product_set_id = ? AND l.kind = 'membership_fee' AND l.regular_unit_price = 25`, [active]);
    expect(Number(bFees[0].n)).toBeGreaterThan(0);

    // Once the sweep has moved A to cancelled, a new Draft no longer carries it.
    await db.query('UPDATE user_memberships SET ends_at = UTC_DATE() - INTERVAL 1 DAY WHERE id = ?', [a]);
    expect((await sweep()).status).toBe(200);
    expect((await assignment(a)).status).toBe('cancelled');
    const edit = await request.post(`/user-memberships/${b}/edit-draft`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(edit.status).toBe(201);
    const editDraft = await setOf(Number(edit.body.id), 'draft');
    expect((await links(editDraft)).some((l) => l.entitlementOnly)).toBe(false);
  });

  it('a Draft for an owner with nothing cancelling carries no entitlement link', async () => {
    const m = await member();
    const a = await createTestDraftAssignment(gymId, m, await plan(10));
    expect(await links(await setOf(a, 'draft'))).toEqual([{ um: a, entitlementOnly: false }]);
  });
});
