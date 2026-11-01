// #2253 — POST /products/:id/resync refreshes name, description and (only when
// missing) the image of an imported Product; nothing else is touched.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { importBaseProducts } from '../api/gym-default-products';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const NAME = 'Resync Template (#2253)';
let gymId: string;
let otherGym: string;
let templateId: number;
let productId: number;

const post = (id: number, gym = gymId) =>
  request.post(`/products/${id}/resync`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

beforeAll(async () => {
  gymId = await createTestGym('Resync Gym');
  await createTestMembership(gymId, 'admin');
  otherGym = await createTestGym('Resync Other Gym');
  await createTestMembership(otherGym, 'admin');
  await db.query('DELETE FROM base_products WHERE name LIKE ?', ['Resync Template%']);
  const res = await db.query(
    `INSERT INTO base_products
       (charge_type_code, name, type, units, amount, billing_frequency, status, enrollment_status,
        mandatory, validity_days, one_time_purchase, description, tax_behavior, image_url, image_thumbnail_url,
        created_at, created_by)
     VALUES (NULL, ?, 'fee', NULL, 10, 'month', 'active', 'public', 0, NULL, 0, 'Base description', 'inclusive',
        'https://img.example/b.webp', 'https://img.example/b-thumbnail.webp', UTC_TIMESTAMP(), 'test')`,
    [NAME],
  );
  templateId = res.insertId;
  await importBaseProducts(gymId, [templateId], 'test');
  const { rows } = await db.query<any>('SELECT id FROM products WHERE gym_id = ? AND base_product_id = ?', [gymId, templateId]);
  productId = rows[0].id;
});

afterAll(async () => {
  await db.query('DELETE FROM products WHERE base_product_id = ?', [templateId]);
  await db.query('DELETE FROM products WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM base_products WHERE id = ?', [templateId]);
  await cleanupTestGyms();
  await db.end();
});

describe('POST /products/:id/resync', () => {
  it('401 without auth, 404 for another gym\'s product', async () => {
    expect((await request.post(`/products/${productId}/resync`).set('x-gym-id', gymId)).status).toBe(401);
    expect((await post(productId, otherGym)).status).toBe(404);
  });

  it('reports no change when the copy already matches', async () => {
    const res = await post(productId);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(false);
  });

  it('updates name/description, keeps a customised image and every other field', async () => {
    await db.query(
      `UPDATE products SET name = 'Custom', description = 'Mine', amount = 99, image_url = 'https://img.example/mine.webp' WHERE id = ?`,
      [productId],
    );
    const res = await post(productId);
    expect(res.status).toBe(200);
    expect(res.body.changed.sort()).toEqual(['description', 'name']);
    const { rows } = await db.query<any>('SELECT * FROM products WHERE id = ?', [productId]);
    expect(rows[0]).toMatchObject({ name: NAME, description: 'Base description', image_url: 'https://img.example/mine.webp', base_product_id: templateId });
    expect(Number(rows[0].amount)).toBe(99);
  });

  it('copies the image only when the product has none', async () => {
    await db.query('UPDATE products SET image_url = NULL, image_thumbnail_url = NULL WHERE id = ?', [productId]);
    const res = await post(productId);
    expect(res.body.changed).toEqual(['image_url']);
    const { rows } = await db.query<any>('SELECT image_url FROM products WHERE id = ?', [productId]);
    expect(rows[0].image_url).toBe('https://img.example/b.webp');
  });

  it('409 for a product with no origin and when the base is gone', async () => {
    const { insertId } = await db.query(
      `INSERT INTO products (gym_id, name, type, is_system, created_at) VALUES (?, 'Own', 'fee', 0, UTC_TIMESTAMP())`,
      [gymId],
    );
    expect((await post(insertId)).status).toBe(409);
    await db.query('UPDATE base_products SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [templateId]);
    const res = await post(productId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('base_product_unavailable');
  });
});
