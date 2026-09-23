// #635 stage 4 — Charge Benefits retired (§2, and Q4's "clean up completely
// these legacy structure").
//
// Integration tests: the point of this file is that the concept is gone from
// the real Express + MySQL stack, not merely hidden — the endpoints no longer
// route, neither payload carries the field, and both tables are dropped
// (migration 176). The rest of the Plan and the Assigned Plan must be
// unaffected, which the regression cases at the bottom pin down.

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

async function createPlan(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`,
    [gymId, name],
  );
  return insertId;
}

async function createMember(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
    [gymId, name, `${name.toLowerCase().replace(/\s+/g, '.')}.${Date.now()}@example.com`],
  );
  return insertId;
}

async function createSellableItem(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_charges (gym_id, name, type, billing_frequency, amount, status, is_system, currency)
     VALUES (?, ?, 'service', 'month', 20.00, 'active', 0, 'EUR')`,
    [gymId, name],
  );
  return insertId;
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name],
  );
  return Number(rows[0].n) > 0;
}

describe('Charge Benefits are retired (#635 stage 4)', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Charge Benefits Retired Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, 'Charge Benefits Retired Plan');
  });

  // ── The schema ──

  it('drops both legacy tables (migration 176)', async () => {
    expect(await tableExists('plan_charge_benefits')).toBe(false);
    expect(await tableExists('user_membership_charge_benefits')).toBe(false);
  });

  it('keeps promotion_charge_benefits, which is a different concept', async () => {
    // Promotions' own charge benefits (#626 removed their *editor*, not the
    // table, which `membership-promotions.ts` still reads for the Membership
    // Fee benefits the Billing Events range needs). Stage 4 must not take it.
    expect(await tableExists('promotion_charge_benefits')).toBe(true);
  });

  // ── The endpoints ──

  it('no longer routes GET /membership-plans/:id/charge-benefits', async () => {
    const res = await request
      .get(`/membership-plans/${planId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('no longer routes PUT /membership-plans/:id/charge-benefits', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send([]);
    expect(res.status).toBe(404);
  });

  // ── The payloads ──

  it('drops charge_benefits from GET /membership-plans/:id', async () => {
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.charge_benefits).toBeUndefined();
    // The replacement sections (stage 1) are still served.
    expect(Array.isArray(res.body.session_benefits)).toBe(true);
    expect(Array.isArray(res.body.oneoff_benefits)).toBe(true);
    expect(Array.isArray(res.body.periodical_benefits)).toBe(true);
  });

  it('drops charge_benefits from GET /membership-plans (list)', async () => {
    const res = await request
      .get('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    for (const plan of res.body) {
      expect(plan.charge_benefits).toBeUndefined();
    }
  });

  it('leaves the Plan Billing Forecast with the fee alone — no benefit lines', async () => {
    await db.query(
      `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from)
       VALUES (?, ?, 55, CURDATE())`,
      [gymId, planId],
    );
    await db.query(
      `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
       VALUES (?, ?, 1, 'month')`,
      [gymId, planId],
    );

    const res = await request
      .get(`/membership-plans/${planId}/billing-forecast`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    for (const event of res.body.events) {
      expect(event.lines.every((l: any) => l.benefit === undefined)).toBe(true);
    }
    expect(res.body.events[0].total).toBe(55);
  });

  // ── The Assigned Plan ──

  it('assigns a Plan without the charge-benefit snapshot, and still captures the #635 snapshot', async () => {
    const memberId = await createMember(gymId, 'CB Retired Assignee');
    const itemId = await createSellableItem(gymId, 'CB Retired Locker');
    // A Period Benefit on the Plan — the replacement concept, which the
    // assignment must still freeze (stage 2/3).
    await request
      .put(`/membership-plans/${planId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: itemId, quantity: 1 }] });

    const assign = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-01-01' });
    expect(assign.status).toBe(201);

    const detail = await request
      .get(`/user-memberships/${assign.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(detail.status).toBe(200);
    expect(detail.body.charge_benefits).toBeUndefined();
    expect(detail.body.snapshot.snapshot_captured).toBe(true);
    expect(detail.body.snapshot.periodical_benefits).toHaveLength(1);
    expect(detail.body.snapshot.periodical_benefits[0].item_name).toBe('CB Retired Locker');
  });

  it('duplicates a Plan, carrying its Benefit sections and no charge benefits', async () => {
    const res = await request
      .post(`/membership-plans/${planId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.charge_benefits).toBeUndefined();
    expect(res.body.periodical_benefits).toHaveLength(1);
  });

  // ── Tenant isolation on the surfaces this PR touched ──

  it("404s another gym's plan on the endpoints that replaced charge benefits", async () => {
    const otherGym = await createTestGym('Charge Benefits Retired Gym B');
    const otherPlan = await createPlan(otherGym, 'Other Gym Plan');
    const res = await request
      .get(`/membership-plans/${otherPlan}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
