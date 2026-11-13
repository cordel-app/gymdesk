// #1661 stage 1 — a recurring Product bought for a member lives only as a line
// of their ProductSet, yet `GET /members/:id/products` must list it beside the
// one-time purchases, read from the version's frozen line.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';
import { legacyProductInsert } from './legacyProductFixture';

let gymId: string;
let otherGymId: string;
let memberId: number;
let productId: number;

const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function setWithLine(status: 'active' | 'superseded'): Promise<number> {
  const s = await db.query(
    `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at) VALUES (?, ?, ?, '2026-01-01')`,
    [gymId, memberId, status]);
  await legacyProductInsert(`INSERT INTO member_products_recurrent_snapshot
       (gym_id, product_set_id, product_id, quantity, starts_at, item_name, item_type,
        item_billing_frequency, unit_price, list_unit_price, direct_discount_percent)
     VALUES (?, ?, ?, 2, '2026-01-01', 'Locker Rental', 'service', 'month', 8.00, 10.00, 20)`,
    [gymId, s.insertId, productId]);
  // #2126 stage 3g: the list reads `product_periodical_snapshots`, which the dual-write keeps equal.
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

  // #2126 stage 3g: a purchase's applied Promotions are read from `product_promotion_snapshots`,
  // in the order they were applied, still identified by the purchase's own application ids.
  it('lists every Promotion frozen onto a purchase, in application order (#2126 stage 3g)', async () => {
    const promo = async (name: string) => (await db.query<any>(
      `INSERT INTO promotions
         (gym_id, name, starts_at, ends_at, lifecycle_status, applies_to, stackable,
          only_applicable_for_new_members, free_months, paid_months, bonus_months)
       VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 'product', 1, 0, 0, 6, 0)`,
      [gymId, name])).insertId;
    const first = await promo('Spring 50');
    const second = await promo('Loyalty 20');
    const dayPass = (await db.query<any>(
      `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount)
       VALUES (?, 'Day Pass', 'other', 'once', 'active', 'public', 'EUR', '100.00')`, [gymId])).insertId;
    const purchaseId = (await legacyProductInsert(`INSERT INTO member_products_oneoff_snapshot
         (gym_id, member_id, product_id, status, product_name, product_type, billing_frequency,
          amount, currency, list_price, created_by)
       VALUES (?, ?, ?, 'active', 'Day Pass', 'other', 'once', '40.00', 'EUR', '100.00', 'Test')`,
      [gymId, memberId, dayPass])).insertId;
    const applicationIds: number[] = [];
    for (const [promotionId, name, regular, final] of [[first, 'Spring 50', 100, 50], [second, 'Loyalty 20', 50, 40]] as const) {
      applicationIds.push((await legacyProductInsert(`INSERT INTO member_products_oneoff_promotion_snapshot
           (gym_id, member_product_id, promotion_id, promotion_name, benefit_action, benefit_value,
            regular_amount, final_amount)
         VALUES (?, ?, ?, ?, 'percentage_discount', 20, ?, ?)`,
        [gymId, purchaseId, promotionId, name, regular, final])).insertId);
    }

    const res = await auth(request.get(`/members/${memberId}/products`));
    expect(res.status).toBe(200);
    const item = (res.body.items as any[]).find((i) => i.id === purchaseId);
    expect(item.promotions.map((p: any) => [p.id, p.promotion_name, p.regular_amount, p.final_amount]))
      .toEqual([[applicationIds[0], 'Spring 50', 100, 50], [applicationIds[1], 'Loyalty 20', 50, 40]]);
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
