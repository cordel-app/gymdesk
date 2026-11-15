// #2853 — a Draft assigned plan's Promotions are chosen after assignment from
// the live `promotions` catalogue: the card asks whether the Draft takes
// Promotions (`promotions_selectable`), reads the offered ones from
// `GET /promotions?…&for_member_id=&for_user_membership_id=`, and selects /
// deselects through the existing apply and revoke routes. Integration against
// the real stack, since every rule is the server's.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestDraftAssignment,
  createTestGym, createTestMembership, request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let gymId: string;
let otherGymId: string;
let planId: number;
let promoA: number;
let promoB: number;
let newMembersOnly: number;
let nonStackable: number;

async function createMember(name: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `dpp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return Number(insertId);
}

async function createPromo(name: string, opts: { stackable?: boolean; newMembersOnly?: boolean; percent?: number } = {}) {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                             only_applicable_for_new_members, paid_months)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', ?, ?, 12)`,
    [gymId, name, opts.stackable === false ? 0 : 1, opts.newMembersOnly ? 1 : 0],
  );
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, insertId, planId],
  );
  await db.query(
    `INSERT INTO promotion_membership_fee_benefits (gym_id, promotion_id, duration_months, enabled, action, value)
     VALUES (?, ?, NULL, 1, 'percentage_discount', ?)`,
    [gymId, insertId, opts.percent ?? 10],
  );
  return Number(insertId);
}

const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const detail = (umId: number) => auth(request.get(`/user-memberships/${umId}`));
const apply = (umId: number, promotionId: number) =>
  auth(request.post(`/user-memberships/${umId}/promotions`)).send({ promotion_id: promotionId });
const revoke = (umId: number, promotionId: number) =>
  auth(request.delete(`/user-memberships/${umId}/promotions/${promotionId}`));
const offered = (memberId: number, umId: number) => auth(request.get(
  `/promotions?lifecycle_status=active&active_on=${new Date().toISOString().slice(0, 10)}`
  + `&membership_plan_id=${planId}&for_member_id=${memberId}&for_user_membership_id=${umId}`,
));
const standingIds = (body: any) => body.promotions
  .filter((p: any) => p.status === 'applied')
  .map((p: any) => Number(p.promotion_id))
  .sort((a: number, b: number) => a - b);

beforeAll(async () => {
  gymId = await createTestGym('Draft Promotion Picker Gym');
  otherGymId = await createTestGym('Draft Promotion Picker Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, 'DPP Plan', 'active', 'staff_only')`,
    [gymId],
  );
  planId = Number(insertId);
  promoA = await createPromo('DPP Promo A', { percent: 10 });
  promoB = await createPromo('DPP Promo B', { percent: 20 });
  newMembersOnly = await createPromo('DPP New Members', { newMembersOnly: true });
  nonStackable = await createPromo('DPP Non Stackable', { stackable: false });
});

describe('Draft assigned plan: choosing Promotions after assignment (#2853)', () => {
  it('reports a Draft as taking Promotions, and a running plan as not', async () => {
    const memberId = await createMember('DPP Selectable');
    const umId = await createTestDraftAssignment(gymId, memberId, planId, { config: { base_price: 100 } });

    const onDraft = await detail(umId);
    expect(onDraft.status).toBe(200);
    expect(onDraft.body.promotions_selectable).toBe(true);

    await activateTestAssignment(gymId, umId);
    const onActive = await detail(umId);
    expect(onActive.body.promotions_selectable).toBe(false);
  });

  it('offers every active Promotion targeting the plan, from the promotions table', async () => {
    const memberId = await createMember('DPP Offered');
    const umId = await createTestDraftAssignment(gymId, memberId, planId, { config: { base_price: 100 } });

    const res = await offered(memberId, umId);
    expect(res.status).toBe(200);
    const ids = res.body.map((p: any) => Number(p.id));
    expect(ids).toEqual(expect.arrayContaining([promoA, promoB, newMembersOnly, nonStackable]));
    // A brand-new member may take an Only New Members Promotion on their own
    // Draft — judged excluding that Draft, as the apply path judges it.
    expect(res.body.find((p: any) => Number(p.id) === newMembersOnly).member_eligible).toBe(true);
    expect((await apply(umId, newMembersOnly)).status).toBe(201);
  });

  it('selects, deselects and changes the Draft Promotions, recalculating the fee', async () => {
    const memberId = await createMember('DPP Toggle');
    const umId = await createTestDraftAssignment(gymId, memberId, planId, { config: { base_price: 100 } });
    const before = (await detail(umId)).body.membership_fee;

    expect((await apply(umId, promoA)).status).toBe(201);
    expect((await apply(umId, promoB)).status).toBe(201);
    const both = (await detail(umId)).body;
    expect(standingIds(both)).toEqual([promoA, promoB].sort((a, b) => a - b));
    expect(Number(both.membership_fee)).toBeLessThan(Number(before));

    expect((await revoke(umId, promoA)).status).toBeLessThan(300);
    const one = (await detail(umId)).body;
    expect(standingIds(one)).toEqual([promoB]);
    expect(Number(one.membership_fee)).toBeGreaterThan(Number(both.membership_fee));

    // Re-selecting one deselected earlier applies it again (no duplicate).
    expect((await apply(umId, promoA)).status).toBe(201);
    expect(standingIds((await detail(umId)).body)).toEqual([promoA, promoB].sort((a, b) => a - b));
    expect((await apply(umId, promoA)).status).toBe(409);

    // Nothing about the catalogue Promotion moved.
    const { rows } = await db.query<any>('SELECT name, lifecycle_status FROM promotions WHERE id = ?', [promoA]);
    expect(rows[0]).toEqual({ name: 'DPP Promo A', lifecycle_status: 'active' });
  });

  it('keeps the compatibility rule: a non-stackable Promotion joins no other', async () => {
    const memberId = await createMember('DPP Stacking');
    const umId = await createTestDraftAssignment(gymId, memberId, planId, { config: { base_price: 100 } });
    expect((await apply(umId, promoA)).status).toBe(201);
    expect((await apply(umId, nonStackable)).status).toBe(409);
  });

  it('refuses a malformed assignment filter on the catalogue read', async () => {
    const memberId = await createMember('DPP Filter');
    const bad = await auth(request.get(`/promotions?for_member_id=${memberId}&for_user_membership_id=x`));
    expect(bad.status).toBe(400);
    const orphan = await auth(request.get('/promotions?for_user_membership_id=5'));
    expect(orphan.status).toBe(400);
  });

  it('does not reveal or apply to a Draft of another gym', async () => {
    const memberId = await createMember('DPP Isolation');
    const umId = await createTestDraftAssignment(gymId, memberId, planId, { config: { base_price: 100 } });
    expect((await auth(request.get(`/user-memberships/${umId}`), otherGymId)).status).toBe(404);
    const res = await auth(request.post(`/user-memberships/${umId}/promotions`), otherGymId)
      .send({ promotion_id: promoA });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(standingIds((await detail(umId)).body)).toEqual([]);
  });
});
