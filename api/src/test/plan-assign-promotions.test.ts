// #2809 — Assign Plan to Member(s) applies only the Promotions staff select.
//
// `POST /membership-plans/:id/assign` used to apply every Promotion targeting
// the Plan. It now takes `promotion_ids` (none when omitted), validated as a set
// by `validatePromotionSelection()` before the Draft is created, and
// `GET /promotions?for_member_id=` reports which of them the owner may take.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, snapshotTestAssignment, legacyChildQuery } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function createPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'staff_only', '1')`,
    [gymId, `Promo Assign Plan ${uniq()}`],
  );
  return insertId;
}

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Promo Assign Member', `pa-${uniq()}@test.com`],
  );
  return insertId;
}

async function createPromo(
  gymId: string, planId: number, opts: { stackable?: boolean; newOnly?: boolean } = {},
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                            only_applicable_for_new_members)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', ?, ?)`,
    [gymId, `Promo ${uniq()}`, opts.stackable === false ? 0 : 1, opts.newOnly ? 1 : 0],
  );
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, insertId, planId],
  );
  return insertId;
}

function assign(gymId: string, planId: number, memberId: number, extra: Record<string, unknown> = {}) {
  return request
    .post(`/membership-plans/${planId}/assign`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-12-01', ...extra });
}

async function appliedPromotionIds(userMembershipId: number): Promise<number[]> {
  const { rows } = await legacyChildQuery(
    `SELECT promotion_id FROM user_membership_promotions
     WHERE user_membership_id = ? AND status = 'applied' ORDER BY promotion_id`,
    [userMembershipId],
  );
  return rows.map((r: any) => Number(r.promotion_id));
}

async function assignmentCount(gymId: string, memberId: number): Promise<number> {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS n FROM user_memberships WHERE gym_id = ? AND member_id = ?',
    [gymId, memberId],
  );
  return Number(rows[0].n);
}

describe('POST /membership-plans/:id/assign — manual Promotion selection (#2809)', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Plan Assign Promotions Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('applies no Promotion when none is selected, even with eligible ones targeting the Plan', async () => {
    const planId = await createPlan(gymId);
    await createPromo(gymId, planId);
    await createPromo(gymId, planId);
    const memberId = await createMember(gymId);

    const res = await assign(gymId, planId, memberId);
    expect(res.status).toBe(201);
    expect(res.body.applied_promotion_ids).toEqual([]);
    expect(await appliedPromotionIds(res.body.id)).toEqual([]);
  });

  it('applies exactly the selected Promotions', async () => {
    const planId = await createPlan(gymId);
    const a = await createPromo(gymId, planId);
    await createPromo(gymId, planId);
    const c = await createPromo(gymId, planId);
    const memberId = await createMember(gymId);

    const res = await assign(gymId, planId, memberId, { promotion_ids: [a, c] });
    expect(res.status).toBe(201);
    expect(await appliedPromotionIds(res.body.id)).toEqual([a, c].sort((x, y) => x - y));
  });

  it('refuses an incompatible combination and creates nothing', async () => {
    const planId = await createPlan(gymId);
    const solo = await createPromo(gymId, planId, { stackable: false });
    const other = await createPromo(gymId, planId);
    const memberId = await createMember(gymId);

    const res = await assign(gymId, planId, memberId, { promotion_ids: [solo, other] });
    expect(res.status).toBe(400);
    expect(await assignmentCount(gymId, memberId)).toBe(0);
  });

  it('refuses a new-members-only Promotion for an owner who is not a new member', async () => {
    const planId = await createPlan(gymId);
    const newOnly = await createPromo(gymId, planId, { newOnly: true });
    const memberId = await createMember(gymId);
    const { insertId: liveId } = await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at)
       VALUES (?, ?, ?, 'active', CURDATE())`,
      [gymId, memberId, planId],
    );
    await snapshotTestAssignment(Number(liveId));

    const res = await assign(gymId, planId, memberId, { promotion_ids: [newOnly] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/new members/);
    expect(await assignmentCount(gymId, memberId)).toBe(1);
  });

  it('applies a new-members-only Promotion for a new member', async () => {
    const planId = await createPlan(gymId);
    const newOnly = await createPromo(gymId, planId, { newOnly: true });
    const memberId = await createMember(gymId);

    const res = await assign(gymId, planId, memberId, { promotion_ids: [newOnly] });
    expect(res.status).toBe(201);
    expect(await appliedPromotionIds(res.body.id)).toEqual([newOnly]);
  });

  it('refuses a Promotion that does not target the Plan, and a malformed list', async () => {
    const planId = await createPlan(gymId);
    const otherPlan = await createPlan(gymId);
    const foreign = await createPromo(gymId, otherPlan);
    const memberId = await createMember(gymId);

    expect((await assign(gymId, planId, memberId, { promotion_ids: [foreign] })).status).toBe(400);
    expect((await assign(gymId, planId, memberId, { promotion_ids: 'all' })).status).toBe(400);
    expect(await assignmentCount(gymId, memberId)).toBe(0);
  });

  it('refuses another gym\'s Promotion', async () => {
    const otherGym = await createTestGym('Plan Assign Promotions Other Gym');
    const otherPlan = await createPlan(otherGym);
    const foreign = await createPromo(otherGym, otherPlan);
    const planId = await createPlan(gymId);
    const memberId = await createMember(gymId);

    const res = await assign(gymId, planId, memberId, { promotion_ids: [foreign] });
    expect(res.status).toBe(404);
    expect(await assignmentCount(gymId, memberId)).toBe(0);
  });
});

describe('GET /promotions?for_member_id= (#2809)', () => {
  let gymId: string;
  let planId: number;
  let open: number;
  let newOnly: number;

  beforeAll(async () => {
    gymId = await createTestGym('Promotions For Member Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId);
    open = await createPromo(gymId, planId);
    newOnly = await createPromo(gymId, planId, { newOnly: true });
  });

  function list(memberId: number | string, gym = gymId) {
    return request
      .get(`/promotions?membership_plan_id=${planId}&for_member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gym);
  }

  it('reports every targeting Promotion as eligible for a new member', async () => {
    const memberId = await createMember(gymId);
    const res = await list(memberId);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.map((p: any) => [p.id, p]));
    expect((byId.get(open) as any).member_eligible).toBe(true);
    expect((byId.get(newOnly) as any).member_eligible).toBe(true);
  });

  it('marks a new-members-only Promotion ineligible, with its reason, for a current member', async () => {
    const memberId = await createMember(gymId);
    const { insertId: liveId } = await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at)
       VALUES (?, ?, ?, 'active', CURDATE())`,
      [gymId, memberId, planId],
    );
    await snapshotTestAssignment(Number(liveId));
    const res = await list(memberId);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.map((p: any) => [p.id, p]));
    expect(byId.get(open)).toMatchObject({ member_eligible: true, ineligible_reason: null });
    expect(byId.get(newOnly)).toMatchObject({ member_eligible: false, ineligible_reason: 'new_members_only' });
  });

  it('answers 404 for another gym\'s Member and 400 for a malformed id', async () => {
    const otherGym = await createTestGym('Promotions For Member Other Gym');
    const foreignMember = await createMember(otherGym);
    expect((await list(foreignMember)).status).toBe(404);
    expect((await list('abc')).status).toBe(400);
  });

  it('leaves the list unchanged without the parameter', async () => {
    const res = await request
      .get(`/promotions?membership_plan_id=${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body[0]).not.toHaveProperty('member_eligible');
  });
});
