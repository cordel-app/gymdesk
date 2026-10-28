// #2126 stage 1: the Product snapshot tables and their repeatable backfill, against real MySQL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership } from './helpers';

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
let setId: number;
let productId: number;
let sessionsPurchase: number;
let oneoffPurchase: number;
let lineId: number;
let applicationId: number;

async function product(name: string, type: string, frequency: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, amount, status, is_system, currency)
     VALUES (?, ?, ?, ?, 20.00, 'active', 0, 'EUR')`, [gymId, `${name}-${uniq()}`, type, frequency]);
  return insertId as number;
}

beforeAll(async () => {
  gymId = await createTestGym('Product Snapshots Gym');
  await createTestMembership(gymId, 'admin');
  const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Owner', `prs-${uniq()}@test.com`]);
  owner = m.insertId as number;
  const { insertId: plan } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'staff_only', '1')`, [gymId, `PRS-Plan-${uniq()}`]);
  const um = await createTestDraftAssignment(gymId, owner, plan as number);
  const { rows } = await db.query<{ id: number }>('SELECT id FROM product_sets WHERE user_membership_id = ?', [um]);
  setId = rows[0].id;

  productId = await product('Locker', 'service', 'month');
  const pack = await product('Pack', 'sessions', 'once');

  const buy = async (pid: number, name: string, type: string, units: number | null, amount: number) =>
    (await db.query(
      `INSERT INTO member_products_oneoff_snapshot
         (gym_id, member_id, product_id, status, product_name, product_type, billing_frequency, units, amount,
          currency, list_price, direct_discount_percent, direct_discount_amount, valid_until)
       VALUES (?, ?, ?, 'active', ?, ?, 'once', ?, ?, 'EUR', 100.00, 10.00, 10.00, '2027-01-31')`,
      [gymId, owner, pid, name, type, units, amount])).insertId as number;
  sessionsPurchase = await buy(pack, 'Frozen pack', 'sessions', 10, 90);
  oneoffPurchase = await buy(productId, 'Frozen towel', 'merchandise', null, 90);

  const { insertId: promo } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
       only_applicable_for_new_members, free_months, paid_months, bonus_months, applies_to)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, 0, 0, 6, 0, 'product')`, [gymId, `PRS-Promo-${uniq()}`]);
  await db.query(
    `INSERT INTO member_products_oneoff_promotion_snapshot
       (gym_id, member_product_id, promotion_id, promotion_name, benefit_action, benefit_value, regular_amount, final_amount)
     VALUES (?, ?, ?, 'Frozen offer', 'percentage_discount', 10.00, 100.00, 90.00)`, [gymId, sessionsPurchase, promo]);

  lineId = (await db.query(
    `INSERT INTO member_products_recurrent_snapshot
       (gym_id, product_id, quantity, starts_at, item_name, item_type, unit_price, item_billing_frequency, currency, product_set_id, line_ref)
     VALUES (?, ?, 2, '2026-03-01', 'Frozen locker', 'service', 12.50, 'month', 'EUR', ?, 1)`,
    [gymId, productId, setId])).insertId as number;
  applicationId = (await db.query(
    `INSERT INTO user_membership_promotions (gym_id, promotion_id, status, snapshot, product_set_id, recurrent_snapshot_id)
     VALUES (?, ?, 'applied', JSON_OBJECT('name', 'Frozen line offer'), ?, ?)`, [gymId, promo, setId, lineId])).insertId as number;
  await db.query(
    `INSERT INTO user_membership_promotion_periodical_snapshot
       (gym_id, user_membership_promotion_id, product_id, product_name, quantity, action, value)
     VALUES (?, ?, ?, 'Frozen grant', 3, 'fixed_price', 5.00)`, [gymId, applicationId, productId]);

  await migration.backfillProductSnapshots(knex);
});

describe('product snapshots backfill (#2126 stage 1)', () => {
  it('splits purchases by type, keeping the purchase as the record and the frozen values', async () => {
    const { rows: s } = await db.query<any>('SELECT * FROM product_session_snapshots WHERE gym_id = ?', [gymId]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ member_id: owner, product_set_id: null, member_product_id: sessionsPurchase, status: 'active', units: 10 });
    expect(Number(s[0].unit_price)).toBe(90);
    expect(Number(s[0].list_price)).toBe(100);
    const { rows: o } = await db.query<any>('SELECT * FROM product_oneoff_snapshots WHERE gym_id = ?', [gymId]);
    expect(o).toHaveLength(1);
    expect(o[0].member_product_id).toBe(oneoffPurchase);
    expect(o[0].product_name).toBe('Frozen towel');
  });

  it('copies a recurring line with the owner as member and the version status', async () => {
    const { rows } = await db.query<any>('SELECT * FROM product_periodical_snapshots WHERE gym_id = ?', [gymId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ member_id: owner, product_set_id: setId, source_id: lineId, product_name: 'Frozen locker', status: 'draft', quantity: 2 });
    expect(Number(rows[0].unit_price)).toBe(12.5);
  });

  it('copies purchase Promotions and line-owned applications under exactly one parent, with grants', async () => {
    const { rows } = await db.query<any>('SELECT * FROM product_promotion_snapshots WHERE gym_id = ? ORDER BY id', [gymId]);
    expect(rows).toHaveLength(2);
    const purchase = rows.find((r) => r.source_purchase_promotion_id);
    expect(purchase.product_session_snapshot_id).not.toBeNull();
    expect(purchase.product_periodical_snapshot_id).toBeNull();
    expect(Number(purchase.final_amount)).toBe(90);
    const app = rows.find((r) => r.source_application_id === applicationId);
    expect(app.product_periodical_snapshot_id).not.toBeNull();
    expect(app.promotion_name).toBe('Frozen line offer');
    const { rows: grants } = await db.query<any>('SELECT * FROM product_promotion_grant_snapshots WHERE gym_id = ?', [gymId]);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ grant_kind: 'periodical', product_name: 'Frozen grant', product_promotion_snapshot_id: app.id });
  });

  it('refuses a promotion snapshot with no parent or with two', async () => {
    const { rows } = await db.query<any>('SELECT * FROM product_promotion_snapshots WHERE gym_id = ? LIMIT 1', [gymId]);
    const r = rows[0];
    await expect(db.query(
      `INSERT INTO product_promotion_snapshots (gym_id, member_id, promotion_id) VALUES (?, ?, ?)`,
      [gymId, owner, r.promotion_id])).rejects.toThrow();
    const { rows: ids } = await db.query<any>('SELECT id FROM product_oneoff_snapshots WHERE gym_id = ?', [gymId]);
    await expect(db.query(
      `INSERT INTO product_promotion_snapshots (gym_id, member_id, promotion_id, product_oneoff_snapshot_id, product_session_snapshot_id)
       VALUES (?, ?, ?, ?, ?)`, [gymId, owner, r.promotion_id, ids[0].id, r.product_session_snapshot_id ?? r.product_periodical_snapshot_id])).rejects.toThrow();
  });

  it('is repeatable: a second run inserts nothing and rewrites nothing', async () => {
    await db.query("UPDATE product_periodical_snapshots SET unit_price = 1.00 WHERE source_id = ?", [lineId]);
    const counts = await migration.backfillProductSnapshots(knex);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    const { rows } = await db.query<any>('SELECT unit_price FROM product_periodical_snapshots WHERE source_id = ?', [lineId]);
    expect(Number(rows[0].unit_price)).toBe(1);
  });
});
