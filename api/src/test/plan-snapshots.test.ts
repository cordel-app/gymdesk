// #2125 stage 1: the plan snapshot tables and their repeatable backfill, against real MySQL
// (since stage 17 the snapshots are written by the real writers; the backfill only has promotions left to copy).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { db } from '../infra/db';
import { syncPlanSnapshot } from '../api/plan-snapshot-sync';
import { cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership } from './helpers';

const require = createRequire(import.meta.url);
const migration = require('../infra/migrations/347_plan_snapshots.js');
const knex = require('knex')({ client: 'mysql2', connection: process.env.DATABASE_URL });

afterAll(async () => {
  await knex.destroy();
  await cleanupTestGyms();
  await db.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
async function member(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `ps-${uniq()}@test.com`]);
  return insertId as number;
}
async function plan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'staff_only', '1')`, [gymId, `PS-Plan-${uniq()}`]);
  return insertId as number;
}

let gymId: string;
let owner: number;
let kid: number;
let planA: number;
let planB: number;
let umA: number;
let umB: number;
let setA: number;
let setB: number;
let productId: number;
let promotionId: number;

beforeAll(async () => {
  gymId = await createTestGym('Plan Snapshots Gym');
  await createTestMembership(gymId, 'admin');
  owner = await member(gymId, 'Owner');
  kid = await member(gymId, 'Kid');
  planA = await plan(gymId);
  planB = await plan(gymId);
  umA = await createTestDraftAssignment(gymId, owner, planA, { config: { membership_fee_price: 49.9 } as any });
  const { rows: a } = await db.query<{ id: number }>('SELECT id FROM product_sets WHERE user_membership_id = ?', [umA]);
  setA = a[0].id;
  // A second plan of the same owner in a version of its own: the model must allow it.
  // (a member has one in-flight version at a time, so it is built for another and handed over)
  const other = await member(gymId, 'Other');
  umB = await createTestDraftAssignment(gymId, other, planB, { startsAt: '2030-01-01' });
  const { rows: b } = await db.query<{ id: number }>('SELECT id FROM product_sets WHERE user_membership_id = ?', [umB]);
  setB = b[0].id;
  await db.query("UPDATE product_sets SET status = 'superseded', owner_member_id = ? WHERE id = ?", [owner, setB]);
  await db.query('INSERT INTO product_set_members (gym_id, root_product_set_id, member_id, is_owner) SELECT gym_id, root_product_set_id, ?, 0 FROM product_sets WHERE id = ?', [kid, setA]);
  const { insertId: prod } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, amount, status, is_system, currency)
     VALUES (?, ?, 'service', 'month', 20.00, 'active', 0, 'EUR')`, [gymId, `PS-Prod-${uniq()}`]);
  productId = prod;
  const { insertId: promo } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
       only_applicable_for_new_members, free_months, paid_months, bonus_months)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, 0, 0, 6, 0)`, [gymId, `PS-Promo-${uniq()}`]);
  promotionId = promo;
  const { insertId: ump } = await db.query(
    `INSERT INTO user_membership_promotions (gym_id, promotion_id, status, snapshot, product_set_id, user_membership_id, revoked_at)
     VALUES (?, ?, 'revoked', JSON_OBJECT('name', 'Frozen name'), ?, ?, '2026-02-01 10:00:00')`,
    [gymId, promotionId, setA, umA]);
  await db.query(
    `INSERT INTO user_membership_promotion_session_snapshot (gym_id, user_membership_promotion_id, product_id, product_name, quantity, action, value)
     VALUES (?, ?, ?, 'Frozen grant', 3, 'fixed_price', 5.00)`, [gymId, ump, productId]);
  // The snapshots exist from creation (the legacy table the stage 1 backfill copied from is gone,
  // migration 356); the fixture's direct inserts (coverage, application, status) are re-derived.
  await db.transaction(async (tx) => {
    await syncPlanSnapshot(tx, gymId, setA);
    await syncPlanSnapshot(tx, gymId, setB);
  });
});

describe('plan snapshots (#2125)', () => {
  it('copies one snapshot per version with the frozen commercial values and owner as member', async () => {
    const { rows } = await db.query<any>('SELECT * FROM plan_snapshots WHERE gym_id = ? ORDER BY product_set_id', [gymId]);
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.product_set_id === setA);
    expect(a.member_id).toBe(owner);
    expect(a.membership_plan_id).toBe(planA);
    expect(Number(a.membership_fee_price)).toBeCloseTo(49.9);
    expect(a.status).toBe('draft');
    expect(rows.find((r) => r.product_set_id === setB).status).toBe('superseded');
  });

  it('allows one member to hold several plan snapshots and keeps status queryable without product_sets', async () => {
    await db.query("UPDATE plan_snapshots SET status = 'active' WHERE gym_id = ?", [gymId]);
    const { rows } = await db.query<any>("SELECT id FROM plan_snapshots WHERE gym_id = ? AND member_id = ? AND status = 'active'", [gymId, owner]);
    expect(rows).toHaveLength(2);
  });

  it('records the owner and the chain-covered member as beneficiaries', async () => {
    const { rows } = await db.query<any>(
      `SELECT b.member_id, b.is_owner FROM plan_snapshot_beneficiaries b
         JOIN plan_snapshots s ON s.id = b.plan_snapshot_id WHERE s.product_set_id = ? ORDER BY b.member_id`, [setA]);
    expect(rows.map((r) => [r.member_id, r.is_owner])).toEqual([[owner, 1], [kid, 0]].sort((x, y) => x[0] - y[0]));
  });

  // The included Products are the snapshot's own lines since migration 355 (no legacy table to backfill from).
  it('copies promotion applications under their snapshot', async () => {
    const { rows: promo } = await db.query<any>(
      `SELECT p.*, s.product_set_id FROM plan_promotion_snapshots p JOIN plan_snapshots s ON s.id = p.plan_snapshot_id WHERE p.gym_id = ?`, [gymId]);
    expect(promo).toHaveLength(1);
    expect(promo[0].product_set_id).toBe(setA);
    expect(promo[0].status).toBe('revoked');
    expect(promo[0].revoked_at).not.toBeNull();
    const { rows: grants } = await db.query<any>(
      'SELECT * FROM plan_promotion_session_product_snapshots WHERE gym_id = ?', [gymId]);
    expect(grants).toHaveLength(1);
    expect(grants[0].product_name).toBe('Frozen grant');
    expect(Number(grants[0].value)).toBe(5);
  });

  it('is repeatable: a second run inserts nothing and rewrites nothing', async () => {
    await db.query("UPDATE plan_snapshots SET membership_fee_price = 1.00 WHERE product_set_id = ?", [setA]);
    const counts = await migration.backfillPlanSnapshots(knex);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    const { rows } = await db.query<any>('SELECT membership_fee_price FROM plan_snapshots WHERE product_set_id = ?', [setA]);
    expect(Number(rows[0].membership_fee_price)).toBe(1);
  });
});
