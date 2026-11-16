// #2945 — an independent Direct Discount (%) on each Membership Fee line of a `per_member` plan:
// written per beneficiary through the Assigned Plan's fee-benefit route, read back per member,
// and charged per fee unit by the billing engine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { planScheduledEvents } from '../api/product-set-configuration';

let gymId: string;
let otherGymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const NEXT_FIRST = (() => {
  const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
})();
const headers = (g = gymId) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': g });

async function member(name: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, name, `fee-disc-${uniq()}@example.com`]);
  return insertId;
}

async function plan(price: number, scope: 'per_member' | 'per_family'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit, membership_fee_scope)
     VALUES (?, ?, 'active', 'public', 'family', ?)`, [gymId, `FeeDisc-${uniq()}`, scope]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId;
}

/** A Draft assignment of a fee-50 plan for an owner plus one more beneficiary. */
async function assignment(scope: 'per_member' | 'per_family') {
  const owner = await member('Owner');
  const other = await member('Second');
  const planId = await plan(50, scope);
  const umId = await createTestDraftAssignment(gymId, owner, planId, { startsAt: NEXT_FIRST });
  const { rows } = await db.query<any>(
    `SELECT j.plan_snapshot_id, j.product_set_id FROM product_sets ps
       JOIN product_set_plan_snapshots j ON j.product_set_id = ps.id
      WHERE ps.user_membership_id = ? ORDER BY ps.id DESC LIMIT 1`, [umId]);
  const snapshotId = Number(rows[0].plan_snapshot_id);
  await db.query('UPDATE plan_snapshots SET membership_fee_price = 50 WHERE id = ?', [snapshotId]);
  await db.query(
    'INSERT INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner) VALUES (?, ?, ?, 0)',
    [gymId, snapshotId, other]);
  return { umId, owner, other, snapshotId, setId: Number(rows[0].product_set_id) };
}

async function feeLine(setId: number) {
  const events = await planScheduledEvents(gymId, setId, NEXT_FIRST, 1);
  return events.find((e) => e.date === NEXT_FIRST)!.lines.find((l) => l.kind === 'membership_fee')!;
}

beforeAll(async () => {
  gymId = await createTestGym('Fee member discounts gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('Fee member discounts other gym');
  await createTestMembership(otherGymId, 'admin');
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('PUT /user-memberships/:id/fee-benefit — member_discounts', () => {
  it('stores a discount per beneficiary; editing one leaves the other untouched', async () => {
    const a = await assignment('per_member');
    const first = await request.put(`/user-memberships/${a.umId}/fee-benefit`).set(headers())
      .send({ member_discounts: [{ member_id: a.owner, percent: 50 }, { member_id: a.other, percent: 25 }] });
    expect(first.status).toBe(200);

    const second = await request.put(`/user-memberships/${a.umId}/fee-benefit`).set(headers())
      .send({ member_discounts: [{ member_id: a.owner, percent: 10 }] });
    expect(second.status).toBe(200);

    const detail = await request.get(`/user-memberships/${a.umId}`).set(headers());
    expect(detail.status).toBe(200);
    const byId = new Map<number, any>(detail.body.members.map((m: any) => [Number(m.member_id), m]));
    expect(Number(byId.get(a.owner).fee_direct_discount_percent)).toBe(10);
    expect(Number(byId.get(a.other).fee_direct_discount_percent)).toBe(25);
    // Each row's fee for the current cycle, priced with its own discount.
    expect(detail.body.membership_fee_by_member[String(a.owner)]).toBe(45);
    expect(detail.body.membership_fee_by_member[String(a.other)]).toBe(37.5);
    // The shared Personal Membership Fee Benefit was not touched.
    expect(detail.body.snapshot.personal_fee_benefit.action).toBe('no_benefit');
  });

  it('the engine charges each fee unit with its own discount; NULL follows the shared benefit', async () => {
    const a = await assignment('per_member');
    // Shared benefit 20%, the second member's own 50%: 40 + 25.
    const shared = await request.put(`/user-memberships/${a.umId}/fee-benefit`).set(headers())
      .send({ action: 'percentage_discount', value: 20 });
    expect(shared.status).toBe(200);
    const own = await request.put(`/user-memberships/${a.umId}/fee-benefit`).set(headers())
      .send({ member_discounts: [{ member_id: a.other, percent: 50 }] });
    expect(own.status).toBe(200);
    const line = await feeLine(a.setId);
    expect(Number(line.quantity)).toBe(2);
    expect(Number(line.actual_charge)).toBe(65);

    // 0 means no discount for that fee (it no longer follows the shared 20%).
    await request.put(`/user-memberships/${a.umId}/fee-benefit`).set(headers())
      .send({ member_discounts: [{ member_id: a.other, percent: 0 }] });
    expect(Number((await feeLine(a.setId)).actual_charge)).toBe(90);

    // null returns it to the shared benefit: 40 + 40.
    await request.put(`/user-memberships/${a.umId}/fee-benefit`).set(headers())
      .send({ member_discounts: [{ member_id: a.other, percent: null }] });
    expect(Number((await feeLine(a.setId)).actual_charge)).toBe(80);
  });

  it('without any own discount the charge is the pre-#2945 one', async () => {
    const a = await assignment('per_member');
    const line = await feeLine(a.setId);
    expect(Number(line.actual_charge)).toBe(100);
  });

  it('refuses a member who is not a beneficiary, a bad percentage and a per_family plan', async () => {
    const a = await assignment('per_member');
    const stranger = await member('Stranger');
    const notBen = await request.put(`/user-memberships/${a.umId}/fee-benefit`).set(headers())
      .send({ member_discounts: [{ member_id: stranger, percent: 10 }] });
    expect(notBen.status).toBe(400);
    const bad = await request.put(`/user-memberships/${a.umId}/fee-benefit`).set(headers())
      .send({ member_discounts: [{ member_id: a.owner, percent: 120 }] });
    expect(bad.status).toBe(400);
    const { rows } = await db.query<any>(
      'SELECT fee_direct_discount_percent FROM plan_snapshot_beneficiaries WHERE plan_snapshot_id = ?', [a.snapshotId]);
    expect(rows.every((r: any) => r.fee_direct_discount_percent == null)).toBe(true);

    const fam = await assignment('per_family');
    const famRes = await request.put(`/user-memberships/${fam.umId}/fee-benefit`).set(headers())
      .send({ member_discounts: [{ member_id: fam.owner, percent: 10 }] });
    expect(famRes.status).toBe(400);
  });

  it('is tenant-isolated and requires authentication', async () => {
    const a = await assignment('per_member');
    const cross = await request.put(`/user-memberships/${a.umId}/fee-benefit`).set(headers(otherGymId))
      .send({ member_discounts: [{ member_id: a.owner, percent: 10 }] });
    expect([403, 404]).toContain(cross.status);
    const anon = await request.put(`/user-memberships/${a.umId}/fee-benefit`)
      .send({ member_discounts: [{ member_id: a.owner, percent: 10 }] });
    expect(anon.status).toBe(401);
  });
});
