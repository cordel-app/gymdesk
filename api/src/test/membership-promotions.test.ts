// Tests for membership-promotions.ts (apply/revoke promotions on a
// user_membership) — in particular that the resolved Membership Fee correctly applies
// a Promotion's Membership Fee Benefit, including the `fixed_price` action
// added in #487 stage 2 (previously unimplemented) and the `duration_months`
// gate from #487 stage 3. Since #635 stage 5 that benefit is one row in
// `promotion_membership_fee_benefits` (migration 179); the two tables it used
// to be spread over — `promotion_charge_benefits` and
// `promotion_period_benefits` — are gone.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
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

async function getChargeTypeId(code: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM charge_types WHERE code = ?', [code]);
  return rows[0].id;
}

async function createGymCharge(gymId: string, chargeTypeId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_charges (gym_id, charge_type_id, amount, currency, billing_frequency, availability)
     VALUES (?, ?, 0, 'EUR', 'month', 'available')`,
    [gymId, chargeTypeId],
  );
  return insertId;
}

async function createPlan(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, name],
  );
  return insertId;
}

async function createMember(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
    [gymId, name, `mp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId;
}

async function createUserMembership(gymId: string, memberId: number, planId: number, basePrice: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', CURDATE(), ?)`,
    [gymId, memberId, planId, basePrice],
  );
  return insertId;
}

// `only_applicable_for_new_members` is explicit (and off by default here)
// because the column defaults to 1 in the schema (#633, migration 163) and,
// since #634 §3, that flag refuses the apply for a Member who held another
// Membership Plan in the trailing 12 months. Promotions that are not about
// that rule opt out; the rule's own tests below pass `newMembersOnly`.
// `paid_months` is set because a Membership Fee Benefit lives *inside* the
// Promotion's own Free/Paid/Bonus timeline and ends with it (#635 stage 12's
// answer (a), unconditional since stage 15): a Promotion configured with no
// months at all discounts nothing on any date, so a fixture that leaves them
// NULL would test the absence of a benefit rather than the action it carries.
// Twelve paid months put every case below comfortably inside the timeline.
async function createPromo(
  gymId: string, name: string, stackable = false, newMembersOnly = false, paidMonths = 12,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                             only_applicable_for_new_members, paid_months)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', ?, ?, ?)`,
    [gymId, name, stackable ? 1 : 0, newMembersOnly ? 1 : 0, paidMonths],
  );
  return insertId;
}

async function targetPlan(gymId: string, promoId: number, planId: number) {
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, promoId, planId],
  );
}

// #635 stage 5: one Membership Fee Benefit per Promotion, no item to point
// at. The PUT endpoint is covered in promotions.test.ts; these tests write
// the row directly, as the setup-by-SQL rule requires.
async function setMembershipFeeBenefit(
  gymId: string,
  promoId: number,
  action: string | null,
  value: number | null,
  opts: { durationMonths?: number | null; enabled?: boolean } = {},
) {
  const { durationMonths = null, enabled = true } = opts;
  await db.query(
    `INSERT INTO promotion_membership_fee_benefits
       (gym_id, promotion_id, quantity, frequency_interval, frequency_unit, duration_months, enabled, action, value)
     VALUES (?, ?, 1, 1, 'month', ?, ?, ?, ?)`,
    [gymId, promoId, durationMonths, enabled ? 1 : 0, action, value],
  );
}

async function backdateAppliedAt(umId: number, promoId: number, monthsAgo: number) {
  await db.query(
    `UPDATE user_membership_promotions SET applied_at = applied_at - INTERVAL ? MONTH
     WHERE user_membership_id = ? AND promotion_id = ?`,
    [monthsAgo, umId, promoId],
  );
}

// ─── Membership Fee Benefit actions applied to real billing ──────────────────

describe('POST /user-memberships/:id/promotions — membership fee benefit calc', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('MP Gym');
    await createTestMembership(gymId, 'admin');
  });

  async function applyAndGetFinalPrice(action: string, value: number | null, basePrice = 100) {
    const planId = await createPlan(gymId, `Plan-${action}-${Date.now()}`);
    const memberId = await createMember(gymId, `Member-${action}`);
    const umId = await createUserMembership(gymId, memberId, planId, basePrice);
    const promoId = await createPromo(gymId, `Promo-${action}-${Date.now()}`);
    await targetPlan(gymId, promoId, planId);
    await setMembershipFeeBenefit(gymId, promoId, action, value);

    const res = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ promotion_id: promoId });
    return res;
  }

  it('waive brings the membership fee to 0', async () => {
    const res = await applyAndGetFinalPrice('waive', null);
    expect(res.status).toBe(201);
    expect(Number(res.body.membership_fee)).toBe(0);
  });

  it('percentage_discount reduces the fee proportionally', async () => {
    const res = await applyAndGetFinalPrice('percentage_discount', 50);
    expect(res.status).toBe(201);
    expect(Number(res.body.membership_fee)).toBe(50);
  });

  it('fixed_discount subtracts a fixed amount', async () => {
    const res = await applyAndGetFinalPrice('fixed_discount', 20);
    expect(res.status).toBe(201);
    expect(Number(res.body.membership_fee)).toBe(80);
  });

  it('fixed_price replaces the fee with a specific price (#487 stage 2)', async () => {
    const res = await applyAndGetFinalPrice('fixed_price', 60);
    expect(res.status).toBe(201);
    expect(Number(res.body.membership_fee)).toBe(60);
  });

  it('fixed_price of 0 waives the fee entirely', async () => {
    const res = await applyAndGetFinalPrice('fixed_price', 0);
    expect(res.status).toBe(201);
    expect(Number(res.body.membership_fee)).toBe(0);
  });

  it('fixed_discount larger than the base price clamps at 0', async () => {
    const res = await applyAndGetFinalPrice('fixed_discount', 500);
    expect(res.status).toBe(201);
    expect(Number(res.body.membership_fee)).toBe(0);
  });
});

// ─── The duration_months gate applied to real billing (#487 stage 3) ─────────

describe('POST /user-memberships/:id/promotions — membership fee benefit duration', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('MP Period Gym');
    await createTestMembership(gymId, 'admin');
  });

  async function setup(basePrice = 100) {
    const planId = await createPlan(gymId, `PB-Plan-${Date.now()}-${Math.random()}`);
    const memberId = await createMember(gymId, `PB-Member-${Date.now()}`);
    const umId = await createUserMembership(gymId, memberId, planId, basePrice);
    const promoId = await createPromo(gymId, `PB-Promo-${Date.now()}-${Math.random()}`, true);
    await targetPlan(gymId, promoId, planId);
    return { umId, promoId };
  }

  async function apply(umId: number, promoId: number) {
    return request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ promotion_id: promoId });
  }

  it('a waive membership fee benefit zeroes the final price', async () => {
    const { umId, promoId } = await setup();
    await setMembershipFeeBenefit(gymId, promoId, 'waive', null);
    const res = await apply(umId, promoId);
    expect(res.status).toBe(201);
    expect(Number(res.body.membership_fee)).toBe(0);
  });

  it('a fixed_price benefit within its duration_months window applies', async () => {
    const { umId, promoId } = await setup();
    await setMembershipFeeBenefit(gymId, promoId, 'fixed_price', 60, { durationMonths: 3 });
    const res = await apply(umId, promoId);
    expect(res.status).toBe(201);
    expect(Number(res.body.membership_fee)).toBe(60);
  });

  // #635 stage 12 (answer (a)), unconditional since stage 15: a null
  // `duration_months` does not mean "for ever". The benefit still lives inside
  // the Promotion's own Free/Paid/Bonus timeline and ends with it — which is the
  // overcharge/undercharge the stored `final_price` could never express, because
  // it had no date in it and nothing re-ran once a promotional period elapsed.
  it('a null duration_months still ends with the Promotion timeline', async () => {
    const { umId, promoId } = await setup();
    await setMembershipFeeBenefit(gymId, promoId, 'fixed_discount', 20, { durationMonths: null });
    const applied = await apply(umId, promoId);
    expect(Number(applied.body.membership_fee)).toBe(80);
    // Ten years back: the Promotion's twelve paid months are long past, so the
    // next cycle is priced at the regular fee with no recompute of any kind.
    await backdateAppliedAt(umId, promoId, 120);
    const { promoId: promoId2 } = await setup();
    // re-target the same membership/plan for the trivial trigger promo
    await db.query('UPDATE promotion_membership_plans SET membership_plan_id = (SELECT membership_plan_id FROM user_memberships WHERE id = ?) WHERE promotion_id = ?', [umId, promoId2]);
    const res = await apply(umId, promoId2);
    expect(res.status).toBe(201);
    expect(Number(res.body.membership_fee)).toBe(100);
  });

  it('a benefit whose duration_months window has lapsed is excluded on the next recompute', async () => {
    const { umId, promoId } = await setup();
    await setMembershipFeeBenefit(gymId, promoId, 'waive', null, { durationMonths: 3 });
    const applied = await apply(umId, promoId);
    expect(Number(applied.body.membership_fee)).toBe(0);

    await backdateAppliedAt(umId, promoId, 6);

    // Trigger a fresh recompute via a second stackable promotion targeting
    // the same plan.
    const { promoId: promoId2 } = await setup();
    await db.query('UPDATE promotion_membership_plans SET membership_plan_id = (SELECT membership_plan_id FROM user_memberships WHERE id = ?) WHERE promotion_id = ?', [umId, promoId2]);
    const res = await apply(umId, promoId2);
    expect(res.status).toBe(201);
    expect(Number(res.body.membership_fee)).toBe(100);
  });

  it('a disabled benefit has no effect', async () => {
    const { umId, promoId } = await setup();
    await setMembershipFeeBenefit(gymId, promoId, 'waive', null, { enabled: false });
    const res = await apply(umId, promoId);
    expect(res.status).toBe(201);
    expect(Number(res.body.membership_fee)).toBe(100);
  });

  // #635 stage 5 replaced "a charge benefit and a period benefit on the same
  // promotion stack" — one Promotion now has at most one Membership Fee
  // Benefit, so stacking is a property of stacking *promotions*.
  it('two stacked promotions apply their membership fee benefits in turn', async () => {
    const { umId, promoId } = await setup();
    await setMembershipFeeBenefit(gymId, promoId, 'fixed_discount', 20);
    expect(Number((await apply(umId, promoId)).body.membership_fee)).toBe(80);

    const { promoId: promoId2 } = await setup();
    await setMembershipFeeBenefit(gymId, promoId2, 'percentage_discount', 50);
    await db.query(
      'UPDATE promotion_membership_plans SET membership_plan_id = (SELECT membership_plan_id FROM user_memberships WHERE id = ?) WHERE promotion_id = ?',
      [umId, promoId2],
    );
    const res = await apply(umId, promoId2);
    expect(res.status).toBe(201);
    // first promotion: 100 - 20 = 80, then the second: 80 * 0.5 = 40
    expect(Number(res.body.membership_fee)).toBe(40);
  });
});

// ─── Auth / tenant isolation ────────────────────────────────────────────────

// ─── Snapshot immutability (#511 stage 2) ──────────────────────────────────
// Applying a promotion now stores a point-in-time snapshot of its
// name/description/stackable/benefits (buildPromotionSnapshot). GET
// /user-memberships/:id/promotions must keep showing that snapshot for an
// already-applied row even after the promotion itself is later
// renamed/edited -- only a row with no snapshot (pre-#511 data) falls back
// to the live `promotions` join.

describe('GET /user-memberships/:id/promotions — snapshot immutability (#511 stage 2)', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('MP Snapshot Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('keeps promotion_name/description/stackable/membership_fee_benefits frozen after the promotion is later edited', async () => {
    const planId = await createPlan(gymId, `Snap-Plan-${Date.now()}`);
    const memberId = await createMember(gymId, 'Snap Member');
    const umId = await createUserMembership(gymId, memberId, planId, 100);
    const promoId = await createPromo(gymId, 'Original Promo Name', false);
    await db.query('UPDATE promotions SET description = ? WHERE id = ?', ['Original description', promoId]);
    await targetPlan(gymId, promoId, planId);
    await setMembershipFeeBenefit(gymId, promoId, 'fixed_discount', 10);

    const applyRes = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ promotion_id: promoId });
    expect(applyRes.status).toBe(201);

    // Confirm a snapshot was actually persisted at apply time.
    const { rows: snapRows } = await db.query(
      'SELECT snapshot FROM user_membership_promotions WHERE user_membership_id = ? AND promotion_id = ?',
      [umId, promoId],
    );
    expect(snapRows[0].snapshot).not.toBeNull();

    // Now edit the promotion's own definition -- rename it, change its
    // description, flip stackable, and swap its membership fee benefit's
    // action/value.
    await db.query(
      'UPDATE promotions SET name = ?, description = ?, stackable = 1 WHERE id = ?',
      ['Renamed Promo', 'New description', promoId],
    );
    await db.query(
      "UPDATE promotion_membership_fee_benefits SET action = 'fixed_price', value = 999 WHERE promotion_id = ?",
      [promoId],
    );

    const listRes = await request
      .get(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(listRes.status).toBe(200);
    const row = listRes.body.find((r: any) => r.promotion_id === promoId);
    expect(row).toBeDefined();

    // Still reflects what was granted at apply time, not the since-edited promotion.
    expect(row.promotion_name).toBe('Original Promo Name');
    expect(row.promotion_description).toBe('Original description');
    expect(Boolean(row.stackable)).toBe(false);
    expect(row.membership_fee_benefits).toHaveLength(1);
    expect(row.membership_fee_benefits[0].action).toBe('fixed_discount');
    expect(Number(row.membership_fee_benefits[0].value)).toBe(10);
    expect(row.charge_benefits).toBeUndefined();
    expect(row.period_benefits).toBeUndefined();
    expect(row.included_benefits).toBeUndefined();
  });

  it('falls back to a live join of the current promotion + benefits for a legacy row with no snapshot', async () => {
    const planId = await createPlan(gymId, `Legacy-Plan-${Date.now()}`);
    const memberId = await createMember(gymId, 'Legacy Member');
    const umId = await createUserMembership(gymId, memberId, planId, 100);
    const promoId = await createPromo(gymId, 'Legacy Promo Name', false);
    await targetPlan(gymId, promoId, planId);
    await setMembershipFeeBenefit(gymId, promoId, 'fixed_discount', 15);

    // Simulate a promotion applied before #511 stage 2 -- inserted directly
    // with snapshot = NULL, bypassing the router's buildPromotionSnapshot call.
    await db.query(
      "INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, applied_by, status, snapshot) VALUES (?, ?, ?, ?, 'applied', NULL)",
      [gymId, umId, promoId, 'legacy-actor'],
    );

    // Edit the promotion (and its membership fee benefit) after the fact -- a legacy
    // row has no snapshot to protect, so unlike the snapshotted case above,
    // it must reflect these live edits rather than what applied_at originally saw.
    await db.query('UPDATE promotions SET name = ? WHERE id = ?', ['Renamed Legacy Promo', promoId]);
    await db.query(
      "UPDATE promotion_membership_fee_benefits SET action = 'fixed_price', value = 42 WHERE promotion_id = ?",
      [promoId],
    );

    const listRes = await request
      .get(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(listRes.status).toBe(200);
    const row = listRes.body.find((r: any) => r.promotion_id === promoId);
    expect(row).toBeDefined();
    expect(row.promotion_name).toBe('Renamed Legacy Promo');
    expect(row.membership_fee_benefits).toHaveLength(1);
    expect(row.membership_fee_benefits[0].action).toBe('fixed_price');
    expect(Number(row.membership_fee_benefits[0].value)).toBe(42);
  });
});

describe('POST /user-memberships/:id/promotions — auth', () => {
  let gymId: string;
  let gymNoAccess: string;
  let planId: number;
  let memberId: number;
  let umId: number;
  let promoId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MP Auth Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, 'Auth Plan');
    memberId = await createMember(gymId, 'Auth Member');
    umId = await createUserMembership(gymId, memberId, planId, 100);
    promoId = await createPromo(gymId, 'Auth Promo');
    await targetPlan(gymId, promoId, planId);

    // trainer_performance has NONE access to the PAYMENTS module → 403 on any route
    gymNoAccess = await createTestGym('MP No Access Gym');
    await createTestMembership(gymNoAccess, 'trainer_performance');
  });

  it('401 without a token', async () => {
    const res = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('x-gym-id', gymId)
      .send({ promotion_id: promoId });
    expect(res.status).toBe(401);
  });

  it('404 for a membership in another gym', async () => {
    const otherGymId = await createTestGym('MP Other Gym');
    await createTestMembership(otherGymId, 'admin');
    const res = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId)
      .send({ promotion_id: promoId });
    expect(res.status).toBe(404);
  });

  it('403 when role has NONE access to the PAYMENTS module', async () => {
    const res = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoAccess)
      .send({ promotion_id: promoId });
    expect(res.status).toBe(403);
  });
});

// ─── "Only applicable for new members" (#634 §3) ──────────────────────────────
//
// "A member that books his/her first membership plan in 12 months. If a user
// was member of the gym 12 months ago and now is coming back, the flag only
// applicable to new users will apply." (issue thread)
//
// The window arithmetic itself is covered by the unit tests in
// new-member-eligibility.test.ts; these check that the rule actually gates the
// apply paths, and that the assignment being configured never disqualifies its
// own Member.

describe('POST /user-memberships/:id/promotions — new-members-only promotions', () => {
  let gymId: string;
  let planId: number;
  let otherPlanId: number;
  let promoId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MP New Member Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, 'NM Plan');
    otherPlanId = await createPlan(gymId, 'NM Other Plan');
    promoId = await createPromo(gymId, 'NM Promo', true, true);
    await targetPlan(gymId, promoId, planId);
  });

  const apply = (umId: number) =>
    request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ promotion_id: promoId });

  /** An assignment with explicit dates, so each case controls its own history. */
  async function createAssignment(
    memberId: number, membershipPlanId: number,
    opts: { status?: string; startsAt?: string; endsAt?: string | null; createdMonthsAgo?: number } = {},
  ): Promise<number> {
    const { status = 'active', startsAt = 'CURDATE()', endsAt = null, createdMonthsAgo = 0 } = opts;
    const { insertId } = await db.query(
      `INSERT INTO user_memberships
         (gym_id, member_id, membership_plan_id, status, starts_at, ends_at, base_price, created_at)
       VALUES (?, ?, ?, ?, ${startsAt}, ?, 100, UTC_TIMESTAMP() - INTERVAL ? MONTH)`,
      [gymId, memberId, membershipPlanId, status, endsAt, createdMonthsAgo],
    );
    return insertId;
  }

  it("applies to a Member's first Membership Plan", async () => {
    const memberId = await createMember(gymId, 'NM First');
    const umId = await createAssignment(memberId, planId);

    const res = await apply(umId);
    expect(res.status).toBe(201);
  });

  it('refuses a Member who already holds another Membership Plan', async () => {
    const memberId = await createMember(gymId, 'NM Parallel');
    await createAssignment(memberId, otherPlanId, { startsAt: 'CURDATE() - INTERVAL 2 MONTH' });
    const umId = await createAssignment(memberId, planId);

    const res = await apply(umId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/new members/i);
  });

  it('refuses a Member whose previous plan ended inside the last 12 months', async () => {
    const memberId = await createMember(gymId, 'NM Recent');
    await createAssignment(memberId, otherPlanId, {
      status: 'expired',
      startsAt: 'CURDATE() - INTERVAL 24 MONTH',
      endsAt: null,
      createdMonthsAgo: 24,
    });
    await db.query(
      "UPDATE user_memberships SET ends_at = CURDATE() - INTERVAL 3 MONTH WHERE member_id = ? AND status = 'expired'",
      [memberId],
    );
    const umId = await createAssignment(memberId, planId);

    const res = await apply(umId);
    expect(res.status).toBe(400);
  });

  it('applies for a Member coming back more than 12 months later', async () => {
    const memberId = await createMember(gymId, 'NM Returning');
    const lapsedId = await createAssignment(memberId, otherPlanId, {
      status: 'expired',
      startsAt: 'CURDATE() - INTERVAL 36 MONTH',
      createdMonthsAgo: 36,
    });
    await db.query(
      'UPDATE user_memberships SET ends_at = CURDATE() - INTERVAL 18 MONTH WHERE id = ?',
      [lapsedId],
    );
    const umId = await createAssignment(memberId, planId);

    const res = await apply(umId);
    expect(res.status).toBe(201);
  });

  it('still applies a promotion that is not flagged, to a long-standing Member', async () => {
    const openPromoId = await createPromo(gymId, 'NM Open Promo', true, false);
    await targetPlan(gymId, openPromoId, planId);
    const memberId = await createMember(gymId, 'NM Long Standing');
    await createAssignment(memberId, otherPlanId, { startsAt: 'CURDATE() - INTERVAL 2 MONTH' });
    const umId = await createAssignment(memberId, planId);

    const res = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ promotion_id: openPromoId });
    expect(res.status).toBe(201);
  });

});
