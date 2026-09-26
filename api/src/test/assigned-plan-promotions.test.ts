// #635 stage 7 — the Promotions an Assigned Plan was agreed with, read from
// the application's own snapshot (§16).
//
// Two things are proven here, over the full Express + MySQL stack:
//   1. What the Assigned Plan card shows about an applied Promotion — who
//      applied it, how it reads today, and the Sellable Items it granted at
//      the prices agreed — comes from the application, never from the
//      Promotion's current definition.
//   2. What it *charges* does too: `computeFinalPrice` now reads each
//      application's Membership Fee Benefit out of its snapshot, so editing
//      the Promotion between two recomputations can no longer reprice an
//      assignment that already exists (§13/§16).
//
// Fixtures are inserted directly; the HTTP API is only used for the action
// under test (CLAUDE.md).

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

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * A gym-owned Sellable Item. No `charge_type_id`: that column is unique per
 * gym (one row per system charge type), so every item a test needs alongside
 * another one is a plain gym item, named and typed in its own right.
 */
async function createSellableItem(
  gymId: string, name: string, type: string, amount: number, frequency: string | null,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_charges
       (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, ?, ?, 'EUR', ?, 'active', 'available', 0)`,
    [gymId, name, type, amount, frequency],
  );
  return insertId;
}

async function createPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'staff_only', '1')`,
    [gymId, `APP-Plan-${uniq()}`],
  );
  return insertId;
}

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'APP Member', `app-${uniq()}@test.com`],
  );
  return insertId;
}

/**
 * `next_billing_date` is 45 days out deliberately: it is the cycle the fee is
 * resolved on (#635 stage 15 — there is no stored price, so "what does this
 * assignment cost" is always "on which date"), and these Promotions carry one
 * free month. A cycle inside the free month costs nothing whatever the benefit
 * says, so pricing one *paid* promotional month is what makes the benefit — the
 * thing these cases are about — observable.
 */
async function createAssignment(gymId: string, planId: number, basePrice = 100): Promise<number> {
  const memberId = await createMember(gymId);
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price, membership_fee_price,
        next_billing_date)
     VALUES (?, ?, ?, 'active', CURDATE(), ?, ?, CURDATE() + INTERVAL 45 DAY)`,
    [gymId, memberId, planId, basePrice, basePrice],
  );
  return insertId;
}

async function createPromotion(
  gymId: string, name: string, opts: { stackable?: boolean; endsAt?: string } = {},
): Promise<number> {
  const { stackable = true, endsAt = '2099-12-31' } = opts;
  const { insertId } = await db.query(
    `INSERT INTO promotions
       (gym_id, name, description, starts_at, ends_at, lifecycle_status, stackable,
        only_applicable_for_new_members, free_months, paid_months, bonus_months)
     VALUES (?, ?, 'Agreed description', '2026-01-01', ?, 'active', ?, 0, 1, 6, 2)`,
    [gymId, name, endsAt, stackable ? 1 : 0],
  );
  return insertId;
}

async function targetPlan(gymId: string, promotionId: number, planId: number) {
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, promotionId, planId],
  );
}

async function setMembershipFeeBenefit(
  gymId: string, promotionId: number, action: string, value: number,
  opts: { durationMonths?: number | null } = {},
) {
  await db.query(
    `INSERT INTO promotion_membership_fee_benefits
       (gym_id, promotion_id, quantity, frequency_interval, frequency_unit, duration_months, enabled, action, value)
     VALUES (?, ?, 1, 1, 'month', ?, 1, ?, ?)`,
    [gymId, promotionId, opts.durationMonths ?? null, action, value],
  );
}

async function grantSellableItem(
  gymId: string, promotionId: number, category: 'session' | 'oneoff' | 'periodical',
  gymChargeId: number, quantity: number,
) {
  await db.query(
    `INSERT INTO promotion_${category} (gym_id, promotion_id, gym_charge_id, quantity) VALUES (?, ?, ?, ?)`,
    [gymId, promotionId, gymChargeId, quantity],
  );
}

const applyPromotion = (gymId: string, umId: number, promotionId: number) =>
  request
    .post(`/user-memberships/${umId}/promotions`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ promotion_id: promotionId });

const listPromotions = (gymId: string, umId: number) =>
  request.get(`/user-memberships/${umId}/promotions`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

const revokePromotion = (gymId: string, umId: number, promotionId: number) =>
  request
    .delete(`/user-memberships/${umId}/promotions/${promotionId}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);

/**
 * What the assignment's Membership Fee comes to on the cycle it is next charged
 * for. #635 stage 15 — there is no stored price to read: the API resolves it from
 * the assignment's own snapshot and its standing applications, which is exactly
 * what these cases are about.
 */
async function membershipFee(gymId: string, umId: number): Promise<number> {
  const res = await request
    .get(`/user-memberships/${umId}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);
  return Number(res.body.membership_fee);
}

// ─── What the card reads ─────────────────────────────────────────────────────

describe('GET /user-memberships/:id/promotions — the expandable card (#635 §16)', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('APP Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId);
  });

  it('names who applied it and when', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `Applied-By-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    expect((await applyPromotion(gymId, umId, promotionId)).status).toBe(201);

    const res = await listPromotions(gymId, umId);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.promotion_id === promotionId);
    // createTestMembership inserts the acting user's gym_memberships row with
    // no name, so the column resolves but is null — what matters is that the
    // applier is looked up at all, and that the card has an applied_at to show.
    expect(row).toHaveProperty('applied_by_name');
    expect(row.applied_at).toBeTruthy();
  });

  it('reads as active while inside its agreed window', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `Active-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);

    const res = await listPromotions(gymId, umId);
    expect(res.body.find((r: any) => r.promotion_id === promotionId).display_status).toBe('active');
  });

  it('reads as inactive once revoked', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `Revoked-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);
    expect((await revokePromotion(gymId, umId, promotionId)).status).toBe(200);

    const res = await listPromotions(gymId, umId);
    const row = res.body.find((r: any) => r.promotion_id === promotionId);
    expect(row.display_status).toBe('inactive');
    expect(row.revoked_at).toBeTruthy();
  });

  it('reads as expired once the agreed window has passed, without touching the row', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `Expiring-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);

    // The window the application agreed to is the snapshot's, so it is the
    // snapshot that is backdated here — the Promotion's own dates are
    // deliberately left alone, which is what proves the read is snapshot-based.
    await db.query(
      `UPDATE user_membership_promotions
       SET snapshot = JSON_SET(snapshot, '$.ends_at', '2026-01-31')
       WHERE user_membership_id = ? AND promotion_id = ?`,
      [umId, promotionId],
    );

    const res = await listPromotions(gymId, umId);
    const row = res.body.find((r: any) => r.promotion_id === promotionId);
    expect(row.display_status).toBe('expired');
    expect(row.status).toBe('applied');
  });

  it('lists the Sellable Items it granted, at the prices they were agreed at', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `Grants-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    // Types and frequencies follow classifySellableItem() (#550): 'sessions'
    // is a Session item, a recurring frequency makes a Period item, anything
    // else is One-off.
    const sessionItem = await createSellableItem(gymId, 'PT Pack', 'sessions', 40, 'per_session');
    const oneoffItem = await createSellableItem(gymId, 'Registration', 'fee', 25, 'once');
    const periodicalItem = await createSellableItem(gymId, 'Locker', 'service', 10, 'month');
    await grantSellableItem(gymId, promotionId, 'session', sessionItem, 10);
    await grantSellableItem(gymId, promotionId, 'oneoff', oneoffItem, 1);
    await grantSellableItem(gymId, promotionId, 'periodical', periodicalItem, 2);
    await applyPromotion(gymId, umId, promotionId);

    // Everything the catalogue could say afterwards is changed: prices,
    // names, and the Promotion's own grant rows.
    await db.query('UPDATE gym_charges SET amount = 999, name = ? WHERE id = ?', ['Renamed Pack', sessionItem]);
    await db.query('UPDATE gym_charges SET amount = 777 WHERE id = ?', [periodicalItem]);
    await db.query('DELETE FROM promotion_oneoff WHERE promotion_id = ?', [promotionId]);

    const res = await listPromotions(gymId, umId);
    const row = res.body.find((r: any) => r.promotion_id === promotionId);

    expect(row.session_grants).toHaveLength(1);
    expect(row.session_grants[0].item_name).toBe('PT Pack');
    expect(row.session_grants[0].quantity).toBe(10);
    expect(row.session_grants[0].unit_price).toBe(40);
    expect(row.periodical_grants[0].unit_price).toBe(10);
    expect(row.periodical_grants[0].item_billing_frequency).toBe('month');
    // Removing the grant from the Promotion does not remove it from what this
    // member was given (§16).
    expect(row.oneoff_grants).toHaveLength(1);
    expect(row.oneoff_grants[0].item_name).toBe('Registration');
    expect(row.oneoff_grants[0].unit_price).toBe(25);
  });

  it('falls back to the Promotion\'s live benefits for an application with no snapshot', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `Legacy-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    const item = await createSellableItem(gymId, 'Legacy Locker', 'service', 12, 'month');
    await grantSellableItem(gymId, promotionId, 'periodical', item, 1);

    // An application from before the snapshot flow: inserted directly, with no
    // snapshot JSON and no grant snapshot rows.
    await db.query(
      `INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, applied_by, status, snapshot)
       VALUES (?, ?, ?, 'legacy-actor', 'applied', NULL)`,
      [gymId, umId, promotionId],
    );

    const res = await listPromotions(gymId, umId);
    const row = res.body.find((r: any) => r.promotion_id === promotionId);
    expect(row.periodical_grants).toHaveLength(1);
    expect(row.periodical_grants[0].item_name).toBe('Legacy Locker');
    expect(row.periodical_grants[0].unit_price).toBe(12);
    expect(row.session_grants).toEqual([]);
  });

  it('embeds the same rows in the Assigned Plan detail the card reads', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `Detail-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    const item = await createSellableItem(gymId, 'Detail Pack', 'sessions', 30, 'per_session');
    await grantSellableItem(gymId, promotionId, 'session', item, 5);
    await applyPromotion(gymId, umId, promotionId);

    const res = await request
      .get(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const row = res.body.promotions.find((r: any) => r.promotion_id === promotionId);
    expect(row.display_status).toBe('active');
    expect(row.session_grants[0].unit_price).toBe(30);
    expect(row.free_months).toBe(1);
    expect(row.paid_months).toBe(6);
    expect(row.bonus_months).toBe(2);
  });
});

// ─── What the assignment charges ─────────────────────────────────────────────

describe('Promotion pricing reads the application snapshot (#635 §13/§16)', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('APP Pricing Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId);
  });

  it('keeps the agreed price when the Promotion is repriced and another one is revoked', async () => {
    const umId = await createAssignment(gymId, planId, 100);
    const keptId = await createPromotion(gymId, `Kept-${uniq()}`);
    const revokedId = await createPromotion(gymId, `ToRevoke-${uniq()}`);
    await targetPlan(gymId, keptId, planId);
    await targetPlan(gymId, revokedId, planId);
    await setMembershipFeeBenefit(gymId, keptId, 'fixed_discount', 10);
    await setMembershipFeeBenefit(gymId, revokedId, 'fixed_discount', 5);

    await applyPromotion(gymId, umId, keptId);
    await applyPromotion(gymId, umId, revokedId);
    expect(await membershipFee(gymId, umId)).toBe(85);

    // The Promotion is repriced after being applied. Revoking the *other* one
    // recomputes the price, which used to pull in this new value.
    await db.query(
      "UPDATE promotion_membership_fee_benefits SET action = 'fixed_price', value = 1 WHERE promotion_id = ?",
      [keptId],
    );
    expect((await revokePromotion(gymId, umId, revokedId)).status).toBe(200);

    expect(await membershipFee(gymId, umId)).toBe(90);
  });

  it('keeps the agreed price when the Promotion\'s benefit is deleted outright', async () => {
    const umId = await createAssignment(gymId, planId, 200);
    const promotionId = await createPromotion(gymId, `Deleted-Benefit-${uniq()}`);
    const otherId = await createPromotion(gymId, `Other-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await targetPlan(gymId, otherId, planId);
    await setMembershipFeeBenefit(gymId, promotionId, 'percentage_discount', 50);

    await applyPromotion(gymId, umId, promotionId);
    expect(await membershipFee(gymId, umId)).toBe(100);

    await db.query('DELETE FROM promotion_membership_fee_benefits WHERE promotion_id = ?', [promotionId]);
    // Any later recompute — here, applying a second Promotion — must still
    // honour the first one's agreed benefit.
    expect((await applyPromotion(gymId, umId, otherId)).status).toBe(201);
    expect(await membershipFee(gymId, umId)).toBe(100);
  });

  it('still honours the duration gate, counted from when it was applied', async () => {
    const umId = await createAssignment(gymId, planId, 100);
    const lapsedId = await createPromotion(gymId, `Lapsed-${uniq()}`);
    const otherId = await createPromotion(gymId, `Recompute-${uniq()}`);
    await targetPlan(gymId, lapsedId, planId);
    await targetPlan(gymId, otherId, planId);
    await setMembershipFeeBenefit(gymId, lapsedId, 'fixed_discount', 40, { durationMonths: 3 });

    await applyPromotion(gymId, umId, lapsedId);
    expect(await membershipFee(gymId, umId)).toBe(60);

    // Four months later its three-month window is over: the next recompute
    // drops it, exactly as the SQL gate did before the snapshot cutover.
    await db.query(
      `UPDATE user_membership_promotions SET applied_at = applied_at - INTERVAL 4 MONTH
       WHERE user_membership_id = ? AND promotion_id = ?`,
      [umId, lapsedId],
    );
    expect((await applyPromotion(gymId, umId, otherId)).status).toBe(201);
    expect(await membershipFee(gymId, umId)).toBe(100);
  });

  it('prices a snapshot-less application from the Promotion, which is all it has', async () => {
    const umId = await createAssignment(gymId, planId, 100);
    const legacyId = await createPromotion(gymId, `Legacy-Price-${uniq()}`);
    const otherId = await createPromotion(gymId, `Legacy-Recompute-${uniq()}`);
    await targetPlan(gymId, legacyId, planId);
    await targetPlan(gymId, otherId, planId);
    await setMembershipFeeBenefit(gymId, legacyId, 'fixed_discount', 25);
    await db.query(
      `INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, applied_by, status, snapshot)
       VALUES (?, ?, ?, 'legacy-actor', 'applied', NULL)`,
      [gymId, umId, legacyId],
    );

    expect((await applyPromotion(gymId, umId, otherId)).status).toBe(201);
    expect(await membershipFee(gymId, umId)).toBe(75);
  });
});

// ─── Tenant isolation and auth ───────────────────────────────────────────────

describe('Assigned Plan promotions — tenant isolation and auth', () => {
  let gymA: string;
  let gymB: string;
  let umA: number;

  beforeAll(async () => {
    gymA = await createTestGym('APP Gym A');
    await createTestMembership(gymA, 'admin');
    gymB = await createTestGym('APP Gym B');
    await createTestMembership(gymB, 'admin');

    const planId = await createPlan(gymA);
    umA = await createAssignment(gymA, planId);
    const promotionId = await createPromotion(gymA, `Isolated-${uniq()}`);
    await targetPlan(gymA, promotionId, planId);
    await applyPromotion(gymA, umA, promotionId);
  });

  it('never lists another gym\'s applications', async () => {
    const res = await listPromotions(gymB, umA);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request.get(`/user-memberships/${umA}/promotions`).set('x-gym-id', gymA);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a role with no access to PAYMENTS', async () => {
    const noAccessGym = await createTestGym('APP No Access');
    await createTestMembership(noAccessGym, 'trainer_performance');
    const res = await listPromotions(noAccessGym, umA);
    expect(res.status).toBe(403);
  });

  it('returns 403 when a read-only role tries to revoke', async () => {
    const readOnlyGym = await createTestGym('APP Read Only');
    await createTestMembership(readOnlyGym, 'accountant');
    const planId = await createPlan(readOnlyGym);
    const umId = await createAssignment(readOnlyGym, planId);
    const promotionId = await createPromotion(readOnlyGym, `ReadOnly-${uniq()}`);
    await targetPlan(readOnlyGym, promotionId, planId);
    await db.query(
      `INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, applied_by, status)
       VALUES (?, ?, ?, 'someone', 'applied')`,
      [readOnlyGym, umId, promotionId],
    );

    expect((await revokePromotion(readOnlyGym, umId, promotionId)).status).toBe(403);
    const { rows } = await db.query<{ status: string }>(
      'SELECT status FROM user_membership_promotions WHERE user_membership_id = ?', [umId],
    );
    expect(rows[0].status).toBe('applied');
  });
});
