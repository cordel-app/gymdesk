// #3168 — confirming a Promotion that requires other Products adds them with the chosen
// Product, and the Products table's own read (`GET /members/:id/products`) lists every one of
// them, with the Promotion, straight after the confirmed save. Without the confirmation nothing
// is written. Integration against real MySQL; nothing is charged.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function product(name: string, frequency = 'once'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', ?, 'active', 'public', 0, 'EUR', '40.00', 'inclusive')`, [gymId, name, frequency]);
  return Number(insertId);
}

async function promotionRequiring(productIds: number[], table = 'promotion_oneoff'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, applies_to, stackable,
        only_applicable_for_new_members, free_months, paid_months, bonus_months)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 'product', 1, 0, 0, 6, 0)`, [gymId, `Promo-${uniq()}`]);
  for (const id of productIds) {
    await db.query(
      `INSERT INTO ${table} (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`, requirement)
       VALUES (?, ?, ?, 1, 'percentage_discount', 50, 'mandatory')`, [gymId, insertId, id]);
  }
  return Number(insertId);
}

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Req Member', `req-${uniq()}@t.com`]);
  return Number(insertId);
}

beforeAll(async () => {
  gymId = await createTestGym('Required Products Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('#3168 a Promotion with required Products', () => {
  it('adds nothing until confirmed, then the list shows the chosen and the required Product with the Promotion', async () => {
    const m = await member();
    const insurance = await product(`Insurance-${uniq()}`);
    const registration = await product(`Registration-${uniq()}`);
    const promo = await promotionRequiring([insurance, registration]);
    const base = `/members/${m}/product-purchases`;

    const refused = await auth(request.post(base)).send({ product_id: insurance, promotion_ids: [promo], draft: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('promotion_requires_products');
    expect((await auth(request.get(`/members/${m}/products`))).body.items).toEqual([]);

    const saved = await auth(request.post(base)).send({ product_id: insurance, promotion_ids: [promo], draft: true, confirm_required_products: true });
    expect(saved.status).toBe(201);

    const list = await auth(request.get(`/members/${m}/products`));
    expect(list.status).toBe(200);
    const rows = list.body.items as any[];
    expect(rows.map((r) => r.product_id).sort()).toEqual([insurance, registration].sort());
    for (const r of rows) {
      expect(r.status).toBe('in_cart');
      expect(r.promotions.map((p: any) => p.promotion_id)).toEqual([promo]);
    }
  });

  it('edit (one-time line): ticking the Promotion is refused until confirmed, then the required Product is listed with it', async () => {
    const m = await member();
    const insurance = await product(`Insurance-${uniq()}`);
    const registration = await product(`Registration-${uniq()}`);
    const promo = await promotionRequiring([insurance, registration]);
    const base = `/members/${m}/product-purchases`;
    const created = await auth(request.post(base)).send({ product_id: insurance, promotion_ids: [], draft: true });
    expect(created.status).toBe(201);
    const lineId = created.body.purchaseId as number;

    const refused = await auth(request.put(`${base}/${lineId}`)).send({ promotion_ids: [promo] });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('promotion_requires_products');
    expect(((await auth(request.get(`/members/${m}/products`))).body.items as any[]).map((r) => r.product_id)).toEqual([insurance]);

    const saved = await auth(request.put(`${base}/${lineId}`)).send({ promotion_ids: [promo], confirm_required_products: true });
    expect(saved.status).toBe(200);
    const rows = (await auth(request.get(`/members/${m}/products`))).body.items as any[];
    expect(rows.map((r) => r.product_id).sort()).toEqual([insurance, registration].sort());
    for (const r of rows) expect(r.promotions.map((p: any) => p.promotion_id)).toEqual([promo]);

    // A quantity edit of the line that already holds the Promotion asks nothing again.
    const again = (rows.find((r) => r.product_id === insurance)).id;
    expect((await auth(request.put(`${base}/${again}`)).send({ promotion_ids: [promo], quantity: 2 })).status).toBe(200);
  });

  it('edit (recurring line): the confirmed edit adds the required Product to the cart', async () => {
    const m = await member();
    const locker = await product(`Locker-${uniq()}`, 'month');
    const towel = await product(`Towel-${uniq()}`, 'month');
    const promo = await promotionRequiring([locker, towel], 'promotion_periodical');
    const base = `/members/${m}/product-purchases`;
    const created = await auth(request.post(base)).send({ product_id: locker, promotion_ids: [] });
    expect(created.status).toBeLessThan(300);
    const line = ((await auth(request.get(`/members/${m}/products`))).body.items as any[]).find((r) => r.product_id === locker);
    const lineId = line.draft_line_id ?? line.id;

    const refused = await auth(request.put(`${base}/recurring/${lineId}`)).send({ promotion_ids: [promo] });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('promotion_requires_products');

    const saved = await auth(request.put(`${base}/recurring/${lineId}`)).send({ promotion_ids: [promo], confirm_required_products: true });
    expect(saved.status).toBe(200);
    const ids = ((await auth(request.get(`/members/${m}/products`))).body.items as any[]).map((r) => r.product_id);
    expect(ids.sort()).toEqual([locker, towel].sort());
  });

  it('#3236: the quote names each required Product with its image and the Promotion that requires it', async () => {
    const m = await member();
    const insurance = await product(`Insurance-${uniq()}`);
    const registration = await product(`Registration-${uniq()}`);
    await db.query(
      `UPDATE products SET description = 'Annual registration', image_url = 'https://cdn.test/r.webp',
              image_thumbnail_url = 'https://cdn.test/r-thumbnail.webp' WHERE id = ?`, [registration]);
    const promo = await promotionRequiring([insurance, registration]);
    await db.query(`UPDATE promotions SET description = 'Half price', image_thumbnail_url = 'https://cdn.test/p-thumbnail.webp' WHERE id = ?`, [promo]);

    const quote = await auth(request.post(`/members/${m}/product-purchases/quote`)).send({ product_id: insurance, promotion_ids: [promo] });
    expect(quote.status).toBe(200);
    expect(quote.body.required_products).toHaveLength(1);
    const [req] = quote.body.required_products;
    expect(req).toMatchObject({
      id: registration, description: 'Annual registration',
      image_url: 'https://cdn.test/r.webp', image_thumbnail_url: 'https://cdn.test/r-thumbnail.webp',
    });
    expect(req.required_by).toEqual([expect.objectContaining({
      id: promo, description: 'Half price', image_thumbnail_url: 'https://cdn.test/p-thumbnail.webp',
    })]);
  });
});
