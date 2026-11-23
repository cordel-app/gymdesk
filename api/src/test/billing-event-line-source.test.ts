// #3254 — every Billing Event Line records where it comes from: `plan` (the Membership Fee and a
// Product the Plan includes) or `product` (a Product bought on its own). Decided by the line's
// builder when the event is written, persisted with it, and reported by the staff detail read.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { createDraft } from '../api/product-sets';
import {
  addProductSetService, ensureSchedule, materialiseScheduledEvents, snapshotProductSetFromPlan,
} from '../api/product-set-configuration';
import { lineSource } from '../domain/billingEventLines';

let gymId: string;
let otherGymId: string;
const actor = { name: 'Test', type: 'staff' };
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const dayAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `bels-${uniq()}@example.com`]);
  return insertId;
}
async function product(name: string, amount: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, 'fee', ?, 'EUR', 'month', 'active', 'available', 0)`, [gymId, `${name}-${uniq()}`, amount]);
  return insertId;
}
async function plan(price: number, includedProductId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `BELS-Plan-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, ?, 'active')`, [gymId, insertId, price, dayAgo(365)]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  await db.query(`INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, 1)`,
    [gymId, insertId, includedProductId]);
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('Line source gym');
  otherGymId = await createTestGym('Line source other gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id IN (?, ?)', [gymId, otherGymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('lineSource (#3254)', () => {
  it('takes the builder\'s tag, a Membership Fee is the Plan\'s, an untagged line is null', () => {
    expect(lineSource({ kind: 'product', source: 'product' })).toBe('product');
    expect(lineSource({ kind: 'product', source: 'plan' })).toBe('plan');
    expect(lineSource({ kind: 'membership_fee' })).toBe('plan');
    expect(lineSource({ kind: 'product' })).toBeNull();
  });
});

describe('persisted Billing Event Lines carry their source (#3254)', () => {
  let eventId: number;
  let lockerName: string;
  let towelId: number;

  beforeAll(async () => {
    const locker = await product('Locker', 10);
    towelId = await product('Towel', 5);
    lockerName = (await db.query<any>('SELECT name FROM products WHERE id = ?', [locker])).rows[0].name;
    const planId = await plan(50, locker);
    const owner = await member();
    const setId = await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
      if (d.kind !== 'created') throw new Error(`expected created, got ${d.kind}`);
      await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 50, startsAt: TODAY });
      const scheduleId = await ensureSchedule(tx, {
        gymId, productSetId: d.productSet.id, key: 'plan', anchorDate: TODAY, cadenceInterval: 1, cadenceUnit: 'month',
      });
      await addProductSetService(tx, { gymId, productSetId: d.productSet.id, productId: towelId, quantity: 1, startsAt: TODAY, scheduleId });
      return d.productSet.id;
    });
    await db.transaction((tx) => materialiseScheduledEvents(tx, { gymId, productSetId: setId, today: TODAY }));
    // The event carrying the fee, the included Locker and the standalone Towel together.
    const { rows } = await db.query<any>(
      `SELECT be.id FROM billing_events be
        WHERE be.product_set_id = ? AND be.is_scheduled = 1
          AND (SELECT COUNT(DISTINCT kind) FROM billing_event_lines bel WHERE bel.billing_event_id = be.id) = 2
          AND EXISTS (SELECT 1 FROM billing_event_lines bel WHERE bel.billing_event_id = be.id AND bel.product_id = ?)
        ORDER BY be.billing_date LIMIT 1`, [setId, towelId]);
    expect(rows.length).toBe(1);
    eventId = Number(rows[0].id);
  });

  it('marks the fee and the included Product plan, and the standalone recurring Product product, on one event', async () => {
    const { rows } = await db.query<any>(
      'SELECT kind, product_id, item_name, source FROM billing_event_lines WHERE billing_event_id = ? ORDER BY id', [eventId]);
    const fee = rows.find((r: any) => r.kind === 'membership_fee');
    const locker = rows.find((r: any) => r.item_name === lockerName);
    const towel = rows.find((r: any) => Number(r.product_id) === towelId);
    expect(fee.source).toBe('plan');
    expect(locker.source).toBe('plan');
    expect(towel.source).toBe('product');
    expect(rows.every((r: any) => r.source === 'plan' || r.source === 'product')).toBe(true);
  });

  it('the staff Billing Event detail reports each line\'s source', async () => {
    const res = await request.get(`/payments/billing-events/${eventId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const sources = new Map(res.body.lines.map((l: any) => [l.item_name, l.source]));
    expect(sources.get(lockerName)).toBe('plan');
    expect(res.body.lines.find((l: any) => l.kind === 'membership_fee').source).toBe('plan');
    expect(res.body.lines.some((l: any) => l.source === 'product')).toBe(true);
  });

  it('another gym cannot read the event', async () => {
    await createTestMembership(otherGymId, 'admin');
    const res = await request.get(`/payments/billing-events/${eventId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGymId);
    expect(res.status).toBe(404);
  });
});
