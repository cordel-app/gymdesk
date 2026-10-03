// #919/#920 — the Regular / Final Price pair a Promotion's Product
// sections report.
//
// #916 gave the Membership Plan card that pair; these tickets ask the Promotion
// card for it, with the same load-bearing clause:
//
//   > Do not introduce separate pricing logic for the Promotion UI. [...] The UI
//   > should consume the same calculated values used by the actual billing
//   > system wherever possible.
//
// So the point of exercising the real router is that the amounts come from the
// one shared module (`api/product-benefit-pricing.ts`, over
// `applyLineBenefit()` and `computePriceFields()`) rather than from a copy: a
// Promotion and a Plan configuring the same item the same way must quote the
// same two numbers. The pure arithmetic is `plan-benefit-prices.unit.test.ts`.
//
// What differs from the Plan side is the option set: a Promotion may configure
// all five actions (#896 §16), so `fixed_discount` and `fixed_price` — which a
// Plan cannot store — are covered here and nowhere else.

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

describe('Promotion Benefit prices (#919/#920)', () => {
  let gymId: string;
  let promoId: number;
  let taxRateId: number;

  async function createPricedItem(opts: {
    name: string;
    type: 'sessions' | 'service' | 'fee' | 'other';
    frequency: string | null;
    amount: string | null;
    taxRateId?: number | null;
    taxBehavior?: 'inclusive' | 'exclusive';
  }): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO gym_charges
         (gym_id, name, type, billing_frequency, status, is_system, currency,
          amount, tax_rate_id, tax_behavior)
       VALUES (?, ?, ?, ?, 'active', 0, 'EUR', ?, ?, ?)`,
      [gymId, opts.name, opts.type, opts.frequency, opts.amount,
       opts.taxRateId ?? null, opts.taxBehavior ?? 'inclusive'],
    );
    return insertId;
  }

  async function putSection(section: string, items: unknown[]) {
    return request
      .put(`/promotions/${promoId}/${section}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items });
  }

  async function getSection(section: string) {
    return request
      .get(`/promotions/${promoId}/${section}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
  }

  beforeAll(async () => {
    gymId = await createTestGym('PBP Prices Gym');
    await createTestMembership(gymId, 'admin');
    const { insertId: promo } = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status,
                               free_months, paid_months, bonus_months)
       VALUES (?, 'PBP Prices Promo', '2026-08-01', '2026-08-31', 'active', 1, 2, 0)`,
      [gymId],
    );
    promoId = promo;
    const { insertId: rate } = await db.query(
      `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status)
       VALUES (?, 'VAT 10%', 10, 0, 'active')`,
      [gymId],
    );
    taxRateId = rate;
  });

  it('quotes a row at the item price when the Promotion grants no benefit', async () => {
    const lockerId = await createPricedItem({
      name: 'PBP Neutral Locker', type: 'service', frequency: 'month', amount: '15.00',
    });
    const res = await putSection('periodical-benefits', [
      { gym_charge_id: lockerId, quantity: 1, action: 'no_benefit' },
    ]);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.gym_charge_id === lockerId);
    expect(row.original_price_incl_tax).toBe(15);
    expect(row.final_price_incl_tax).toBe(15);
  });

  it('keeps the Regular Price visible for a waived item, whose Final Price is 0', async () => {
    const insuranceId = await createPricedItem({
      name: 'PBP Waived Insurance', type: 'fee', frequency: 'year', amount: '20.00',
    });
    const res = await putSection('periodical-benefits', [
      { gym_charge_id: insuranceId, quantity: 1, action: 'waive' },
    ]);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.gym_charge_id === insuranceId);
    // The ticket's own example: "The Regular Price must remain visible even
    // when the Final Price is zero."
    expect(row.original_price_incl_tax).toBe(20);
    expect(row.final_price_incl_tax).toBe(0);
  });

  it('applies a percentage discount to the item price (the ticket: €15 → €12)', async () => {
    const lockerId = await createPricedItem({
      name: 'PBP Discounted Locker', type: 'service', frequency: 'month', amount: '15.00',
    });
    const res = await putSection('periodical-benefits', [
      { gym_charge_id: lockerId, quantity: 1, action: 'percentage_discount', value: 20 },
    ]);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.gym_charge_id === lockerId);
    expect(row.original_price_incl_tax).toBe(15);
    expect(row.final_price_incl_tax).toBe(12);
  });

  it('prices the two actions only a Promotion may configure (#896 §16)', async () => {
    const feeId = await createPricedItem({
      name: 'PBP Registration Fee', type: 'fee', frequency: 'once', amount: '100.00',
    });
    const discounted = await putSection('oneoff-benefits', [
      { gym_charge_id: feeId, quantity: 1, action: 'fixed_discount', value: 25 },
    ]);
    expect(discounted.status).toBe(200);
    expect(discounted.body[0].original_price_incl_tax).toBe(100);
    expect(discounted.body[0].final_price_incl_tax).toBe(75);

    const fixed = await putSection('oneoff-benefits', [
      { gym_charge_id: feeId, quantity: 1, action: 'fixed_price', value: 60 },
    ]);
    expect(fixed.status).toBe(200);
    expect(fixed.body[0].original_price_incl_tax).toBe(100);
    // The configured amount is taken at face value as the VAT-inclusive figure
    // the gym typed, never grossed up a second time.
    expect(fixed.body[0].final_price_incl_tax).toBe(60);
  });

  it('reports the line beside the unit, so a quantity cannot hide what is granted', async () => {
    const classId = await createPricedItem({
      name: 'PBP Bulk Class', type: 'sessions', frequency: null, amount: '25.00',
    });
    const res = await putSection('session-benefits', [
      { gym_charge_id: classId, quantity: 4, action: 'percentage_discount', value: 10 },
    ]);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.gym_charge_id === classId);
    expect(row.original_price_incl_tax).toBe(25);
    expect(row.final_price_incl_tax).toBe(22.5);
    expect(row.original_line_price_incl_tax).toBe(100);
    expect(row.final_line_price_incl_tax).toBe(90);
  });

  it('grosses up a tax-exclusive item — both amounts are VAT-inclusive', async () => {
    const lockerId = await createPricedItem({
      name: 'PBP Exclusive Locker', type: 'service', frequency: 'month', amount: '15.00',
      taxRateId, taxBehavior: 'exclusive',
    });
    const res = await putSection('periodical-benefits', [
      { gym_charge_id: lockerId, quantity: 1, action: 'waive' },
    ]);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.gym_charge_id === lockerId);
    expect(row.original_price_incl_tax).toBe(16.5);
    expect(row.final_price_incl_tax).toBe(0);
  });

  it('reports "—" rather than €0.00 for an item that carries no price at all', async () => {
    const freeId = await createPricedItem({
      name: 'PBP Unpriced Class', type: 'sessions', frequency: null, amount: null,
    });
    const res = await putSection('session-benefits', [
      { gym_charge_id: freeId, quantity: 1, action: 'waive' },
    ]);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.gym_charge_id === freeId);
    // null is what the page renders as "—"; €0.00 would claim the item is free.
    expect(row.original_price_incl_tax).toBeNull();
    expect(row.final_price_incl_tax).toBeNull();
    expect(row.original_line_price_incl_tax).toBeNull();
    expect(row.final_line_price_incl_tax).toBeNull();
  });

  it('serves the same pair from the section GET as the PUT returned', async () => {
    const feeId = await createPricedItem({
      name: 'PBP Reread Fee', type: 'fee', frequency: 'once', amount: '40.00',
    });
    const put = await putSection('oneoff-benefits', [
      { gym_charge_id: feeId, quantity: 2, action: 'percentage_discount', value: 50 },
    ]);
    expect(put.status).toBe(200);
    const get = await getSection('oneoff-benefits');
    expect(get.status).toBe(200);
    const fromPut = put.body.find((r: any) => r.gym_charge_id === feeId);
    const fromGet = get.body.find((r: any) => r.gym_charge_id === feeId);
    for (const field of [
      'original_price_incl_tax', 'final_price_incl_tax',
      'original_line_price_incl_tax', 'final_line_price_incl_tax',
    ]) {
      expect(fromGet[field]).toBe(fromPut[field]);
    }
    expect(fromGet.final_price_incl_tax).toBe(20);
    expect(fromGet.final_line_price_incl_tax).toBe(40);
  });

  it('keeps pricing an item that has since been deactivated', async () => {
    // The price columns come from the benefit row's own join, not the active
    // catalogue — a Promotion still grants what it was configured with.
    const itemId = await createPricedItem({
      name: 'PBP Retired Service', type: 'service', frequency: 'month', amount: '30.00',
    });
    const put = await putSection('periodical-benefits', [
      { gym_charge_id: itemId, quantity: 1, action: 'waive' },
    ]);
    expect(put.status).toBe(200);
    await db.query('UPDATE gym_charges SET status = ? WHERE id = ? AND gym_id = ?', ['inactive', itemId, gymId]);
    const res = await getSection('periodical-benefits');
    const row = res.body.find((r: any) => r.gym_charge_id === itemId);
    expect(row.gym_charge_status).toBe('inactive');
    expect(row.original_price_incl_tax).toBe(30);
    expect(row.final_price_incl_tax).toBe(0);
  });

  it('is still tenant-scoped: another gym cannot read this Promotion\'s priced rows', async () => {
    const otherGym = await createTestGym('PBP Other Gym');
    await createTestMembership(otherGym, 'admin');
    const res = await request
      .get(`/promotions/${promoId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGym);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
