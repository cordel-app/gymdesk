// #1661 stage 1 — a recurring Product bought for a member lives only as a line
// of their ProductSet, yet `GET /members/:id/products` must list it beside the
// one-time purchases, read from the version's frozen line.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

let gymId: string;
let otherGymId: string;
let memberId: number;
let productId: number;

const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function setWithLine(status: 'active' | 'superseded'): Promise<number> {
  const s = await db.query(
    `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at) VALUES (?, ?, ?, '2026-01-01')`,
    [gymId, memberId, status]);
  await db.query('UPDATE product_sets SET root_product_set_id = id WHERE id = ?', [s.insertId]);
  await db.query(
    `INSERT INTO member_products_recurrent_snapshot
       (gym_id, product_set_id, product_id, quantity, starts_at, item_name, item_type,
        item_billing_frequency, unit_price, list_unit_price, direct_discount_percent)
     VALUES (?, ?, ?, 2, '2026-01-01', 'Locker Rental', 'service', 'month', 8.00, 10.00, 20)`,
    [gymId, s.insertId, productId]);
  return s.insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('Recurring lines gym');
  otherGymId = await createTestGym('Recurring lines other gym');
  await createTestMembership(gymId, 'admin');
  const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Locker Member', `rl-${Date.now()}@test.com`]);
  memberId = m.insertId;
  const p = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, 'Locker Rental', 'service', 'month', 'active', 'public', 0, 'EUR', '10.00', 'inclusive')`, [gymId]);
  productId = p.insertId;
});

afterAll(async () => {
  await db.query('DELETE FROM member_products_recurrent_snapshot WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('GET /members/:id/products — recurring lines (#1661)', () => {
  it('lists a recurring line of the Active set from its frozen prices; a superseded set is not listed', async () => {
    await setWithLine('superseded');
    await setWithLine('active');
    const res = await auth(request.get(`/members/${memberId}/products`));
    expect(res.status).toBe(200);
    const rows = (res.body.items) as any[];
    const recurring = rows.filter((r) => r.source === 'recurring');
    expect(recurring).toHaveLength(1);
    expect(recurring[0]).toMatchObject({
      product_name: 'Locker Rental', status: 'active', amount: 16, list_price: 20,
      direct_discount_percent: 20, product_id: productId,
    });
    expect(recurring[0].id).toBeLessThan(0);
  });

  it('is tenant scoped', async () => {
    const res = await auth(request.get(`/members/${memberId}/products`), otherGymId);
    expect([403, 404]).toContain(res.status);
  });

  it('requires authentication', async () => {
    const res = await request.get(`/members/${memberId}/products`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});
