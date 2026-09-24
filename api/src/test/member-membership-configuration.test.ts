// Tests for member-membership-configuration.ts router
//
// #634 (stage 3) — GET /user-memberships/member/:memberId/configuration, the
// Member's MEMBERSHIP PLANS / PROMOTIONS / ADDITIONAL SERVICES sections read in
// one call. Mounted in app.ts behind requireAuth + tenantContext +
// requireModuleAccess('PAYMENTS') + requireFeatureEnabled('payments.transactions').
//
// The route is read-only, so every fixture is inserted directly with db.query
// and the HTTP API is only used for the GET under test. That is also the only
// way to seed the cases the write routes refuse: a service or a promotion on a
// cancelled Assigned Plan, and a revoked promotion row.
//
// The central invariant here is migration 172
// (172_multiple_active_membership_plans.js): a Member may hold several active
// Assigned Plans at once as long as they are on different Membership Plans, and
// all of them must come back as live.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const byNumber = (a: number, b: number) => a - b;

/**
 * The router normalizes `starts_at` / `ends_at` / `next_billing_date` to plain
 * YYYY-MM-DD, like the `services` rows, so one payload never mixes bare dates
 * with timestamps. This slice keeps the assertions correct either way.
 */
function dateOnly(v: unknown): string | null {
  return v == null ? null : String(v).slice(0, 10);
}

const getConfiguration = (gymId: string, memberId: number | string) =>
  request
    .get(`/user-memberships/member/${memberId}/configuration`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);

async function createMember(gymId: string, name = 'MMC Member'): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `mmc-${uniq()}@test.com`],
  );
  return insertId;
}

/** membership_plans has a UNIQUE (gym_id, name), so names are unique per gym. */
async function createPlan(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, name],
  );
  return insertId;
}

type AssignmentStatus =
  | 'draft' | 'awaiting_payment' | 'active' | 'paused' | 'cancelled' | 'expired';

async function createAssignment(
  gymId: string,
  memberId: number,
  planId: number,
  opts: {
    status?: AssignmentStatus;
    startsAt?: string;
    endsAt?: string | null;
    finalPrice?: number;
    nextBillingDate?: string | null;
  } = {},
): Promise<number> {
  const {
    status = 'active',
    startsAt = '2026-03-01',
    endsAt = null,
    finalPrice = 40,
    nextBillingDate = null,
  } = opts;
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, ends_at,
        base_price, final_price, next_billing_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [gymId, memberId, planId, status, startsAt, endsAt, finalPrice, finalPrice, nextBillingDate],
  );
  return insertId;
}

/** A recurring Sellable Item — the shape #631 allows as a periodic service. */
async function createSellableItem(
  gymId: string, name: string, amount = 20, billingFrequency = 'month',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_charges
       (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, 'service', ?, 'EUR', ?, 'active', 'available', 0)`,
    [gymId, name, amount, billingFrequency],
  );
  return insertId;
}

async function attachService(
  gymId: string,
  umId: number,
  chargeId: number,
  opts: { quantity?: number; startsAt?: string; endsAt?: string | null } = {},
): Promise<number> {
  const { quantity = 1, startsAt = '2026-03-01', endsAt = null } = opts;
  const { insertId } = await db.query(
    `INSERT INTO user_membership_services
       (gym_id, user_membership_id, gym_charge_id, quantity, starts_at, ends_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [gymId, umId, chargeId, quantity, startsAt, endsAt],
  );
  return insertId;
}

async function createPromotion(gymId: string, planId: number, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                            only_applicable_for_new_members)
     VALUES (?, ?, '2026-01-01 00:00:00', '2099-12-31 00:00:00', 'active', 1, 0)`,
    [gymId, name],
  );
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, insertId, planId],
  );
  return insertId;
}

/**
 * Applied directly rather than through POST /user-memberships/:id/promotions so
 * a fixture can pin `applied_at` (the API always stamps now) and can seed the
 * 'revoked' rows the API only produces via DELETE.
 */
async function applyPromotion(
  gymId: string,
  umId: number,
  promoId: number,
  opts: { status?: 'applied' | 'revoked'; appliedAt?: string; revokedAt?: string | null } = {},
): Promise<number> {
  const { status = 'applied', appliedAt = '2026-03-01 10:00:00', revokedAt = null } = opts;
  const { insertId } = await db.query(
    `INSERT INTO user_membership_promotions
       (gym_id, user_membership_id, promotion_id, applied_by, status, applied_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [gymId, umId, promoId, TEST_USER_ID, status, appliedAt, revokedAt],
  );
  return insertId;
}

// ─── Auth + module permissions ────────────────────────────────────────────────

describe('GET /user-memberships/member/:memberId/configuration — auth', () => {
  let gymId: string;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MMC Auth Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request
      .get(`/user-memberships/member/${memberId}/configuration`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a role with NONE access to PAYMENTS', async () => {
    const noAccessGym = await createTestGym('MMC No Access Gym');
    await createTestMembership(noAccessGym, 'trainer_performance');
    const noAccessMember = await createMember(noAccessGym);

    const res = await getConfiguration(noAccessGym, noAccessMember);
    expect(res.status).toBe(403);
  });

  it('allows a read-only role (accountant) to read the configuration', async () => {
    const readOnlyGym = await createTestGym('MMC Read Only Gym');
    await createTestMembership(readOnlyGym, 'accountant');
    const readOnlyMember = await createMember(readOnlyGym);

    const res = await getConfiguration(readOnlyGym, readOnlyMember);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ plans: [], promotions: [], services: [] });
  });
});

// ─── Member resolution + tenant isolation ─────────────────────────────────────

describe('GET /user-memberships/member/:memberId/configuration — member resolution', () => {
  let gymA: string;
  let gymB: string;
  let memberA: number;
  let assignmentA: number;

  beforeAll(async () => {
    gymA = await createTestGym('MMC Tenant Gym A');
    await createTestMembership(gymA, 'admin');
    gymB = await createTestGym('MMC Tenant Gym B');
    await createTestMembership(gymB, 'admin');

    memberA = await createMember(gymA);
    const planA = await createPlan(gymA, 'Tenant Standard');
    assignmentA = await createAssignment(gymA, memberA, planA);
  });

  it('returns 400 for a memberId that is not a positive integer', async () => {
    for (const bad of ['abc', '0', '-3', '1.5']) {
      const res = await getConfiguration(gymA, bad);
      expect(res.status).toBe(400);
    }
  });

  it('returns 404 for a member id that does not exist', async () => {
    const res = await getConfiguration(gymA, 99999999);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a soft-deleted member', async () => {
    const deletedMember = await createMember(gymA);
    await db.query('UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [deletedMember]);

    const res = await getConfiguration(gymA, deletedMember);
    expect(res.status).toBe(404);
  });

  it("returns 404 reading gym A's member with gym B's x-gym-id, and 200 with gym A's", async () => {
    const isolated = await getConfiguration(gymB, memberA);
    expect(isolated.status).toBe(404);
    expect(isolated.body.plans).toBeUndefined();

    const own = await getConfiguration(gymA, memberA);
    expect(own.status).toBe(200);
    expect(own.body.plans.map((p: any) => p.id)).toEqual([assignmentA]);
  });
});

// ─── Happy path: shape of the three sections ──────────────────────────────────

describe('GET /user-memberships/member/:memberId/configuration — happy path', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('MMC Shape Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns three empty sections for a member with no assignments', async () => {
    const memberId = await createMember(gymId);
    const res = await getConfiguration(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ plans: [], promotions: [], services: [] });
  });

  it('returns the plan, its promotions and its services', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, 'Shape Standard');
    const umId = await createAssignment(gymId, memberId, planId, {
      status: 'active',
      startsAt: '2026-03-01',
      finalPrice: 49.5,
      nextBillingDate: '2026-04-01',
    });

    const promoId = await createPromotion(gymId, planId, `Shape Spring ${uniq()}`);
    await applyPromotion(gymId, umId, promoId);

    const itemId = await createSellableItem(gymId, `Locker Rental ${uniq()}`, 12.5);
    const serviceId = await attachService(gymId, umId, itemId, { quantity: 2, startsAt: '2026-03-01' });

    const res = await getConfiguration(gymId, memberId);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['plans', 'promotions', 'services']);

    // ── MEMBERSHIP PLANS ──
    expect(res.body.plans).toHaveLength(1);
    const plan = res.body.plans[0];
    expect(plan).toMatchObject({
      id: umId,
      membership_plan_id: planId,
      plan_name: 'Shape Standard',
      status: 'active',
      is_live: true,
    });
    expect(Number(plan.final_price)).toBe(49.5);
    expect(dateOnly(plan.starts_at)).toBe('2026-03-01');
    expect(plan.ends_at).toBeNull();
    expect(dateOnly(plan.next_billing_date)).toBe('2026-04-01');

    // #635 stage 4: Included Services are retired (migration 177) — the card no
    // longer reports the Plan's activity allowances.
    expect(plan.activity_allowances).toBeUndefined();

    // ── PROMOTIONS (Member level, each row carrying its Assigned Plan) ──
    expect(res.body.promotions).toHaveLength(1);
    expect(res.body.promotions[0]).toMatchObject({
      user_membership_id: umId,
      plan_name: 'Shape Standard',
      promotion_id: promoId,
      status: 'applied',
    });
    expect(String(res.body.promotions[0].promotion_name)).toContain('Shape Spring');

    // ── ADDITIONAL SERVICES (Member level, same carrying rule) ──
    expect(res.body.services).toHaveLength(1);
    expect(res.body.services[0]).toMatchObject({
      id: serviceId,
      user_membership_id: umId,
      plan_name: 'Shape Standard',
      gym_charge_id: itemId,
      quantity: 2,
      billing_frequency: 'month',
      currency: 'EUR',
      active: true,
      sellable_item_retired: false,
    });
    expect(Number(res.body.services[0].unit_price)).toBe(12.5);
  });

  it("does not leak another member's plans, promotions or services", async () => {
    const mine = await createMember(gymId, 'MMC Mine');
    const theirs = await createMember(gymId, 'MMC Theirs');
    const planId = await createPlan(gymId, 'Shape Shared Plan');

    const theirUm = await createAssignment(gymId, theirs, planId);
    const itemId = await createSellableItem(gymId, `Shape Other Item ${uniq()}`);
    await attachService(gymId, theirUm, itemId);

    const res = await getConfiguration(gymId, mine);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ plans: [], promotions: [], services: [] });
  });
});

// ─── Two simultaneously active plans (#634 §6 / migration 172) ────────────────

describe('GET /user-memberships/member/:memberId/configuration — parallel active plans', () => {
  let gymId: string;
  let memberId: number;
  let standardPlan: number;
  let premiumPlan: number;
  let standardUm: number;
  let premiumUm: number;
  let standardPromo: number;
  let premiumPromo: number;
  let standardService: number;
  let premiumService: number;

  beforeAll(async () => {
    gymId = await createTestGym('MMC Parallel Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);

    standardPlan = await createPlan(gymId, 'Parallel Standard');
    premiumPlan = await createPlan(gymId, 'Parallel Premium');

    // Both 'active' at the same time: only possible since migration 172 narrowed
    // `user_memberships_one_active` to (active_member_key, membership_plan_id).
    standardUm = await createAssignment(gymId, memberId, standardPlan, {
      status: 'active', startsAt: '2026-03-01', finalPrice: 75,
    });
    premiumUm = await createAssignment(gymId, memberId, premiumPlan, {
      status: 'active', startsAt: '2026-05-01', finalPrice: 100,
    });

    standardPromo = await createPromotion(gymId, standardPlan, `Parallel Standard Promo ${uniq()}`);
    premiumPromo = await createPromotion(gymId, premiumPlan, `Parallel Premium Promo ${uniq()}`);
    await applyPromotion(gymId, standardUm, standardPromo, { appliedAt: '2026-03-01 09:00:00' });
    await applyPromotion(gymId, premiumUm, premiumPromo, { appliedAt: '2026-05-01 09:00:00' });

    const towels = await createSellableItem(gymId, `Parallel Towels ${uniq()}`, 10);
    const locker = await createSellableItem(gymId, `Parallel Locker ${uniq()}`, 15);
    standardService = await attachService(gymId, standardUm, towels, { startsAt: '2026-03-01' });
    premiumService = await attachService(gymId, premiumUm, locker, { startsAt: '2026-05-01' });
  });

  it('keeps both active rows in the database (migration 172)', async () => {
    const { rows } = await db.query(
      "SELECT id FROM user_memberships WHERE gym_id = ? AND member_id = ? AND status = 'active'",
      [gymId, memberId],
    );
    expect(rows.map((r: any) => r.id).sort(byNumber)).toEqual([standardUm, premiumUm].sort(byNumber));
  });

  it('still rejects a second active assignment on the same Membership Plan', async () => {
    await expect(
      createAssignment(gymId, memberId, standardPlan, { status: 'active', startsAt: '2026-06-01' }),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it('returns both plans as live, newest starts_at first', async () => {
    const res = await getConfiguration(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(2);
    expect(res.body.plans.map((p: any) => p.id)).toEqual([premiumUm, standardUm]);
    expect(res.body.plans.map((p: any) => p.plan_name)).toEqual([
      'Parallel Premium', 'Parallel Standard',
    ]);
    expect(res.body.plans.map((p: any) => p.is_live)).toEqual([true, true]);
    expect(res.body.plans.map((p: any) => Number(p.final_price))).toEqual([100, 75]);
  });

  it('lists the promotions of both plans, each carrying its Assigned Plan', async () => {
    const res = await getConfiguration(gymId, memberId);
    expect(res.body.promotions).toHaveLength(2);

    const byUm = new Map(res.body.promotions.map((p: any) => [p.user_membership_id, p]));
    expect(byUm.get(standardUm)).toMatchObject({
      promotion_id: standardPromo, plan_name: 'Parallel Standard', status: 'applied',
    });
    expect(byUm.get(premiumUm)).toMatchObject({
      promotion_id: premiumPromo, plan_name: 'Parallel Premium', status: 'applied',
    });
  });

  it('lists the services of both plans, each carrying its Assigned Plan', async () => {
    const res = await getConfiguration(gymId, memberId);
    expect(res.body.services).toHaveLength(2);

    const byId = new Map(res.body.services.map((s: any) => [s.id, s]));
    expect(byId.get(standardService)).toMatchObject({
      user_membership_id: standardUm, plan_name: 'Parallel Standard',
    });
    expect(byId.get(premiumService)).toMatchObject({
      user_membership_id: premiumUm, plan_name: 'Parallel Premium',
    });
  });
});

// ─── Live vs. historical assignments ──────────────────────────────────────────

describe('GET /user-memberships/member/:memberId/configuration — is_live', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('MMC History Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('marks draft, awaiting_payment, active and paused assignments as live', async () => {
    const memberId = await createMember(gymId);
    const statuses: AssignmentStatus[] = ['draft', 'awaiting_payment', 'active', 'paused'];
    const ids: number[] = [];
    for (const [i, status] of statuses.entries()) {
      const planId = await createPlan(gymId, `Live ${status} ${uniq()}`);
      ids.push(await createAssignment(gymId, memberId, planId, {
        status, startsAt: `2026-0${i + 1}-01`,
      }));
    }

    const res = await getConfiguration(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(4);
    expect(res.body.plans.every((p: any) => p.is_live === true)).toBe(true);
    expect(res.body.plans.map((p: any) => p.id).sort(byNumber)).toEqual([...ids].sort(byNumber));
  });

  it('keeps a cancelled and an expired assignment in plans with is_live false', async () => {
    const memberId = await createMember(gymId);
    const livePlan = await createPlan(gymId, `History Live ${uniq()}`);
    const cancelledPlan = await createPlan(gymId, `History Cancelled ${uniq()}`);
    const expiredPlan = await createPlan(gymId, `History Expired ${uniq()}`);

    const liveUm = await createAssignment(gymId, memberId, livePlan, {
      status: 'active', startsAt: '2026-06-01',
    });
    const cancelledUm = await createAssignment(gymId, memberId, cancelledPlan, {
      status: 'cancelled', startsAt: '2026-02-01', endsAt: '2026-05-31',
    });
    const expiredUm = await createAssignment(gymId, memberId, expiredPlan, {
      status: 'expired', startsAt: '2026-01-01', endsAt: '2026-01-31',
    });

    const res = await getConfiguration(gymId, memberId);
    expect(res.status).toBe(200);
    // Full history, newest starts_at first.
    expect(res.body.plans.map((p: any) => p.id)).toEqual([liveUm, cancelledUm, expiredUm]);
    expect(res.body.plans.map((p: any) => p.is_live)).toEqual([true, false, false]);
    expect(dateOnly(res.body.plans[1].ends_at)).toBe('2026-05-31');
  });

  it('excludes the promotions and services of cancelled and expired assignments', async () => {
    const memberId = await createMember(gymId);
    const livePlan = await createPlan(gymId, `Excluded Live ${uniq()}`);
    const deadPlan = await createPlan(gymId, `Excluded Dead ${uniq()}`);

    const liveUm = await createAssignment(gymId, memberId, livePlan, {
      status: 'active', startsAt: '2026-06-01',
    });
    const deadUm = await createAssignment(gymId, memberId, deadPlan, {
      status: 'cancelled', startsAt: '2026-01-01', endsAt: '2026-05-31',
    });

    const livePromo = await createPromotion(gymId, livePlan, `Excluded Live Promo ${uniq()}`);
    const deadPromo = await createPromotion(gymId, deadPlan, `Excluded Dead Promo ${uniq()}`);
    await applyPromotion(gymId, liveUm, livePromo);
    await applyPromotion(gymId, deadUm, deadPromo);

    const liveItem = await createSellableItem(gymId, `Excluded Live Item ${uniq()}`);
    const deadItem = await createSellableItem(gymId, `Excluded Dead Item ${uniq()}`);
    const liveService = await attachService(gymId, liveUm, liveItem, { startsAt: '2026-06-01' });
    await attachService(gymId, deadUm, deadItem, { startsAt: '2026-01-01', endsAt: '2026-05-31' });

    const res = await getConfiguration(gymId, memberId);
    expect(res.status).toBe(200);
    // Both plans are still listed …
    expect(res.body.plans.map((p: any) => p.id)).toEqual([liveUm, deadUm]);
    // … but only the live one contributes promotions and services.
    expect(res.body.promotions.map((p: any) => p.user_membership_id)).toEqual([liveUm]);
    expect(res.body.promotions[0].promotion_id).toBe(livePromo);
    expect(res.body.services.map((s: any) => s.id)).toEqual([liveService]);
    expect(res.body.services[0].user_membership_id).toBe(liveUm);
  });
});

// ─── PROMOTIONS section details (#634 §13) ────────────────────────────────────

describe('GET /user-memberships/member/:memberId/configuration — promotions section', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('MMC Promotions Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('lists revoked promotions alongside applied ones', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Promo Revoked Plan ${uniq()}`);
    const umId = await createAssignment(gymId, memberId, planId, { startsAt: '2026-03-01' });

    const appliedPromo = await createPromotion(gymId, planId, `Promo Applied ${uniq()}`);
    const revokedPromo = await createPromotion(gymId, planId, `Promo Revoked ${uniq()}`);
    await applyPromotion(gymId, umId, appliedPromo, { appliedAt: '2026-03-10 10:00:00' });
    await applyPromotion(gymId, umId, revokedPromo, {
      status: 'revoked', appliedAt: '2026-03-01 10:00:00', revokedAt: '2026-03-20 10:00:00',
    });

    const res = await getConfiguration(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body.promotions).toHaveLength(2);

    const byPromo = new Map(res.body.promotions.map((p: any) => [p.promotion_id, p]));
    expect(byPromo.get(appliedPromo)).toMatchObject({ status: 'applied', user_membership_id: umId });
    expect(byPromo.get(revokedPromo)).toMatchObject({ status: 'revoked', user_membership_id: umId });
    expect((byPromo.get(revokedPromo) as any).revoked_at).not.toBeNull();
  });

  it('orders a plan\'s promotions newest applied_at first', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Promo Order Plan ${uniq()}`);
    const umId = await createAssignment(gymId, memberId, planId, { startsAt: '2026-03-01' });

    const older = await createPromotion(gymId, planId, `Promo Older ${uniq()}`);
    const newer = await createPromotion(gymId, planId, `Promo Newer ${uniq()}`);
    // Inserted oldest-first on purpose — the order must come from applied_at.
    await applyPromotion(gymId, umId, older, { appliedAt: '2026-03-01 08:00:00' });
    await applyPromotion(gymId, umId, newer, { appliedAt: '2026-04-01 08:00:00' });

    const res = await getConfiguration(gymId, memberId);
    expect(res.body.promotions.map((p: any) => p.promotion_id)).toEqual([newer, older]);
  });

  it('returns an empty promotions section for a live plan with none applied', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Promo None Plan ${uniq()}`);
    await createAssignment(gymId, memberId, planId);

    const res = await getConfiguration(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.promotions).toEqual([]);
  });
});

// ─── new_member_eligible (#634 §3) ────────────────────────────────────────────
//
// Whether a Promotion flagged "Only applicable for new members" would be
// accepted on each plan. It is a property of the Member, reported per Assigned
// Plan because the plan a Promotion is attached to never counts against its own
// Member — so a Member's first plan and their second differ. The rule's window
// arithmetic is unit-tested in new-member-eligibility.test.ts; the apply paths
// enforce it in membership-promotions.test.ts. Here: that the read agrees.

describe('GET /user-memberships/member/:memberId/configuration — new_member_eligible', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('MMC New Member Gym');
    await createTestMembership(gymId, 'admin');
  });

  const eligibilityById = (body: any) =>
    new Map<number, boolean>(body.plans.map((p: any) => [p.id, p.new_member_eligible]));

  it("is true for a Member's only Membership Plan", async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `NME Only Plan ${uniq()}`);
    const umId = await createAssignment(gymId, memberId, planId, { startsAt: '2026-03-01' });

    const res = await getConfiguration(gymId, memberId);
    expect(res.status).toBe(200);
    expect(eligibilityById(res.body).get(umId)).toBe(true);
  });

  it('is false for both of a Member\'s two parallel plans', async () => {
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, `NME Parallel A ${uniq()}`);
    const second = await createPlan(gymId, `NME Parallel B ${uniq()}`);
    const firstUm = await createAssignment(gymId, memberId, first, { startsAt: '2026-03-01' });
    const secondUm = await createAssignment(gymId, memberId, second, { startsAt: '2026-05-01' });

    const eligibility = eligibilityById((await getConfiguration(gymId, memberId)).body);
    expect(eligibility.get(firstUm)).toBe(false);
    expect(eligibility.get(secondUm)).toBe(false);
  });

  it('is true again for a Member coming back after more than 12 months away', async () => {
    const memberId = await createMember(gymId);
    const oldPlan = await createPlan(gymId, `NME Lapsed ${uniq()}`);
    const newPlan = await createPlan(gymId, `NME Returning ${uniq()}`);
    await createAssignment(gymId, memberId, oldPlan, {
      status: 'expired', startsAt: '2022-01-01', endsAt: '2023-01-01',
    });
    const returningUm = await createAssignment(gymId, memberId, newPlan, { startsAt: '2026-09-01' });

    const eligibility = eligibilityById((await getConfiguration(gymId, memberId)).body);
    expect(eligibility.get(returningUm)).toBe(true);
  });

  it('is false when the previous plan ended inside the last 12 months', async () => {
    const memberId = await createMember(gymId);
    const oldPlan = await createPlan(gymId, `NME Recent Lapse ${uniq()}`);
    const newPlan = await createPlan(gymId, `NME Rejoin ${uniq()}`);
    const lapsedUm = await createAssignment(gymId, memberId, oldPlan, {
      status: 'expired', startsAt: '2022-01-01',
    });
    await db.query(
      'UPDATE user_memberships SET ends_at = CURDATE() - INTERVAL 3 MONTH, created_at = ? WHERE id = ?',
      ['2022-01-01 09:00:00', lapsedUm],
    );
    const rejoinUm = await createAssignment(gymId, memberId, newPlan, { startsAt: '2026-09-01' });

    const eligibility = eligibilityById((await getConfiguration(gymId, memberId)).body);
    expect(eligibility.get(rejoinUm)).toBe(false);
  });
});
