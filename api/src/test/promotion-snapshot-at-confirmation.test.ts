// #2624 stage 4 (§8) — a Promotion applied to a Draft is captured when the Draft
// is confirmed (Save & Pay, or the free commit), from the Promotion as it stands
// then; after confirmation the snapshot is the historical record and an edit of
// the Promotion moves nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const api = (method: 'post' | 'put' | 'get' | 'delete', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function createMember(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'PSC Member', `psc-${uniq()}@test.com`]);
  return Number(insertId);
}

async function createPlan(price: number | null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `PSC Plan ${uniq()}`]);
  if (price != null) {
    await db.query(
      `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
       VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
    await db.query(
      `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
       VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  }
  return Number(insertId);
}

async function createPromo(planId: number, percent: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                             only_applicable_for_new_members, paid_months)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, 0, 12)`, [gymId, `PSC Promo ${uniq()}`]);
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, insertId, planId]);
  await db.query(
    `INSERT INTO promotion_membership_fee_benefits (gym_id, promotion_id, duration_months, enabled, action, value)
     VALUES (?, ?, NULL, 1, 'percentage_discount', ?)`, [gymId, insertId, percent]);
  return Number(insertId);
}

async function editPromo(promoId: number, name: string, percent: number): Promise<void> {
  await db.query('UPDATE promotions SET name = ? WHERE id = ?', [name, promoId]);
  await db.query('UPDATE promotion_membership_fee_benefits SET value = ? WHERE promotion_id = ?', [percent, promoId]);
}

async function application(umId: number, promoId: number) {
  const { rows } = await db.query<any>(
    `SELECT ump.snapshot, ump.snapshot_confirmed_at FROM user_membership_promotions ump
       JOIN product_sets ps ON ps.id = ump.product_set_id
      WHERE ps.user_membership_id = ? AND ump.promotion_id = ? ORDER BY ump.id DESC LIMIT 1`, [umId, promoId]);
  const row = rows[0];
  const snap = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
  return { snap, confirmed: row.snapshot_confirmed_at != null };
}

async function assignDraft(memberId: number, planId: number): Promise<number> {
  const res = await api('post', '/user-memberships').send({
    member_id: memberId, membership_plan_id: planId, starts_at: new Date().toISOString().slice(0, 10) });
  expect(res.status).toBe(201);
  return Number(res.body.id);
}

beforeAll(async () => {
  gymId = await createTestGym('Promotion Snapshot Confirmation Gym');
  await createTestMembership(gymId, 'admin');
});

describe('Promotion snapshots are captured at confirmation (#2624 §8)', () => {
  it('Save & Pay captures the Promotion as it stands then, and prices the initial event from it', async () => {
    const planId = await createPlan(100);
    const promoId = await createPromo(planId, 10);
    const umId = await assignDraft(await createMember(), planId);
    expect((await api('post', `/user-memberships/${umId}/promotions`).send({ promotion_id: promoId })).status).toBe(201);

    // While a Draft the application is not confirmed.
    expect((await application(umId, promoId)).confirmed).toBe(false);

    await editPromo(promoId, 'PSC Edited Before Pay', 25);
    const res = await api('post', `/user-memberships/${umId}/save-and-pay`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_payment');

    const { snap, confirmed } = await application(umId, promoId);
    expect(confirmed).toBe(true);
    expect(snap.name).toBe('PSC Edited Before Pay');
    expect(Number(snap.membership_fee_benefits[0].value)).toBe(25);

    const { rows: events } = await db.query<any>(
      `SELECT be.amount FROM billing_events be JOIN product_sets ps ON ps.id = be.product_set_id
        WHERE ps.user_membership_id = ? AND be.event_type = 'payment_recorded'`, [umId]);
    expect(events).toHaveLength(1);
    expect(Number(events[0].amount)).toBeLessThanOrEqual(75);

    // After confirmation an edit of the Promotion moves nothing, and a retried
    // Save & Pay neither re-captures nor duplicates.
    await editPromo(promoId, 'PSC Edited After Pay', 50);
    expect((await api('post', `/user-memberships/${umId}/save-and-pay`).send({})).status).toBeGreaterThanOrEqual(400);
    const after = await application(umId, promoId);
    expect(after.snap.name).toBe('PSC Edited Before Pay');
    expect(Number(after.snap.membership_fee_benefits[0].value)).toBe(25);
    const { rows: count } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM user_membership_promotions ump JOIN product_sets ps ON ps.id = ump.product_set_id
        WHERE ps.user_membership_id = ? AND ump.promotion_id = ?`, [umId, promoId]);
    expect(Number(count[0].n)).toBe(1);
  });

  it('a free commit captures too, and the running plan keeps that snapshot', async () => {
    const planId = await createPlan(null);
    const promoId = await createPromo(planId, 10);
    const umId = await assignDraft(await createMember(), planId);
    expect((await api('post', `/user-memberships/${umId}/promotions`).send({ promotion_id: promoId })).status).toBe(201);

    await editPromo(promoId, 'PSC Free Edited Before Commit', 20);
    await activateTestAssignment(gymId, umId);
    const committed = await application(umId, promoId);
    expect(committed.confirmed).toBe(true);
    expect(committed.snap.name).toBe('PSC Free Edited Before Commit');

    await editPromo(promoId, 'PSC Free Edited Later', 40);
    const res = await api('get', `/user-memberships/${umId}/promotions`);
    expect(res.status).toBe(200);
    const shown = res.body.find((p: any) => Number(p.promotion_id) === promoId);
    expect(shown.promotion_name).toBe('PSC Free Edited Before Commit');
  });
});
