// #2624 stage 2 (§4/§5) — an Assigned Plan's Mandatory line can never leave it:
// the server refuses removing one, and refuses turning one Optional (the same
// removal in two requests), on the assignment's section routes and on the
// ProductSet Draft routes, which share one writer. An Optional line may be
// removed, and either kind keeps taking its Direct Discount (%).
// Integration: the real routers against MySQL.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, activateAssignment, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';
import { mandatoryLineRefusal } from '../api/product-set-draft';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const today = () => new Date().toISOString().slice(0, 10);

let gymId: string;
let gymB: string;
let planId: number;
let mandatoryId: number;
let optionalId: number;

async function product(name: string, amount: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, is_system)
     VALUES (?, ?, 'service', ?, 'EUR', 'month', 'active', 0)`, [gymId, name, amount]);
  return insertId;
}

async function assign(activate: boolean): Promise<number> {
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'ML Member', `ml-${uniq()}@test.com`]);
  const res = await request.post('/user-memberships')
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
    .send({ member_id: memberId, membership_plan_id: planId, starts_at: today() });
  expect(res.status).toBe(201);
  if (activate) await activateAssignment(gymId, res.body.id);
  return res.body.id;
}

const put = (gym: string, umId: number, items: unknown[]) => request
  .put(`/user-memberships/${umId}/periodical-benefits`)
  .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym)
  .send({ items });

const lines = async (umId: number) => (await request
  .get(`/user-memberships/${umId}/periodical-benefits`)
  .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)).body as any[];

beforeAll(async () => {
  gymId = await createTestGym('Mandatory Lines Gym');
  gymB = await createTestGym('Mandatory Lines Gym B');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(gymB, 'admin');
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `ML-${uniq()}`]);
  planId = insertId;
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 50, '2020-01-01', 'active')`, [gymId, planId]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  mandatoryId = await product(`Locker ${uniq()}`, 20);
  optionalId = await product(`Towel ${uniq()}`, 10);
  await db.query(
    `INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity, mandatory)
     VALUES (?, ?, ?, 1, 1), (?, ?, ?, 1, 0)`,
    [gymId, planId, mandatoryId, gymId, planId, optionalId]);
});

describe('Assigned Plan Mandatory lines (#2624 stage 2)', () => {
  for (const activate of [false, true]) {
    describe(activate ? 'on an Active plan' : 'on a Draft', () => {
      let umId: number;
      beforeAll(async () => { umId = await assign(activate); });

      it('refuses removing a Mandatory line and changes nothing', async () => {
        const res = await put(gymId, umId, [{ product_id: optionalId, quantity: 1 }]);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('mandatory_line_not_removable');
        expect((await lines(umId)).map((l) => l.product_id).sort()).toEqual([mandatoryId, optionalId].sort());
      });

      it('refuses turning a Mandatory line Optional', async () => {
        const res = await put(gymId, umId, [
          { product_id: mandatoryId, quantity: 1, mandatory: false }, { product_id: optionalId, quantity: 1 },
        ]);
        expect(res.status).toBe(409);
        expect((await lines(umId)).find((l) => l.product_id === mandatoryId).mandatory).toBe(true);
      });

      it('sets the Direct Discount (%) of a Mandatory line', async () => {
        const res = await put(gymId, umId, [
          { product_id: mandatoryId, quantity: 1, direct_discount_percent: 25 }, { product_id: optionalId, quantity: 1 },
        ]);
        expect(res.status).toBe(200);
        const locker = (await lines(umId)).find((l) => l.product_id === mandatoryId);
        expect(locker.direct_discount_percent).toBe(25);
        expect(locker.final_price_incl_tax).toBe(15);
      });

      it('removes an Optional line', async () => {
        const res = await put(gymId, umId, [{ product_id: mandatoryId, quantity: 1 }]);
        expect(res.status).toBe(200);
        expect((await lines(umId)).map((l) => l.product_id)).toEqual([mandatoryId]);
      });
    });
  }

  it('is tenant-isolated', async () => {
    const umId = await assign(false);
    const res = await put(gymB, umId, []);
    expect([400, 404]).toContain(res.status);
    expect((await lines(umId)).length).toBe(2);
  });
});

describe('mandatoryLineRefusal()', () => {
  const current = [
    { product_id: 1, mandatory: true, item_name: 'Locker' },
    { product_id: 2, mandatory: false, item_name: 'Towel' },
  ];
  it('allows keeping every Mandatory line and dropping an Optional one', () => {
    expect(mandatoryLineRefusal(current, [{ product_id: 1 }])).toBeNull();
    expect(mandatoryLineRefusal(current, [{ product_id: 1, mandatory: true }, { product_id: 3 }])).toBeNull();
  });
  it('refuses dropping or un-mandating a Mandatory line', () => {
    expect(mandatoryLineRefusal(current, [{ product_id: 2 }])).toMatch(/Locker.*removed/);
    expect(mandatoryLineRefusal(current, [{ product_id: 1, mandatory: false }])).toMatch(/optional/);
  });
});
