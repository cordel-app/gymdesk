// #2834 stage 1 — a Membership Plan's Membership Fee scope: set in Pricing, frozen onto the plan
// snapshot, and charged by the billing engine once per assignment (`per_family`) or once per
// beneficiary (`per_member`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';
import { createDraft } from '../api/product-sets';
import { planScheduledEvents, snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { loadProductSetSimulationAssignments } from '../api/plan-snapshot-assignments';
import { loadMemberProductSetView } from '../api/me-product-set-lines';

let gymId: string;
const actor = { name: 'Test', type: 'staff' };
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
// The next 1st: a monthly plan starting there sits on its schedule's grid and is not prorated.
const NEXT_FIRST = (() => {
  const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
})();
const headers = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });

async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `fee-scope-${uniq()}@example.com`]);
  return insertId;
}

async function plan(price: number, scope?: 'per_member' | 'per_family'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 'family')`, [gymId, `Scope-Plan-${uniq()}`]);
  if (scope) await db.query('UPDATE membership_plans SET membership_fee_scope = ? WHERE id = ?', [scope, insertId]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId;
}

/** A Draft version of `planId` for `owner`, with `extra` more beneficiaries on its plan snapshot. */
async function version(owner: number, planId: number, fee: number, extra = 0) {
  const setId = await db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: NEXT_FIRST, actor });
    if (d.kind !== 'created') throw new Error(`expected created, got ${d.kind}`);
    await snapshotProductSetFromPlan(tx, {
      gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: fee, startsAt: NEXT_FIRST,
    });
    return d.productSet.id;
  });
  const { rows } = await db.query<any>(
    'SELECT plan_snapshot_id FROM product_set_plan_snapshots WHERE product_set_id = ?', [setId]);
  const snapshotId = Number(rows[0].plan_snapshot_id);
  for (let i = 0; i < extra; i++) {
    await db.query(
      'INSERT INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner) VALUES (?, ?, ?, 0)',
      [gymId, snapshotId, await member()]);
  }
  return { setId, snapshotId };
}

async function firstFeeLine(setId: number) {
  const events = await planScheduledEvents(gymId, setId, NEXT_FIRST, 1);
  const first = events.find((e) => e.date === NEXT_FIRST)!;
  return first.lines.find((l) => l.kind === 'membership_fee')!;
}

beforeAll(async () => {
  gymId = await createTestGym('Membership fee scope gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('Membership Fee scope on a Membership Plan', () => {
  it('a new plan defaults to per_family', async () => {
    const res = await request.post('/membership-plans').set(headers()).send({ name: `New-${uniq()}` });
    expect(res.status).toBe(201);
    expect(res.body.membership_fee_scope).toBe('per_family');
  });

  it('POST accepts per_member and refuses an unknown value', async () => {
    const ok = await request.post('/membership-plans').set(headers())
      .send({ name: `PM-${uniq()}`, membership_fee_scope: 'per_member' });
    expect(ok.status).toBe(201);
    expect(ok.body.membership_fee_scope).toBe('per_member');
    const bad = await request.post('/membership-plans').set(headers())
      .send({ name: `Bad-${uniq()}`, membership_fee_scope: 'per_household' });
    expect(bad.status).toBe(400);
  });

  it('PUT /:id/pricing sets the scope, keeps it when omitted and refuses an unknown value', async () => {
    const planId = await plan(40);
    const set = await request.put(`/membership-plans/${planId}/pricing`).set(headers())
      .send({ price: 40, membership_fee_scope: 'per_member' });
    expect(set.status).toBe(200);
    expect(set.body.membership_fee_scope).toBe('per_member');

    const kept = await request.put(`/membership-plans/${planId}/pricing`).set(headers()).send({ price: 45 });
    expect(kept.status).toBe(200);
    expect(kept.body.membership_fee_scope).toBe('per_member');

    const bad = await request.put(`/membership-plans/${planId}/pricing`).set(headers())
      .send({ price: 45, membership_fee_scope: null });
    expect(bad.status).toBe(400);
    const { rows } = await db.query<any>('SELECT membership_fee_scope FROM membership_plans WHERE id = ?', [planId]);
    expect(rows[0].membership_fee_scope).toBe('per_member');
  });

  it('Duplicate copies the scope', async () => {
    const planId = await plan(40, 'per_member');
    const res = await request.post(`/membership-plans/${planId}/duplicate`).set(headers());
    expect(res.status).toBe(201);
    const { rows } = await db.query<any>('SELECT membership_fee_scope FROM membership_plans WHERE id = ?', [res.body.id]);
    expect(rows[0].membership_fee_scope).toBe('per_member');
  });
});

describe('Membership Fee scope on a plan snapshot and in billing', () => {
  it('freezes the scope onto the snapshot; a later edit of the Plan moves nothing', async () => {
    const planId = await plan(50, 'per_member');
    const { snapshotId } = await version(await member(), planId, 50);
    await request.put(`/membership-plans/${planId}/pricing`).set(headers())
      .send({ price: 50, membership_fee_scope: 'per_family' });
    const { rows } = await db.query<any>('SELECT membership_fee_scope FROM plan_snapshots WHERE id = ?', [snapshotId]);
    expect(rows[0].membership_fee_scope).toBe('per_member');
  });

  it.each([
    [0, 50],
    [1, 100],
    [2, 150],
  ])('per_member: one fee per beneficiary (%i extra) — charged %d', async (extra, expected) => {
    const planId = await plan(50, 'per_member');
    const { setId } = await version(await member(), planId, 50, extra);
    const [assignment] = await loadProductSetSimulationAssignments(gymId, setId);
    expect(assignment.membershipFeeUnits).toBe(1 + extra);
    const line = await firstFeeLine(setId);
    expect(Number(line.actual_charge)).toBe(expected);
    expect(Number(line.quantity)).toBe(1 + extra);
    expect(Number(line.unit_price)).toBe(50);
  });

  it.each([0, 1, 2])('per_family: one fee per assignment whatever the beneficiaries (%i extra)', async (extra) => {
    const planId = await plan(50, 'per_family');
    const { setId } = await version(await member(), planId, 50, extra);
    const line = await firstFeeLine(setId);
    expect(Number(line.actual_charge)).toBe(50);
    expect(Number(line.quantity)).toBe(1);
  });

  it('the snapshot, not the Plan, decides what an existing assignment is charged', async () => {
    const planId = await plan(50, 'per_family');
    const { setId } = await version(await member(), planId, 50, 2);
    await db.query('UPDATE membership_plans SET membership_fee_scope = ? WHERE id = ?', ['per_member', planId]);
    const line = await firstFeeLine(setId);
    expect(Number(line.actual_charge)).toBe(50);
  });
});

describe('Membership Fee scope on the Members App plan view (#2834 stage 2)', () => {
  it.each([
    ['per_member', 0, 1], ['per_member', 2, 3], ['per_family', 2, 1],
  ] as const)('%s with %i extra beneficiaries reports the scope and %i fee(s); the fee is one fee', async (scope, extra, units) => {
    const planId = await plan(40, scope);
    const { setId } = await version(await member(), planId, 40, extra);
    const view = await loadMemberProductSetView(gymId, { id: setId, status: 'draft', previous_product_set_id: null });
    const p = view.plans[0];
    expect(p.membership_fee_scope).toBe(scope);
    expect(p.membership_fee_units).toBe(units);
    expect(p.membership_fee).toBe(40);
    // The count is the engine's: the fee line charges that many fees.
    const line = await firstFeeLine(setId);
    expect(Number(line.actual_charge)).toBe(40 * units);
  });
});
