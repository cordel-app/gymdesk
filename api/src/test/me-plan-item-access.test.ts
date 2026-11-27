// #3504 — each included item of a plan in `GET /me/membership-plans` (and its
// `/:id/overview` re-quote) says whether it recurs and which Professional
// Services it gives access to, from the Product's own links.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

let gymId: string;
let userId: string;
let planId: number;
let lockerId: number;
let towelId: number;
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function product(name: string, frequency: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', ?, 'active', 'public', 'EUR', 10, 'inclusive')`,
    [gymId, name, frequency]);
  return insertId;
}
async function service(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)`, [gymId, name]);
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym();
  userId = `pia-${uniq()}`;
  await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'PIA Member', `${userId}@test.com`, userId]);
  await createTestMembership(gymId, 'member', userId);
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `PIA Plan ${uniq()}`]);
  planId = insertId;
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 40, '2020-01-01', 'active')`, [gymId, planId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  lockerId = await product(`Locker ${uniq()}`, 'month');
  towelId = await product(`Towel ${uniq()}`, 'once');
  await db.query(`INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity, mandatory)
                  VALUES (?, ?, ?, 2, 1)`, [gymId, planId, lockerId]);
  await db.query(`INSERT INTO membership_plan_oneoff (gym_id, membership_plan_id, product_id, quantity)
                  VALUES (?, ?, ?, 1)`, [gymId, planId, towelId]);
  const yoga = await service('Yoga Access');
  const spa = await service('Spa Access');
  const retired = await service('Retired Access');
  await db.query('UPDATE professional_services SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [retired]);
  for (const s of [yoga, spa, retired]) {
    await db.query('INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)',
      [gymId, lockerId, s]);
  }
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const h = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });
const asMember = () => vi.mocked(verifyToken).mockResolvedValueOnce({ sub: userId } as any);

describe('included item frequency and access (#3504)', () => {
  it('reports recurring and the linked live services, and an empty list for an item granting none', async () => {
    asMember();
    const res = await request.get('/me/membership-plans').set(h());
    expect(res.status).toBe(200);
    const plan = res.body.plans.find((p: any) => p.id === planId);
    const byId = new Map(plan.overview.products.map((p: any) => [p.product_id, p]));
    expect(byId.get(lockerId)).toMatchObject({ recurring: true, frequency: 'month', quantity: 2 });
    expect((byId.get(lockerId) as any).access.map((a: any) => a.name)).toEqual(['Spa Access', 'Yoga Access']);
    expect(byId.get(towelId)).toMatchObject({ recurring: false, access: [] });
  });

  it('carries the same fields on the overview re-quote', async () => {
    asMember();
    const res = await request.get(`/me/membership-plans/${planId}/overview`).set(h());
    expect(res.status).toBe(200);
    const locker = res.body.overview.products.find((p: any) => p.product_id === lockerId);
    expect(locker.recurring).toBe(true);
    expect(locker.access).toHaveLength(2);
  });
});
