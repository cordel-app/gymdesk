// #924 stage 2 — the Agreed / Final Price pair, and the Promotion treatment
// beside it, that an **applied Promotion's** grant sections report on the
// Assigned Plan card.
//
// Stage 1 moved the assignment's three Membership Plan Benefit sections onto the
// shared Product grid. The ticket's §6 asks the same of the sections below
// them — the Products each applied Promotion granted — with §1's rule
// unchanged ("do not create a separate visual system for Assigned Plans") and
// §4's "prices always tax included". The load-bearing clause is the one #916 and
// #919/#920 share: no second pricing implementation, so the amounts come from
// `api/product-benefit-pricing.ts` over `applyLineBenefit()`.
//
// What is specific to this side, and what every case below is really about, is
// *which* numbers that module is handed: an application quotes the price and the
// treatment frozen onto its own grant line (#635 §16/§17), never the Promotion
// as it stands today. The pure arithmetic is `plan-benefit-prices.unit.test.ts`;
// the Plan-side counterpart is `assigned-plan-benefit-prices.test.ts`.

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

describe('Applied Promotion grant prices (#924 stage 2)', () => {
  let gymId: string;
  let planId: number;
  let taxRateId: number;

  async function createItem(opts: {
    name: string;
    type: string;
    frequency: string | null;
    amount: number;
    taxRateId?: number | null;
    taxBehavior?: 'inclusive' | 'exclusive';
  }): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO products
         (gym_id, name, type, amount, currency, billing_frequency, status, availability,
          is_system, tax_rate_id, tax_behavior)
       VALUES (?, ?, ?, ?, 'EUR', ?, 'active', 'available', 0, ?, ?)`,
      [gymId, opts.name, opts.type, opts.amount, opts.frequency,
        opts.taxRateId ?? null, opts.taxBehavior ?? 'inclusive'],
    );
    return insertId;
  }

  async function createPromotion(name: string): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO promotions
         (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
          only_applicable_for_new_members, free_months, paid_months, bonus_months)
       VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, 0, 0, 6, 0)`,
      [gymId, name],
    );
    await db.query(
      'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, insertId, planId],
    );
    return insertId;
  }

  /** One grant on the Promotion side, with the `(action, value)` pair #896 put on it. */
  async function grant(
    promotionId: number, category: 'session' | 'oneoff' | 'periodical', chargeId: number,
    opts: { quantity?: number; action?: string; value?: number | null } = {},
  ) {
    await db.query(
      `INSERT INTO promotion_${category}
         (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [gymId, promotionId, chargeId, opts.quantity ?? 1,
        opts.action ?? 'no_benefit', opts.value ?? null],
    );
  }

  async function createAssignment(): Promise<number> {
    const { insertId: memberId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
      [gymId, 'APGP Member', `apgp-${uniq()}@test.com`],
    );
    const { insertId } = await db.query(
      `INSERT INTO user_memberships
         (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
       VALUES (?, ?, ?, 'active', CURDATE(), 100)`,
      [gymId, memberId, planId],
    );
    return insertId;
  }

  const applyPromotion = (umId: number, promotionId: number) =>
    request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ promotion_id: promotionId });

  /** The one granted line of one section of one application, as the card reads it. */
  async function grantRow(
    umId: number, promotionId: number, section: 'session' | 'oneoff' | 'periodical',
  ) {
    const res = await request
      .get(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const application = res.body.find((r: any) => r.promotion_id === promotionId);
    expect(application, 'the application is missing from the card').toBeTruthy();
    const rows = application[`${section}_grants`];
    expect(rows, `no ${section} grants on the application`).toHaveLength(1);
    return rows[0];
  }

  beforeAll(async () => {
    gymId = await createTestGym('APGP Gym');
    await createTestMembership(gymId, 'admin');
    const { insertId: plan } = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
       VALUES (?, ?, 'active', 'staff_only', '1')`,
      [gymId, `APGP-Plan-${uniq()}`],
    );
    planId = plan;
    const { insertId: rate } = await db.query(
      `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status)
       VALUES (?, 'VAT 21%', 21, 0, 'active')`,
      [gymId],
    );
    taxRateId = rate;
  });

  it('quotes a granted line at its agreed price when the grant changes nothing', async () => {
    const umId = await createAssignment();
    const promotionId = await createPromotion(`APGP-Neutral-${uniq()}`);
    const locker = await createItem({
      name: `APGP Neutral Locker ${uniq()}`, type: 'service', frequency: 'month', amount: 15,
    });
    await grant(promotionId, 'periodical', locker, { action: 'no_benefit' });
    expect((await applyPromotion(umId, promotionId)).status).toBe(201);

    const row = await grantRow(umId, promotionId, 'periodical');
    expect(row.action).toBe('no_benefit');
    expect(row.value).toBeNull();
    expect(row.original_price_incl_tax).toBe(15);
    expect(row.final_price_incl_tax).toBe(15);
  });

  it('keeps the Agreed Price visible for a waived grant, whose Final Price is 0', async () => {
    const umId = await createAssignment();
    const promotionId = await createPromotion(`APGP-Waived-${uniq()}`);
    const registration = await createItem({
      name: `APGP Waived Registration ${uniq()}`, type: 'fee', frequency: 'once', amount: 25,
    });
    await grant(promotionId, 'oneoff', registration, { action: 'waive' });
    await applyPromotion(umId, promotionId);

    const row = await grantRow(umId, promotionId, 'oneoff');
    // What the Promotion gives away is only legible beside what it would
    // otherwise have cost — the same rule the Plan and Promotion cards follow.
    expect(row.action).toBe('waive');
    expect(row.original_price_incl_tax).toBe(25);
    expect(row.final_price_incl_tax).toBe(0);
  });

  it('reports the line beside the unit, so a quantity cannot hide what was granted', async () => {
    const umId = await createAssignment();
    const promotionId = await createPromotion(`APGP-Bulk-${uniq()}`);
    const pack = await createItem({
      name: `APGP PT Pack ${uniq()}`, type: 'sessions', frequency: 'per_session', amount: 40,
    });
    await grant(promotionId, 'session', pack, {
      quantity: 10, action: 'percentage_discount', value: 25,
    });
    await applyPromotion(umId, promotionId);

    const row = await grantRow(umId, promotionId, 'session');
    expect(row.quantity).toBe(10);
    expect(row.original_price_incl_tax).toBe(40);
    expect(row.final_price_incl_tax).toBe(30);
    expect(row.original_line_price_incl_tax).toBe(400);
    expect(row.final_line_price_incl_tax).toBe(300);
  });

  it('reads the pair in the Promotion\'s own option set, not a Plan\'s three', async () => {
    // #896 §16: a Promotion may configure all five actions. Read in the Plan's
    // context these two would normalize to `no_benefit` and the card would quote
    // the full price for a line the member was promised at another one.
    const umId = await createAssignment();
    const promotionId = await createPromotion(`APGP-Monetary-${uniq()}`);
    const towel = await createItem({
      name: `APGP Towel ${uniq()}`, type: 'service', frequency: 'month', amount: 30,
    });
    const locker = await createItem({
      name: `APGP Fixed Locker ${uniq()}`, type: 'fee', frequency: 'once', amount: 50,
    });
    await grant(promotionId, 'periodical', towel, { action: 'fixed_discount', value: 10 });
    await grant(promotionId, 'oneoff', locker, { action: 'fixed_price', value: 20 });
    await applyPromotion(umId, promotionId);

    const periodical = await grantRow(umId, promotionId, 'periodical');
    expect(periodical.action).toBe('fixed_discount');
    expect(periodical.value).toBe(10);
    expect(periodical.final_price_incl_tax).toBe(20);

    const oneoff = await grantRow(umId, promotionId, 'oneoff');
    expect(oneoff.action).toBe('fixed_price');
    expect(oneoff.value).toBe(20);
    expect(oneoff.final_price_incl_tax).toBe(20);
  });

  it('quotes the price tax-included for an item priced net (§4)', async () => {
    const umId = await createAssignment();
    const promotionId = await createPromotion(`APGP-Tax-${uniq()}`);
    const coaching = await createItem({
      name: `APGP Net Coaching ${uniq()}`, type: 'service', frequency: 'month', amount: 100,
      taxRateId, taxBehavior: 'exclusive',
    });
    await grant(promotionId, 'periodical', coaching, { action: 'percentage_discount', value: 10 });
    await applyPromotion(umId, promotionId);

    const row = await grantRow(umId, promotionId, 'periodical');
    // The rate is the one live column a frozen line reads: the snapshot never
    // captured a statutory rate, and a percentage of the gross is the gross of
    // the percentage, so grossing up first is exact.
    expect(row.original_price_incl_tax).toBe(121);
    expect(row.final_price_incl_tax).toBe(108.9);
  });

  it('prices from the frozen line, so repricing or re-configuring the Promotion moves nothing', async () => {
    const umId = await createAssignment();
    const promotionId = await createPromotion(`APGP-Frozen-${uniq()}`);
    const locker = await createItem({
      name: `APGP Frozen Locker ${uniq()}`, type: 'service', frequency: 'month', amount: 20,
    });
    await grant(promotionId, 'periodical', locker, { action: 'waive' });
    await applyPromotion(umId, promotionId);

    // Everything the catalogue and the Promotion could say afterwards changes.
    await db.query('UPDATE products SET amount = 999 WHERE id = ?', [locker]);
    await db.query(
      "UPDATE promotion_periodical SET `action` = 'no_benefit', `value` = NULL WHERE promotion_id = ?",
      [promotionId],
    );

    const row = await grantRow(umId, promotionId, 'periodical');
    expect(row.unit_price).toBe(20);
    expect(row.action).toBe('waive');
    expect(row.original_price_incl_tax).toBe(20);
    expect(row.final_price_incl_tax).toBe(0);
  });

  it('keeps pricing a grant whose Product has since been deleted', async () => {
    const umId = await createAssignment();
    const promotionId = await createPromotion(`APGP-Deleted-${uniq()}`);
    const locker = await createItem({
      name: `APGP Doomed Locker ${uniq()}`, type: 'service', frequency: 'month', amount: 18,
    });
    await grant(promotionId, 'periodical', locker, { action: 'percentage_discount', value: 50 });
    await applyPromotion(umId, promotionId);
    // `product_id` is ON DELETE SET NULL on the snapshot: the identity goes,
    // the agreement stays, and the frozen amount is the honest gross.
    await db.query('DELETE FROM promotion_periodical WHERE product_id = ?', [locker]);
    await db.query('DELETE FROM products WHERE id = ?', [locker]);

    const row = await grantRow(umId, promotionId, 'periodical');
    expect(row.product_id).toBeNull();
    expect(row.original_price_incl_tax).toBe(18);
    expect(row.final_price_incl_tax).toBe(9);
  });

  it('prices an application that predates the snapshot flow from the live grant', async () => {
    const umId = await createAssignment();
    const promotionId = await createPromotion(`APGP-Legacy-${uniq()}`);
    const locker = await createItem({
      name: `APGP Legacy Locker ${uniq()}`, type: 'service', frequency: 'month', amount: 12,
      taxRateId, taxBehavior: 'exclusive',
    });
    await grant(promotionId, 'periodical', locker, { action: 'waive' });
    // An application from before migration 149: no snapshot row and no grant
    // snapshot, which is the one case the live tables are still read for.
    await db.query(
      `INSERT INTO user_membership_promotions
         (gym_id, user_membership_id, promotion_id, status, snapshot)
       VALUES (?, ?, ?, 'applied', NULL)`,
      [gymId, umId, promotionId],
    );

    const row = await grantRow(umId, promotionId, 'periodical');
    expect(row.action).toBe('waive');
    expect(row.original_price_incl_tax).toBe(14.52);
    expect(row.final_price_incl_tax).toBe(0);
  });

  it('isolates tenants: another gym reads none of this assignment\'s applications', async () => {
    const umId = await createAssignment();
    const promotionId = await createPromotion(`APGP-Tenant-${uniq()}`);
    const locker = await createItem({
      name: `APGP Tenant Locker ${uniq()}`, type: 'service', frequency: 'month', amount: 9,
    });
    await grant(promotionId, 'periodical', locker, { action: 'waive' });
    await applyPromotion(umId, promotionId);

    const otherGymId = await createTestGym('APGP Other Gym');
    await createTestMembership(otherGymId, 'admin');
    const res = await request
      .get(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    // The read is gym-scoped in SQL, so a foreign caller sees an empty card
    // rather than another gym's agreed prices.
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
