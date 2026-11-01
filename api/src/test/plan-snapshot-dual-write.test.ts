// #2125 stage 2: the plan snapshot tables follow every ProductSet write, in the same transaction.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { db } from '../infra/db';
import { syncPlanSnapshot } from '../api/plan-snapshot-sync';
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestDraftAssignment, createTestGym,
  createTestMembership, request,
} from './helpers';

const require = createRequire(import.meta.url);
const migration = require('../infra/migrations/347_plan_snapshots.js');
const knex = require('knex')({ client: 'mysql2', connection: process.env.DATABASE_URL });

afterAll(async () => {
  await knex.destroy();
  await cleanupTestGyms();
  await db.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const member = async (gymId: string, name: string) =>
  (await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, name, `dw-${uniq()}@test.com`])).insertId as number;

let gymId: string;
let owner: number;
let kid: number;
let planId: number;
let productId: number;
let umId: number;
let setId: number;

const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const snapshots = async (set: number) =>
  (await db.query<any>('SELECT * FROM plan_snapshots WHERE gym_id = ? AND product_set_id = ?', [gymId, set])).rows;

beforeAll(async () => {
  gymId = await createTestGym('Dual Write Gym');
  await createTestMembership(gymId, 'admin');
  owner = await member(gymId, 'Owner');
  kid = await member(gymId, 'Kid');
  planId = (await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'staff_only', 'family')`, [gymId, `DW-Plan-${uniq()}`])).insertId as number;
  productId = (await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, amount, status, is_system, currency)
     VALUES (?, ?, 'service', 'month', 20.00, 'active', 0, 'EUR')`, [gymId, `DW-Prod-${uniq()}`])).insertId as number;
  umId = await createTestDraftAssignment(gymId, owner, planId, { config: { membership_fee_price: 0 } as any });
  setId = (await db.query<any>('SELECT id FROM product_sets WHERE user_membership_id = ?', [umId])).rows[0].id;
});

describe('plan snapshot dual-write (#2125 stage 2)', () => {
  it('a new Draft assignment has its snapshot at birth, owner as the only beneficiary', async () => {
    const rows = await snapshots(setId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('draft');
    expect(rows[0].is_inherited).toBe(0);
    expect(rows[0].member_id).toBe(owner);
    const { rows: ben } = await db.query<any>('SELECT member_id FROM plan_snapshot_beneficiaries WHERE plan_snapshot_id = ?', [rows[0].id]);
    expect(ben.map((b) => b.member_id)).toEqual([owner]);
  });

  it('a Draft edit through the API is reflected: covered member and fee', async () => {
    const add = await auth(request.post(`/product-sets/${setId}/members`)).send({ member_id: kid });
    expect(add.status).toBe(200);
    const fee = await auth(request.put(`/product-sets/${setId}/fee`)).send({ membership_fee_price: 33.5, discount_reason: 'Negotiated' });
    expect(fee.status).toBeLessThan(300);
    const [snap] = await snapshots(setId);
    const { rows: ben } = await db.query<any>('SELECT member_id FROM plan_snapshot_beneficiaries WHERE plan_snapshot_id = ? ORDER BY member_id', [snap.id]);
    expect(ben.map((b) => b.member_id).sort()).toEqual([owner, kid].sort());
    expect(Number(snap.membership_fee_price)).toBeCloseTo(33.5);
    expect(snap.discount_reason).toBe('Negotiated');
    const rm = await auth(request.delete(`/product-sets/${setId}/members/${kid}`));
    expect(rm.status).toBe(200);
    const { rows: after } = await db.query<any>('SELECT member_id FROM plan_snapshot_beneficiaries WHERE plan_snapshot_id = ?', [snap.id]);
    expect(after.map((b) => b.member_id)).toEqual([owner]);
  });

  it('committing makes the snapshot active; the dual-written rows equal what the backfill would write', async () => {
    await activateTestAssignment(gymId, umId);
    expect((await snapshots(setId))[0].status).toBe('active');
    const counts = await migration.backfillPlanSnapshots(knex);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it('a pause of the assignment is reflected without a product_sets join', async () => {
    const { recordStatusChange } = await import('../api/billing-events');
    await db.transaction(async (tx) => {
      await tx.query("UPDATE user_memberships SET status = 'paused' WHERE id = ?", [umId]);
      await recordStatusChange(tx, { gymId, userMembershipId: umId, memberId: owner, previousStatus: 'active', newStatus: 'paused', source: 'admin', actorUserId: null } as any);
    });
    expect((await snapshots(setId))[0].status).toBe('paused');
    await db.query("UPDATE user_memberships SET status = 'active' WHERE id = ?", [umId]);
    const { syncPlanSnapshot } = await import('../api/plan-snapshot-sync');
    await db.transaction((tx) => syncPlanSnapshot(tx, gymId, setId));
    expect((await snapshots(setId))[0].status).toBe('active');
  });

  it('a successor version is inherited, and activating it supersedes the predecessor snapshot', async () => {
    await db.query(
      `INSERT INTO plan_oneoff_snapshots (gym_id, product_id, quantity, item_name, item_type, unit_price, plan_snapshot_id)
       VALUES (?, ?, 1, 'Frozen oneoff', 'fee', 5.00, (SELECT id FROM plan_snapshots WHERE product_set_id = ? ORDER BY id LIMIT 1))`,
      [gymId, productId, setId]);
    const draft = await auth(request.post('/product-sets/draft')).send({ member_id: owner });
    expect(draft.status).toBeLessThan(300);
    const newSet = Number(draft.body.product_set_id ?? draft.body.id);
    const [copy] = await snapshots(newSet);
    expect(copy.is_inherited).toBe(1);
    expect(copy.status).toBe('draft');
    const { rows: items } = await db.query<any>('SELECT item_name FROM plan_oneoff_snapshots WHERE plan_snapshot_id = ?', [copy.id]);
    expect(items.map((i) => i.item_name)).toEqual(['Frozen oneoff']);

    const act = await auth(request.post(`/product-sets/${newSet}/activate`)).send({});
    expect(act.status).toBeLessThan(300);
    expect((await snapshots(newSet))[0].status).toBe('active');
    expect((await snapshots(setId))[0].status).toBe('superseded');
  });
});
