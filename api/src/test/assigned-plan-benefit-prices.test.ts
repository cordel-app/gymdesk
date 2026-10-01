// #924 stage 1 — the Agreed / Final Price pair an **Assigned Plan's** three
// Sellable Item sections report.
//
// The ticket asks the Assigned Plan card to stop maintaining a visual system of
// its own and render the sections from the shared column grid the Membership
// Plan and Promotion cards already use (§1/§4), prices "always tax included".
// Its load-bearing clause is the one #916 and #919/#920 share — no second
// pricing implementation:
//
//   > Reuse Membership Plan pricing calculations. [...] Assigned Plans should
//   > essentially provide the Membership Plan data plus the assigned-person
//   > context [...].
//
// So the amounts come from the one shared module (`api/sellable-item-benefit-
// pricing.ts`, over `applyLineBenefit()` and `computePriceFields()`). What is
// specific to this side — and what every case below is really about — is *which*
// numbers it is handed: an assignment quotes the price and the treatment frozen
// onto its own line (#635 §17), never the catalogue's current ones. The pure
// arithmetic is `plan-benefit-prices.unit.test.ts`.

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

const PRICE_FIELDS = [
  'original_price_incl_tax', 'final_price_incl_tax',
  'original_line_price_incl_tax', 'final_line_price_incl_tax',
] as const;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('Assigned Plan Benefit prices (#924 stage 1)', () => {
  let gymId: string;
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

  async function createPlan(): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO membership_plans
         (gym_id, name, lifecycle_status, enrollment_status, member_limit,
          free_periods, paid_periods, bonus_periods)
       VALUES (?, ?, 'active', 'public', '1', 0, 12, 0)`,
      [gymId, `ABP-Plan-${uniq()}`],
    );
    await db.query(
      `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
       VALUES (?, ?, 1, 'month')`,
      [gymId, insertId],
    );
    return insertId;
  }

  /** One benefit row on the Plan side, with the `(action, value)` pair #896 put on it. */
  async function addPlanBenefit(table: string, planId: number, chargeId: number, opts: {
    quantity?: number;
    action?: string;
    value?: number | null;
    frequency?: string | null;
  } = {}): Promise<void> {
    const sessionFrequency = table === 'membership_plan_session';
    await db.query(
      `INSERT INTO ${table}
         (gym_id, membership_plan_id, gym_charge_id, quantity, \`action\`, \`value\`
          ${sessionFrequency ? ', frequency' : ''})
       VALUES (?, ?, ?, ?, ?, ?${sessionFrequency ? ', ?' : ''})`,
      [gymId, planId, chargeId, opts.quantity ?? 1, opts.action ?? 'no_benefit', opts.value ?? null,
        ...(sessionFrequency ? [opts.frequency ?? null] : [])],
    );
  }

  async function assignPlan(planId: number): Promise<number> {
    const { insertId: memberId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
      [gymId, 'ABP Member', `abp-${uniq()}@test.com`],
    );
    const res = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, membership_plan_id: planId, starts_at: today() });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  function getAssignment(umId: number) {
    return request
      .get(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
  }

  /** The one priced line of one section of an assignment's snapshot. */
  async function snapshotRow(umId: number, section: 'session' | 'oneoff' | 'periodical') {
    const res = await getAssignment(umId);
    expect(res.status).toBe(200);
    const rows = res.body.snapshot[`${section}_benefits`];
    expect(rows, `no ${section} rows on the snapshot`).toHaveLength(1);
    return rows[0];
  }

  beforeAll(async () => {
    gymId = await createTestGym('ABP Prices Gym');
    await createTestMembership(gymId, 'admin');
    const { insertId: rate } = await db.query(
      `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status)
       VALUES (?, 'VAT 10%', 10, 0, 'active')`,
      [gymId],
    );
    taxRateId = rate;
  });

  it('quotes a line at its agreed price when the Plan grants no benefit', async () => {
    const planId = await createPlan();
    const lockerId = await createPricedItem({
      name: `ABP Neutral Locker ${uniq()}`, type: 'service', frequency: 'month', amount: '15.00',
    });
    await addPlanBenefit('membership_plan_periodical', planId, lockerId, { action: 'no_benefit' });
    const row = await snapshotRow(await assignPlan(planId), 'periodical');
    expect(row.original_price_incl_tax).toBe(15);
    expect(row.final_price_incl_tax).toBe(15);
  });

  it('keeps the Agreed Price visible for a waived line, whose Final Price is 0', async () => {
    const planId = await createPlan();
    const insuranceId = await createPricedItem({
      name: `ABP Waived Insurance ${uniq()}`, type: 'fee', frequency: 'year', amount: '20.00',
    });
    await addPlanBenefit('membership_plan_periodical', planId, insuranceId, { action: 'waive' });
    const row = await snapshotRow(await assignPlan(planId), 'periodical');
    // The same rule the Promotion and Plan cards follow: what the member is
    // given away is only legible beside what it would otherwise have cost.
    expect(row.original_price_incl_tax).toBe(20);
    expect(row.final_price_incl_tax).toBe(0);
  });

  it('applies the agreed percentage discount (€15 → €12)', async () => {
    const planId = await createPlan();
    const lockerId = await createPricedItem({
      name: `ABP Discounted Locker ${uniq()}`, type: 'service', frequency: 'month', amount: '15.00',
    });
    await addPlanBenefit('membership_plan_periodical', planId, lockerId, {
      action: 'percentage_discount', value: 20,
    });
    const row = await snapshotRow(await assignPlan(planId), 'periodical');
    expect(row.action).toBe('percentage_discount');
    expect(row.value).toBe(20);
    expect(row.original_price_incl_tax).toBe(15);
    expect(row.final_price_incl_tax).toBe(12);
  });

  it('reports the line beside the unit, so a quantity cannot hide what is agreed', async () => {
    const planId = await createPlan();
    const classId = await createPricedItem({
      name: `ABP Bulk Class ${uniq()}`, type: 'sessions', frequency: null, amount: '25.00',
    });
    await addPlanBenefit('membership_plan_session', planId, classId, {
      quantity: 4, action: 'percentage_discount', value: 10, frequency: 'week',
    });
    const row = await snapshotRow(await assignPlan(planId), 'session');
    expect(row.quantity).toBe(4);
    // #918's agreed renewal Frequency travels with the prices — it is what the
    // shared grid's Frequency column shows for a Session line.
    expect(row.frequency).toBe('week');
    expect(row.original_price_incl_tax).toBe(25);
    expect(row.final_price_incl_tax).toBe(22.5);
    expect(row.original_line_price_incl_tax).toBe(100);
    expect(row.final_line_price_incl_tax).toBe(90);
  });

  it('grosses up a tax-exclusive item — both amounts are VAT-inclusive (§4)', async () => {
    const planId = await createPlan();
    const lockerId = await createPricedItem({
      name: `ABP Exclusive Locker ${uniq()}`, type: 'service', frequency: 'month', amount: '15.00',
      taxRateId, taxBehavior: 'exclusive',
    });
    await addPlanBenefit('membership_plan_periodical', planId, lockerId, { action: 'waive' });
    const row = await snapshotRow(await assignPlan(planId), 'periodical');
    // The frozen amount is the net 15.00 the snapshot captured; the rate is the
    // statutory one, which the snapshot never captured and never could.
    expect(row.unit_price).toBe(15);
    expect(row.original_price_incl_tax).toBe(16.5);
    expect(row.final_price_incl_tax).toBe(0);
  });

  it('quotes the frozen price after the Sellable Item is repriced (#635 §17)', async () => {
    const planId = await createPlan();
    const feeId = await createPricedItem({
      name: `ABP Frozen Fee ${uniq()}`, type: 'fee', frequency: 'once', amount: '100.00',
    });
    await addPlanBenefit('membership_plan_oneoff', planId, feeId, {
      quantity: 2, action: 'percentage_discount', value: 50,
    });
    const umId = await assignPlan(planId);
    await db.query('UPDATE gym_charges SET amount = 999 WHERE id = ? AND gym_id = ?', [feeId, gymId]);
    const row = await snapshotRow(umId, 'oneoff');
    expect(row.unit_price).toBe(100);
    expect(row.original_price_incl_tax).toBe(100);
    expect(row.final_price_incl_tax).toBe(50);
    expect(row.original_line_price_incl_tax).toBe(200);
    expect(row.final_line_price_incl_tax).toBe(100);
  });

  it('also quotes the frozen price after the Plan re-configures the line', async () => {
    const planId = await createPlan();
    const lockerId = await createPricedItem({
      name: `ABP Replanned Locker ${uniq()}`, type: 'service', frequency: 'month', amount: '40.00',
    });
    await addPlanBenefit('membership_plan_periodical', planId, lockerId, { action: 'waive' });
    const umId = await assignPlan(planId);
    await db.query(
      'UPDATE membership_plan_periodical SET `action` = ?, `value` = NULL WHERE membership_plan_id = ? AND gym_charge_id = ?',
      ['no_benefit', planId, lockerId],
    );
    const row = await snapshotRow(umId, 'periodical');
    // The treatment is part of the agreement, so the Plan changing its mind
    // afterwards moves nothing: this member's locker is still free.
    expect(row.action).toBe('waive');
    expect(row.final_price_incl_tax).toBe(0);
  });

  it('prices an item that carried no price at all at the €0.00 it froze', async () => {
    const planId = await createPlan();
    const freeId = await createPricedItem({
      name: `ABP Unpriced Class ${uniq()}`, type: 'sessions', frequency: null, amount: null,
    });
    await addPlanBenefit('membership_plan_session', planId, freeId, { action: 'no_benefit' });
    const row = await snapshotRow(await assignPlan(planId), 'session');
    // Unlike a Plan or Promotion row — which reads "—" for an item with no
    // `amount` — the snapshot has a price: `snapshotAssignedPlan()` freezes
    // `COALESCE(gc.amount, 0)`, so the line was genuinely agreed at nothing.
    expect(row.unit_price).toBe(0);
    expect(row.original_price_incl_tax).toBe(0);
    expect(row.final_price_incl_tax).toBe(0);
  });

  it('serves the same pair from the section GET and PUT as from the card', async () => {
    const planId = await createPlan();
    const lockerId = await createPricedItem({
      name: `ABP Reread Locker ${uniq()}`, type: 'service', frequency: 'month', amount: '30.00',
    });
    await addPlanBenefit('membership_plan_periodical', planId, lockerId, {
      quantity: 2, action: 'percentage_discount', value: 10,
    });
    const umId = await assignPlan(planId);
    const fromCard = await snapshotRow(umId, 'periodical');

    const get = await request
      .get(`/user-memberships/${umId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(get.status).toBe(200);

    // The replace-all `PUT` still takes quantity alone, so the agreed treatment
    // survives a quantity edit and the prices follow the new line total.
    const put = await request
      .put(`/user-memberships/${umId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: lockerId, quantity: 3 }] });
    expect(put.status).toBe(200);

    for (const field of PRICE_FIELDS) {
      expect(get.body[0][field], field).toBe(fromCard[field]);
    }
    expect(fromCard.final_line_price_incl_tax).toBe(54);
    expect(put.body[0]).toMatchObject({
      quantity: 3,
      action: 'percentage_discount',
      original_price_incl_tax: 30,
      final_price_incl_tax: 27,
      original_line_price_incl_tax: 90,
      final_line_price_incl_tax: 81,
    });
  });

  it('keeps pricing a line whose Sellable Item has since been retired', async () => {
    const planId = await createPlan();
    const itemId = await createPricedItem({
      name: `ABP Retired Service ${uniq()}`, type: 'service', frequency: 'month', amount: '30.00',
    });
    await addPlanBenefit('membership_plan_periodical', planId, itemId, { action: 'waive' });
    const umId = await assignPlan(planId);
    await db.query(
      'UPDATE gym_charges SET status = ?, deleted_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id = ?',
      ['inactive', itemId, gymId],
    );
    const row = await snapshotRow(umId, 'periodical');
    expect(row.original_price_incl_tax).toBe(30);
    expect(row.final_price_incl_tax).toBe(0);
  });

  it('is tenant-scoped: another gym cannot read this assignment at all', async () => {
    const planId = await createPlan();
    const feeId = await createPricedItem({
      name: `ABP Isolated Fee ${uniq()}`, type: 'fee', frequency: 'once', amount: '10.00',
    });
    await addPlanBenefit('membership_plan_oneoff', planId, feeId);
    const umId = await assignPlan(planId);
    const otherGym = await createTestGym('ABP Other Gym');
    await createTestMembership(otherGym, 'admin');
    const res = await request
      .get(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGym);
    expect(res.status).toBe(404);
  });
});
