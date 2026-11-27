// #3487 — a cart that only changes what the member holds (staff removing a Membership Plan in the
// Admin App) is still the member's active cart: `GET /me/product-sets/:id` reports the change beside
// the cart's additions (`cart.changes`), so the Members App shows its cart card and blocks other
// actions from the cart's lifecycle rather than from how it was filled. Discarding the cart ends it.
// Integration: the real staff and member routes against MySQL.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { cartChangeCount } from '../domain/shoppingCart';
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestDraftAssignment, createTestGym,
  createTestMembership, request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const staff = (method: 'get' | 'post' | 'delete', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
/** A Members App call; `/me/product-sets` verifies twice (`/me` first, then its own router). */
const as = (clerk: string, method: 'get' | 'post', path: string, gym = gymId) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
};

async function memberWithRunningPlan(): Promise<{ clerk: string; memberId: number; umId: number }> {
  const clerk = `cco-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Change Only', `${clerk}@test.com`, clerk]);
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`, [gymId, `CCO Plan ${uniq()}`]);
  const umId = await createTestDraftAssignment(gymId, memberId, planId, { startsAt: '2026-01-01' });
  await activateTestAssignment(gymId, umId);
  return { clerk, memberId, umId };
}

async function memberCart(clerk: string): Promise<any | null> {
  const list = await as(clerk, 'get', '/me/product-sets');
  expect(list.status).toBe(200);
  const draft = list.body.find((r: any) => r.status === 'in_cart' && r.own);
  if (!draft) return null;
  const res = await as(clerk, 'get', `/me/product-sets/${draft.id}`);
  expect(res.status).toBe(200);
  return res.body;
}

beforeAll(async () => {
  gymId = await createTestGym('Cart Change Only Gym');
  otherGymId = await createTestGym('Cart Change Only Other Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('cartChangeCount (#3487)', () => {
  it('counts marked plans, removed lines and lines cancelled today, only on a cart version', () => {
    const plans = [{ status: 'to_be_canceled' }, { status: 'to_be_reactivated' }, { status: 'to_be_canceled_immediately' }, { status: 'active' }];
    expect(cartChangeCount({ status: 'in_cart', plans, removed_lines: [{}], lines_cancelling_now: 2 })).toBe(6);
    expect(cartChangeCount({ status: 'pending_payment', plans, removed_lines: [], lines_cancelling_now: 0 })).toBe(3);
    expect(cartChangeCount({ status: 'active', plans, removed_lines: [{}], lines_cancelling_now: 2 })).toBe(0);
    expect(cartChangeCount({ status: 'in_cart', plans: [{ status: 'active' }], removed_lines: [], lines_cancelling_now: 0 })).toBe(0);
  });
});

describe('a staff plan removal is the member\'s active cart (#3487)', () => {
  it('reports the change on the member\'s cart read, with nothing added', async () => {
    const m = await memberWithRunningPlan();
    expect(await memberCart(m.clerk)).toBeNull();

    expect((await staff('post', `/user-memberships/${m.umId}/mark-cancel`)).status).toBe(200);

    const cart = await memberCart(m.clerk);
    expect(cart).not.toBeNull();
    expect(cart.cart).toMatchObject({ plans: 0, products: 0, changes: 1 });
    // Staff opened it, so the member reads it as a cart the gym is preparing.
    expect(cart.awaiting_staff_setup).toBe(true);
    expect(cart.plans.find((p: any) => p.user_membership_id === m.umId)?.status).toBe('to_be_canceled');
  });

  it('is no cart once staff discard it', async () => {
    const m = await memberWithRunningPlan();
    expect((await staff('post', `/user-memberships/${m.umId}/mark-cancel`)).status).toBe(200);
    const cart = await memberCart(m.clerk);
    expect(cart.cart.changes).toBe(1);

    expect((await staff('delete', `/product-sets/${cart.id}`)).status).toBeLessThan(300);
    expect(await memberCart(m.clerk)).toBeNull();
  });

  it('is not readable from another gym', async () => {
    const m = await memberWithRunningPlan();
    expect((await staff('post', `/user-memberships/${m.umId}/mark-cancel`)).status).toBe(200);
    const cart = await memberCart(m.clerk);
    const res = await as(m.clerk, 'get', `/me/product-sets/${cart.id}`, otherGymId);
    expect([403, 404]).toContain(res.status);
  });
});
