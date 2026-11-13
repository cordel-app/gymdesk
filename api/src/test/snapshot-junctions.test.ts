// #2125 / #2126 M2 — the Product Set <-> snapshot junctions are written beside the snapshot columns and
// stay equal to them; nothing reads them yet (M3).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft } from '../api/product-sets';
import { snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { syncPlanSnapshot } from '../api/plan-snapshot-sync';
import { legacyProductInsert } from './legacyProductFixture';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

beforeAll(async () => { gymId = await createTestGym('Snapshot junctions gym'); });
afterAll(async () => { await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]); await cleanupTestGyms(); await db.end(); });

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `junc-${uniq()}@example.com`]);
  return insertId;
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '2')`, [gymId, `Junc-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 20, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
async function product(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, amount, status, is_system, currency)
     VALUES (?, ?, 'service', 'month', 10.00, 'active', 0, 'EUR')`, [gymId, `JP-${uniq()}`]);
  return Number(insertId);
}
const pairs = async (junction: string, col: string, setId: number) =>
  (await db.query<any>(`SELECT ${col} AS s FROM ${junction} WHERE product_set_id = ? ORDER BY ${col}`, [setId])).rows.map((r: any) => Number(r.s));

describe('Product Set <-> snapshot junctions (M2)', () => {
  it('a version\'s plan snapshot and recurring line are linked, and removing the line releases its link', async () => {
    const owner = await member();
    const planId = await plan();
    const productId = await product();
    const setId = await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
      if (d.kind !== 'created') throw new Error(d.kind);
      await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 20, startsAt: TODAY });
      return d.productSet.id;
    });

    const { rows: snaps } = await db.query<any>('SELECT id FROM plan_snapshots WHERE id IN (SELECT plan_snapshot_id FROM product_set_plan_snapshots WHERE product_set_id = ?)', [setId]);
    expect(snaps).toHaveLength(1);
    expect(await pairs('product_set_plan_snapshots', 'plan_snapshot_id', setId)).toEqual([Number(snaps[0].id)]);

    const { insertId: lineId } = await legacyProductInsert(`INSERT INTO member_products_recurrent_snapshot (gym_id, product_set_id, product_id, quantity, starts_at, item_name, item_type, item_billing_frequency, unit_price, currency)
       VALUES (?, ?, ?, 1, ?, 'Locker', 'service', 'month', 10.00, 'EUR')`, [gymId, setId, productId, TODAY]);
    const { rows: pers } = await db.query<any>('SELECT id FROM product_periodical_snapshots WHERE product_set_id = ?', [setId]);
    expect(pers).toHaveLength(1);
    expect(await pairs('product_set_periodical_snapshots', 'product_periodical_snapshot_id', setId)).toEqual([Number(pers[0].id)]);

    // A second sync adds nothing.
    await db.transaction((tx) => syncPlanSnapshot(tx, gymId, setId));
    expect(await pairs('product_set_periodical_snapshots', 'product_periodical_snapshot_id', setId)).toHaveLength(1);

    // Removing the line removes its snapshot and, by cascade, its link.
    await db.query('DELETE FROM product_periodical_snapshots WHERE id = ?', [lineId]);
    expect(await pairs('product_set_periodical_snapshots', 'product_periodical_snapshot_id', setId)).toEqual([]);
    expect((await db.query<any>('SELECT id FROM product_periodical_snapshots WHERE product_set_id = ?', [setId])).rows).toHaveLength(0);

    // Deleting the Product Set takes the plan snapshot and its junction row together.
    await db.query('DELETE FROM product_sets WHERE id = ?', [setId]);
    expect((await db.query<any>('SELECT id FROM product_set_plan_snapshots WHERE product_set_id = ?', [setId])).rows).toHaveLength(0);
  });

  it('a bought one-time Product snapshot is linked to the Billing Event of its payment request', async () => {
    const buyer = await member();
    const productId = await product();
    const { insertId: eventId } = await db.query(
      `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, billing_date)
       VALUES (?, ?, 'product_purchase', 'system', 10.00, ?)`, [gymId, buyer, TODAY]);
    const { insertId: requestId } = await db.query(
      `INSERT INTO payment_requests (gym_id, member_id, amount, status, source, billing_event_id)
       VALUES (?, ?, 10.00, 'pending', 'product_purchase', ?)`, [gymId, buyer, eventId]);
    const { insertId: purchaseId } = await legacyProductInsert(`INSERT INTO member_products_oneoff_snapshot (gym_id, member_id, product_id, product_name, product_type, billing_frequency, amount, currency, status, payment_request_id)
       VALUES (?, ?, ?, 'Towel', 'service', 'once', 10.00, 'EUR', 'pending_payment', ?)`, [gymId, buyer, productId, requestId]);

    const { rows } = await db.query<any>(
      `SELECT j.product_oneoff_snapshot_id FROM billing_event_oneoff_snapshots j WHERE j.billing_event_id = ?`, [eventId]);
    expect(rows).toHaveLength(1);

    // Discarding the purchase removes the snapshot and its link.
    await db.query('DELETE FROM product_oneoff_snapshots WHERE source_id = ?', [purchaseId]);
    expect((await db.query<any>('SELECT id FROM billing_event_oneoff_snapshots WHERE billing_event_id = ?', [eventId])).rows).toHaveLength(0);
  });

  it('a bought Sessions package snapshot is linked to the Billing Event of its payment request (#2126 stage 5a)', async () => {
    const buyer = await member();
    const { insertId: productId } = await db.query(
      `INSERT INTO products (gym_id, name, type, billing_frequency, amount, units, status, is_system, currency)
       VALUES (?, ?, 'sessions', 'once', 50.00, 5, 'active', 0, 'EUR')`, [gymId, `JS-${uniq()}`]);
    const { insertId: eventId } = await db.query(
      `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, billing_date)
       VALUES (?, ?, 'product_purchase', 'system', 50.00, ?)`, [gymId, buyer, TODAY]);
    const { insertId: requestId } = await db.query(
      `INSERT INTO payment_requests (gym_id, member_id, amount, status, source, billing_event_id)
       VALUES (?, ?, 50.00, 'pending', 'product_purchase', ?)`, [gymId, buyer, eventId]);
    const { insertId: purchaseId } = await legacyProductInsert(`INSERT INTO member_products_oneoff_snapshot (gym_id, member_id, product_id, product_name, product_type, billing_frequency, units, amount, currency, status, payment_request_id)
       VALUES (?, ?, ?, 'Five sessions', 'sessions', 'once', 5, 50.00, 'EUR', 'pending_payment', ?)`, [gymId, buyer, productId, requestId]);

    const { rows } = await db.query<any>(
      `SELECT s.source_id FROM billing_event_session_snapshots j
         JOIN product_session_snapshots s ON s.id = j.product_session_snapshot_id
        WHERE j.billing_event_id = ?`, [eventId]);
    expect(rows.map((r: any) => Number(r.source_id))).toEqual([Number(purchaseId)]);
    // Never in the one-off junction: a Sessions package keeps its own snapshot table.
    expect((await db.query<any>('SELECT id FROM billing_event_oneoff_snapshots WHERE billing_event_id = ?', [eventId])).rows).toHaveLength(0);

    // Linked once, and discarding the purchase removes the snapshot and its link.
    expect((await db.query<any>('SELECT id FROM billing_event_session_snapshots WHERE billing_event_id = ?', [eventId])).rows).toHaveLength(1);
    await db.query('DELETE FROM product_session_snapshots WHERE source_id = ?', [purchaseId]);
    expect((await db.query<any>('SELECT id FROM billing_event_session_snapshots WHERE billing_event_id = ?', [eventId])).rows).toHaveLength(0);
  });
});
