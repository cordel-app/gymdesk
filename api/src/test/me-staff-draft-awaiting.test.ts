// #2895 — a Draft staff created by assigning a Membership Plan reaches the member's cart
// read-only: the member sees it, but cannot pay, discard or change it, and cannot start a
// second purchase beside it, until staff choose Members App (which makes it Pending Payment).
// Integration: the real member routes against MySQL; nothing is charged or committed.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { productSetOfLegacyAssignmentSql } from '../domain/planAssignments';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;

const as = (clerk: string, method: 'get' | 'post' | 'put' | 'delete', path: string) => {
  // `/me` (meRouter) authenticates first, then falls through to the sub-router: two verifications.
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};

async function member(): Promise<{ clerk: string; id: number }> {
  const clerk = `me-sda-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'M', `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}

async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'public')`, [gymId, `Plan-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 30, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}

async function product(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'month', 'active', 'public', 'EUR', '10.00', 'inclusive')`, [gymId, `Locker-${uniq()}`]);
  return insertId;
}

/** A member holding a Draft staff created by assigning a plan; returns its Product Set id. */
async function memberWithStaffDraft(): Promise<{ clerk: string; id: number; setId: number }> {
  const m = await member();
  const umId = await createTestDraftAssignment(gymId, m.id, await plan());
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM product_sets WHERE gym_id = ? AND ${productSetOfLegacyAssignmentSql('?', 'product_sets')}`, [gymId, umId]);
  return { ...m, setId: Number(rows[0].id) };
}

async function setStatus(setId: number): Promise<string> {
  const { rows } = await db.query<{ status: string }>('SELECT status FROM product_sets WHERE id = ?', [setId]);
  return rows[0]?.status;
}

beforeAll(async () => {
  gymId = await createTestGym('Me Staff Draft Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('#2895 a staff assignment Draft in the Members App', () => {
  it('is readable and reported as awaiting staff setup', async () => {
    const m = await memberWithStaffDraft();
    const res = await as(m.clerk, 'get', `/me/product-sets/${m.setId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('in_cart');
    expect(res.body.awaiting_staff_setup).toBe(true);
    expect(res.body.cart.plans).toBe(1);
  });

  it('refuses Pay, free activation and Cancel without touching the Draft or writing billing rows', async () => {
    const m = await memberWithStaffDraft();
    for (const [method, path] of [
      ['post', `/me/product-sets/${m.setId}/save-and-pay`],
      ['post', `/me/product-sets/${m.setId}/activate`],
      ['delete', `/me/product-sets/${m.setId}`],
    ] as const) {
      const res = await as(m.clerk, method, path);
      expect(res.status, path).toBe(409);
      expect(res.body.error, path).toBe('awaiting_staff_setup');
    }
    expect(await setStatus(m.setId)).toBe('in_cart');
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ?', [gymId, m.id]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('refuses adding or removing items on it', async () => {
    const m = await memberWithStaffDraft();
    const added = await as(m.clerk, 'post', `/me/product-sets/${m.setId}/services`).send({ product_id: await product() });
    expect(added.status).toBe(409);
    expect(added.body.error).toBe('awaiting_staff_setup');
    const view = await as(m.clerk, 'get', `/me/product-sets/${m.setId}`);
    const snapshotId = view.body.plans[0].plan_snapshot_id;
    const removed = await as(m.clerk, 'delete', `/me/product-sets/${m.setId}/plans/${snapshotId}`);
    expect(removed.status).toBe(409);
    expect(removed.body.error).toBe('awaiting_staff_setup');
    expect((await as(m.clerk, 'get', `/me/product-sets/${m.setId}`)).body.cart).toEqual(view.body.cart);
  });

  it('answers a new purchase with awaiting_staff_setup, never "awaiting payment"', async () => {
    const m = await memberWithStaffDraft();
    const draft = await as(m.clerk, 'post', '/me/product-sets/draft');
    expect(draft.status).toBe(409);
    expect(draft.body.error).toBe('awaiting_staff_setup');
    const assign = await as(m.clerk, 'post', `/me/membership-plans/${await plan()}/assign`).send({});
    expect(assign.status).toBe(409);
    expect(assign.body.error).toBe('awaiting_staff_setup');
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM product_sets WHERE gym_id = ? AND owner_member_id = ?', [gymId, m.id]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('a member\'s own Draft is not affected', async () => {
    const m = await member();
    const draft = await as(m.clerk, 'post', '/me/product-sets/draft');
    expect(draft.status).toBe(201);
    const view = await as(m.clerk, 'get', `/me/product-sets/${draft.body.id}`);
    expect(view.body.awaiting_staff_setup).toBe(false);
    const add = await as(m.clerk, 'post', `/me/product-sets/${draft.body.id}/services`).send({ product_id: await product() });
    expect(add.status).toBe(200);
  });

  it('once staff move it to Pending Payment it is no longer awaiting staff setup', async () => {
    const m = await memberWithStaffDraft();
    await db.query("UPDATE product_sets SET status = 'pending_payment', pending_at = UTC_TIMESTAMP() WHERE id = ?", [m.setId]);
    const res = await as(m.clerk, 'get', `/me/product-sets/${m.setId}`);
    expect(res.body.status).toBe('pending_payment');
    expect(res.body.awaiting_staff_setup).toBe(false);
    // The usual in-flight refusal, which does mean a change awaiting the member's payment.
    const draft = await as(m.clerk, 'post', '/me/product-sets/draft');
    expect(draft.status).toBe(409);
    expect(draft.body.error).toBe('in_flight');
  });

  it('is another member\'s to nobody: 404 for a different member', async () => {
    const owner = await memberWithStaffDraft();
    const other = await member();
    const res = await as(other.clerk, 'post', `/me/product-sets/${owner.setId}/save-and-pay`);
    expect(res.status).toBe(404);
  });

  it('#3154: reports the plan\'s applied Promotion with its terms, and the review gives the Initial Payment', async () => {
    const m = await member();
    const planId = await plan();
    const umId = await createTestDraftAssignment(gymId, m.id, planId);
    const { insertId: promoId } = await db.query(
      `INSERT INTO promotions (gym_id, name, description, starts_at, ends_at, lifecycle_status, stackable,
                               only_applicable_for_new_members, free_months, paid_months, bonus_months)
       VALUES (?, ?, 'Half price to start', '2026-01-01', '2099-12-31', 'active', 1, 0, 0, 3, 0)`, [gymId, `Welcome-${uniq()}`]);
    await db.query('INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promoId, planId]);
    await db.query(`INSERT INTO promotion_membership_fee_benefits (gym_id, promotion_id, enabled, action, value, duration_months)
                    VALUES (?, ?, 1, 'percentage_discount', 50, 2)`, [gymId, promoId]);
    // An earlier `as()` call may have queued a member identity its request never consumed; the
    // staff call must authenticate as the admin, so drop any leftover before it.
    vi.mocked(verifyToken).mockReset().mockResolvedValue({ sub: 'test-user-id' } as any);
    const apply = await request.post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ promotion_id: promoId });
    expect(apply.status).toBeLessThan(300);
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM product_sets WHERE gym_id = ? AND ${productSetOfLegacyAssignmentSql('?', 'product_sets')}`, [gymId, umId]);
    const setId = Number(rows[0].id);

    const view = await as(m.clerk, 'get', `/me/product-sets/${setId}`);
    expect(view.status).toBe(200);
    expect(view.body.awaiting_staff_setup).toBe(true);
    const promos = view.body.plans[0].promotions;
    expect(promos).toHaveLength(1);
    expect(promos[0]).toMatchObject({
      promotion_id: Number(promoId), description: 'Half price to start', paid_months: 3,
      membership_fee_benefit: { action: 'percentage_discount', value: 50, duration_months: 2 },
    });

    const review = await as(m.clerk, 'get', `/me/product-sets/${setId}/review`);
    expect(review.status).toBe(200);
    expect(typeof review.body.amount_due).toBe('number');
    expect(await setStatus(setId)).toBe('in_cart');
  });
});
