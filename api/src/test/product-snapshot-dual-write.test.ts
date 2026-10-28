// #2126 stage 2: the Product snapshot tables follow every legacy write, in the same transaction.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { db } from '../infra/db';
import { syncProductSnapshotForPurchase } from '../api/product-snapshot-sync';
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestDraftAssignment, createTestGym,
  createTestMembership, request,
} from './helpers';

const require = createRequire(import.meta.url);
const migration = require('../infra/migrations/348_product_snapshots.js');
const knex = require('knex')({ client: 'mysql2', connection: process.env.DATABASE_URL });

afterAll(async () => {
  await knex.destroy();
  await cleanupTestGyms();
  await db.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let gymId: string;
let owner: number;
let productId: number;
let umId: number;
let setId: number;

const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const lines = async (set: number) =>
  (await db.query<any>('SELECT * FROM product_periodical_snapshots WHERE gym_id = ? AND product_set_id = ?', [gymId, set])).rows;
const noBackfillDrift = async () => {
  const counts = await migration.backfillProductSnapshots(knex);
  expect(Object.values(counts).every((n) => n === 0)).toBe(true);
};

beforeAll(async () => {
  gymId = await createTestGym('Product Dual Write Gym');
  await createTestMembership(gymId, 'admin');
  owner = (await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Owner', `pdw-${uniq()}@test.com`])).insertId as number;
  const planId = (await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'staff_only', '1')`, [gymId, `PDW-Plan-${uniq()}`])).insertId as number;
  productId = (await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, amount, status, is_system, currency)
     VALUES (?, ?, 'service', 'month', 20.00, 'active', 0, 'EUR')`, [gymId, `PDW-Prod-${uniq()}`])).insertId as number;
  umId = await createTestDraftAssignment(gymId, owner, planId, { config: { membership_fee_price: 0 } as any });
  setId = (await db.query<any>('SELECT id FROM product_sets WHERE user_membership_id = ?', [umId])).rows[0].id;
});

describe('recurring Product lines follow the Draft (#2126 stage 2)', () => {
  let lineId: number;

  it('adding, re-quantifying and removing a line is mirrored', async () => {
    const add = await auth(request.post(`/product-sets/${setId}/services`)).send({ product_id: productId, quantity: 1 });
    expect(add.status).toBeLessThan(300);
    let rows = await lines(setId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('draft');
    expect(rows[0].member_id).toBe(owner);
    lineId = rows[0].source_id;

    const qty = await auth(request.put(`/product-sets/${setId}/services/${lineId}`)).send({ quantity: 3 });
    expect(qty.status).toBeLessThan(300);
    expect((await lines(setId))[0].quantity).toBe(3);
    await noBackfillDrift();

    const del = await auth(request.delete(`/product-sets/${setId}/services/${lineId}`));
    expect(del.status).toBeLessThan(300);
    expect(await lines(setId)).toHaveLength(0);
  });

  it('committing makes the line active and a successor inherits a copy', async () => {
    const add = await auth(request.post(`/product-sets/${setId}/services`)).send({ product_id: productId, quantity: 2 });
    expect(add.status).toBeLessThan(300);
    await activateTestAssignment(gymId, umId);
    expect((await lines(setId))[0].status).toBe('active');

    const draft = await auth(request.post('/product-sets/draft')).send({ member_id: owner });
    expect(draft.status).toBeLessThan(300);
    const newSet = Number(draft.body.product_set_id ?? draft.body.id);
    const copy = await lines(newSet);
    expect(copy).toHaveLength(1);
    expect(copy[0].is_inherited).toBe(1);
    expect(copy[0].status).toBe('draft');
    expect(copy[0].quantity).toBe(2);
    await noBackfillDrift();
  });
});

describe('purchases follow the legacy purchase row (#2126 stage 2)', () => {
  it('a purchase, its Promotion and every later change are mirrored, and a discarded draft leaves nothing', async () => {
    const promo = (await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
         only_applicable_for_new_members, free_months, paid_months, bonus_months, applies_to)
       VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, 0, 0, 6, 0, 'product')`, [gymId, `PDW-Promo-${uniq()}`])).insertId as number;
    const id = (await db.query(
      `INSERT INTO member_products_oneoff_snapshot
         (gym_id, member_id, product_id, status, product_name, product_type, billing_frequency, units, amount, currency)
       VALUES (?, ?, ?, 'draft', 'Pack', 'sessions', 'once', 10, 90, 'EUR')`, [gymId, owner, productId])).insertId as number;
    await db.query(
      `INSERT INTO member_products_oneoff_promotion_snapshot
         (gym_id, member_product_id, promotion_id, promotion_name, benefit_action, benefit_value, regular_amount, final_amount)
       VALUES (?, ?, ?, 'Offer', 'percentage_discount', 10.00, 100.00, 90.00)`, [gymId, id, promo]);
    await db.transaction((tx) => syncProductSnapshotForPurchase(tx, gymId, id));

    const one = async (table: string) => (await db.query<any>(`SELECT * FROM ${table} WHERE source_id = ?`, [id])).rows;
    expect((await one('product_session_snapshots'))[0].status).toBe('draft');
    expect(await one('product_oneoff_snapshots')).toHaveLength(0);
    const { rows: promos } = await db.query<any>('SELECT * FROM product_promotion_snapshots WHERE gym_id = ? AND source_purchase_promotion_id IS NOT NULL AND member_id = ?', [gymId, owner]);
    expect(promos).toHaveLength(1);

    await db.query("UPDATE member_products_oneoff_snapshot SET status = 'active', valid_until = '2027-01-31' WHERE id = ?", [id]);
    await db.transaction((tx) => syncProductSnapshotForPurchase(tx, gymId, id));
    const [snap] = await one('product_session_snapshots');
    expect(snap.status).toBe('active');
    expect(String(snap.valid_until)).toContain('2027');
    await noBackfillDrift();

    await db.query('DELETE FROM member_products_oneoff_promotion_snapshot WHERE member_product_id = ?', [id]);
    await db.query('DELETE FROM member_products_oneoff_snapshot WHERE id = ?', [id]);
    await db.transaction((tx) => syncProductSnapshotForPurchase(tx, gymId, id));
    expect(await one('product_session_snapshots')).toHaveLength(0);
  });
});
