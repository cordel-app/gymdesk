// #2657 stage 3 (option A) — an Individual Product of a Membership Plan is stored as one
// line per member, with its own quantity and Direct Discount. Editing one member's line
// never touches another member's, removing an Optional Individual line removes only that
// member's allocation, a Mandatory one stays, a Shared Product stays one line, a committed
// plan holds its lines per member, and an Active plan's edit leaves the previous version's
// lines as they were. Integration: the real routers against MySQL.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, activateAssignment, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let planId: number;
let lockerId: number; // Individual, the Plan's Mandatory line
let towelId: number; // Individual, Optional
let boxId: number; // Shared, Optional
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const today = () => new Date().toISOString().slice(0, 10);
const as = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function member(name: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `plpm-${uniq()}@test.com`]);
  return Number(insertId);
}

async function product(name: string, sharing: 'individual' | 'shared', mandatory = 0): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, enrollment_status, is_system, sharing_type, mandatory, created_by)
     VALUES (?, ?, 'service', 20, 'EUR', 'month', 'active', 'public', 0, ?, ?, 'test')`, [gymId, name, sharing, mandatory]);
  return Number(insertId);
}

/** A Duo Draft: the owner and their partner, both covered. */
async function duoDraft(): Promise<{ umId: number; owner: number; partner: number }> {
  const owner = await member(`Owner ${uniq()}`);
  const partner = await member(`Partner ${uniq()}`);
  await as(request.post(`/members/${owner}/family`)).send({});
  expect((await as(request.post(`/members/${owner}/family/members`)).send({ member_id: partner })).status).toBeLessThan(300);
  const res = await as(request.post('/user-memberships')).send({ member_id: owner, membership_plan_id: planId, starts_at: today() });
  expect(res.status).toBe(201);
  const umId = Number(res.body.id);
  expect((await as(request.post(`/user-memberships/${umId}/members`)).send({ member_id: partner })).status).toBe(201);
  return { umId, owner, partner };
}

const put = (umId: number, items: unknown[], gym = gymId) =>
  as(request.put(`/user-memberships/${umId}/periodical-benefits`), gym).send({ items });

async function lines(umId: number): Promise<any[]> {
  const res = await as(request.get(`/user-memberships/${umId}/periodical-benefits`));
  expect(res.status).toBe(200);
  return res.body;
}

const shape = (ls: any[], productId: number) => ls
  .filter((l) => l.product_id === productId)
  .map((l) => ({ member: l.assigned_member_id, quantity: l.quantity, discount: l.direct_discount_percent }))
  .sort((a, b) => (a.member ?? 0) - (b.member ?? 0));

beforeAll(async () => {
  gymId = await createTestGym('Plan lines per member gym');
  otherGymId = await createTestGym('Plan lines per member other gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  lockerId = await product(`Locker ${uniq()}`, 'individual');
  towelId = await product(`Towel ${uniq()}`, 'individual');
  boxId = await product(`Box ${uniq()}`, 'shared');
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 'family')`, [gymId, `Duo ${uniq()}`]);
  planId = Number(insertId);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 50, '2020-01-01', 'active')`, [gymId, planId]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  await db.query(
    `INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity, mandatory)
     VALUES (?, ?, ?, 2, 1), (?, ?, ?, 2, 0), (?, ?, ?, 1, 0)`,
    [gymId, planId, lockerId, gymId, planId, towelId, gymId, planId, boxId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('Individual plan lines per member (#2657 stage 3)', () => {
  it('stores each member\'s line with its own Direct Discount, and one member\'s edit leaves the other alone', async () => {
    const { umId, owner, partner } = await duoDraft();
    const before = await lines(umId);
    // Not split yet: one line per Product, its units spread over the two members.
    expect(shape(before, lockerId)).toEqual([{ member: null, quantity: 2, discount: null }]);
    expect(before.find((l) => l.product_id === lockerId).unit_assignees.map((m: any) => m.member_id)).toEqual([owner, partner]);

    const res = await put(umId, [
      { product_id: lockerId, assigned_member_id: owner, quantity: 1, direct_discount_percent: 50 },
      { product_id: lockerId, assigned_member_id: partner, quantity: 1 },
      { product_id: towelId, assigned_member_id: owner, quantity: 1 },
      { product_id: towelId, assigned_member_id: partner, quantity: 1 },
      { product_id: boxId, quantity: 1 },
    ]);
    expect(res.status).toBe(200);
    const after = await lines(umId);
    expect(shape(after, lockerId)).toEqual([
      { member: owner, quantity: 1, discount: 50 }, { member: partner, quantity: 1, discount: null },
    ].sort((a, b) => a.member - b.member));
    // Each member's line is priced on its own discount.
    const ownerLocker = after.find((l) => l.product_id === lockerId && l.assigned_member_id === owner);
    const partnerLocker = after.find((l) => l.product_id === lockerId && l.assigned_member_id === partner);
    expect(ownerLocker.final_line_price_incl_tax).toBe(partnerLocker.final_line_price_incl_tax / 2);
    expect(shape(after, boxId)).toEqual([{ member: null, quantity: 1, discount: null }]);

    // Editing the partner's discount does not move the owner's.
    expect((await put(umId, [
      { product_id: lockerId, assigned_member_id: owner, quantity: 1 },
      { product_id: lockerId, assigned_member_id: partner, quantity: 1, direct_discount_percent: 10 },
      { product_id: towelId, assigned_member_id: owner, quantity: 1 },
      { product_id: towelId, assigned_member_id: partner, quantity: 1 },
      { product_id: boxId, quantity: 1 },
    ])).status).toBe(200);
    expect(shape(await lines(umId), lockerId).map((l) => l.discount))
      .toEqual(owner < partner ? [50, 10] : [10, 50]);
  });

  it('removes one member\'s Optional line only, and refuses removing a member\'s Mandatory line', async () => {
    const { umId, owner, partner } = await duoDraft();
    const res = await put(umId, [
      { product_id: lockerId, assigned_member_id: owner, quantity: 1 },
      { product_id: lockerId, assigned_member_id: partner, quantity: 1 },
      { product_id: towelId, assigned_member_id: owner, quantity: 1 },
      { product_id: boxId, quantity: 1 },
    ]);
    expect(res.status).toBe(200);
    expect(shape(await lines(umId), towelId)).toEqual([{ member: owner, quantity: 1, discount: null }]);

    const refused = await put(umId, [
      { product_id: lockerId, assigned_member_id: owner, quantity: 1 },
      { product_id: towelId, assigned_member_id: owner, quantity: 1 },
      { product_id: boxId, quantity: 1 },
    ]);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('mandatory_line_not_removable');
    expect(shape(await lines(umId), lockerId)).toHaveLength(2);

    // The Shared Product is removed as a whole.
    expect((await put(umId, [
      { product_id: lockerId, assigned_member_id: owner, quantity: 1 },
      { product_id: lockerId, assigned_member_id: partner, quantity: 1 },
      { product_id: towelId, assigned_member_id: owner, quantity: 1 },
    ])).status).toBe(200);
    expect(shape(await lines(umId), boxId)).toEqual([]);
  });

  it('refuses a member on a Shared line, a duplicate member line, an outsider and an ambiguous line', async () => {
    const { umId, owner, partner } = await duoDraft();
    const stranger = await member(`Stranger ${uniq()}`);
    const base = [
      { product_id: lockerId, assigned_member_id: owner, quantity: 1 },
      { product_id: lockerId, assigned_member_id: partner, quantity: 1 },
      { product_id: towelId, quantity: 2 },
    ];
    expect((await put(umId, [...base, { product_id: boxId, assigned_member_id: owner, quantity: 1 }])).status).toBe(400);
    expect((await put(umId, [...base, base[0], { product_id: boxId, quantity: 1 }])).status).toBe(400);
    expect((await put(umId, [...base, { product_id: towelId, assigned_member_id: stranger, quantity: 1 }, { product_id: boxId, quantity: 1 }])).status).toBe(400);
    expect((await put(umId, [...base, { product_id: boxId, quantity: 1 }])).status).toBe(200);
    // The locker is now held per member, so an item naming no member is ambiguous.
    expect((await put(umId, [{ product_id: lockerId, quantity: 2 }, { product_id: towelId, quantity: 2 }])).status).toBe(400);
  });

  it('splits every Individual line when the plan is committed, keeping the units and the Shared line', async () => {
    const { umId, owner, partner } = await duoDraft();
    await activateAssignment(gymId, umId);
    const after = await lines(umId);
    const both = [owner, partner].sort((a, b) => a - b);
    expect(shape(after, lockerId).map((l) => [l.member, l.quantity])).toEqual(both.map((m) => [m, 1]));
    expect(shape(after, towelId).map((l) => [l.member, l.quantity])).toEqual(both.map((m) => [m, 1]));
    expect(shape(after, boxId)).toEqual([{ member: null, quantity: 1, discount: null }]);
  });

  it('removes one member\'s Optional line of an Active plan through a new version, leaving the previous one as it was', async () => {
    const { umId, owner, partner } = await duoDraft();
    await activateAssignment(gymId, umId);
    const { rows: [prev] } = await db.query<{ plan_snapshot_id: number }>(
      `SELECT psj.plan_snapshot_id FROM product_sets ps JOIN product_set_plan_snapshots psj ON psj.product_set_id = ps.id
        WHERE ps.user_membership_id = ? AND ps.status = 'active'`, [umId]);
    const res = await put(umId, [
      { product_id: lockerId, assigned_member_id: owner, quantity: 1 },
      { product_id: lockerId, assigned_member_id: partner, quantity: 1 },
      { product_id: towelId, assigned_member_id: partner, quantity: 1 },
      { product_id: boxId, quantity: 1 },
    ]);
    expect(res.status).toBe(200);
    const { rows: oldTowels } = await db.query<{ assigned_member_id: number }>(
      'SELECT assigned_member_id FROM plan_periodical_snapshots WHERE plan_snapshot_id = ? AND product_id = ?',
      [prev.plan_snapshot_id, towelId]);
    expect(oldTowels.map((r) => Number(r.assigned_member_id)).sort((a, b) => a - b)).toEqual([owner, partner].sort((a, b) => a - b));
    const { rows: [cur] } = await db.query<{ plan_snapshot_id: number }>(
      `SELECT psj.plan_snapshot_id FROM product_sets ps JOIN product_set_plan_snapshots psj ON psj.product_set_id = ps.id
        WHERE ps.owner_member_id = ? AND ps.status = 'active'`, [owner]);
    expect(Number(cur.plan_snapshot_id)).not.toBe(Number(prev.plan_snapshot_id));
    const { rows: newTowels } = await db.query<{ assigned_member_id: number }>(
      'SELECT assigned_member_id FROM plan_periodical_snapshots WHERE plan_snapshot_id = ? AND product_id = ?',
      [cur.plan_snapshot_id, towelId]);
    expect(newTowels.map((r) => Number(r.assigned_member_id))).toEqual([partner]);
  });

  it('gives a catalogue-mandatory Individual Product one line per covered member (#1187)', async () => {
    const insuranceId = await product(`Insurance ${uniq()}`, 'individual', 1);
    const { insertId: soloPlan } = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
       VALUES (?, ?, 'active', 'public', 'family')`, [gymId, `Insured ${uniq()}`]);
    await db.query(
      `INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity, mandatory)
       VALUES (?, ?, ?, 1, 1)`, [gymId, soloPlan, insuranceId]);
    const owner = await member(`Solo ${uniq()}`);
    const partner = await member(`Joiner ${uniq()}`);
    await as(request.post(`/members/${owner}/family`)).send({});
    await as(request.post(`/members/${owner}/family/members`)).send({ member_id: partner });
    const res = await as(request.post('/user-memberships')).send({ member_id: owner, membership_plan_id: soloPlan, starts_at: today() });
    expect(res.status).toBe(201);
    const umId = Number(res.body.id);
    await activateAssignment(gymId, umId);
    expect(shape(await lines(umId), insuranceId)).toEqual([{ member: owner, quantity: 1, discount: null }]);
    expect((await as(request.post(`/user-memberships/${umId}/members`)).send({ member_id: partner })).status).toBe(201);
    const { rows } = await db.query<{ assigned_member_id: number; quantity: number }>(
      `SELECT l.assigned_member_id, l.quantity FROM plan_periodical_snapshots l
         JOIN product_set_plan_snapshots psj ON psj.plan_snapshot_id = l.plan_snapshot_id
         JOIN product_sets ps ON ps.id = psj.product_set_id
        WHERE ps.owner_member_id = ? AND ps.status = 'active' AND l.product_id = ?`, [owner, insuranceId]);
    expect(rows.map((r) => [Number(r.assigned_member_id), Number(r.quantity)]).sort((a, b) => a[0] - b[0]))
      .toEqual([[owner, 1], [partner, 1]].sort((a, b) => a[0] - b[0]));
  });

  it('is invisible to another gym', async () => {
    const { umId, owner } = await duoDraft();
    expect((await put(umId, [{ product_id: lockerId, assigned_member_id: owner, quantity: 1 }], otherGymId)).status).toBe(404);
  });
});
