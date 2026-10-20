// #1851 — Import System Products: gym creation seeding records provenance, and
// `GET /products/base` + `POST /products/import` import templates into a gym
// without duplicates, without touching existing Products and without leaking
// across gyms.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { seedDefaultGymProducts } from '../api/gym-default-products';
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

const liveTemplates = async () => {
  const { rows } = await db.query<any>('SELECT * FROM base_products WHERE deleted_at IS NULL ORDER BY id');
  return rows;
};

describe('Import System Products', () => {
  let gymId: string;
  let otherGym: string;
  let readOnlyGym: string;

  beforeAll(async () => {
    gymId = await createTestGym('Import Products Gym');
    await createTestMembership(gymId, 'admin');
    otherGym = await createTestGym('Import Products Other Gym');
    await createTestMembership(otherGym, 'admin');
    readOnlyGym = await createTestGym('Import Products Accountant Gym');
    await createTestMembership(readOnlyGym, 'accountant');
  });

  it('gym creation seeds every live template and records it in base_product_id', async () => {
    const seeded = await createTestGym('Import Products Seeded Gym');
    await seedDefaultGymProducts(seeded);
    const templates = await liveTemplates();
    const { rows } = await db.query<any>(
      'SELECT base_product_id, is_system FROM products WHERE gym_id = ? AND base_product_id IS NOT NULL',
      [seeded],
    );
    expect(rows.map((r: any) => r.base_product_id).sort()).toEqual(templates.map((t: any) => t.id).sort());
    expect(rows.every((r: any) => r.is_system === 1)).toBe(true);

    // Re-running adds nothing.
    const { rows: before } = await db.query<any>('SELECT id FROM products WHERE gym_id = ?', [seeded]);
    await seedDefaultGymProducts(seeded);
    const { rows: after } = await db.query<any>('SELECT id FROM products WHERE gym_id = ?', [seeded]);
    expect(after.length).toBe(before.length);
  });

  it('requires auth and an admin', async () => {
    expect((await request.get('/products/base').set('x-gym-id', gymId)).status).toBe(401);
    const ro = await request.get('/products/base').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', readOnlyGym);
    expect(ro.status).toBe(403);
    const roPost = await request.post('/products/import').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', readOnlyGym)
      .send({ base_product_ids: [1] });
    expect(roPost.status).toBe(403);
  });

  it('lists the live templates as not imported for a gym with no Products', async () => {
    const res = await request.get('/products/base').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const templates = await liveTemplates();
    expect(res.body).toHaveLength(templates.length);
    expect(res.body.every((r: any) => r.imported === false && r.imported_product_id === null)).toBe(true);
  });

  it('filters the list by name', async () => {
    const res = await request.get('/products/base?q=locker').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.name)).toEqual(['Locker Rental']);
  });

  it('imports the selected templates as gym-owned system Products, once', async () => {
    const templates = await liveTemplates();
    const locker = templates.find((t: any) => t.charge_type_code === 'locker_rental');
    const pt = templates.find((t: any) => t.charge_type_code === null);

    const res = await request.post('/products/import').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ base_product_ids: [locker.id, pt.id] });
    expect(res.status).toBe(200);
    expect(res.body.imported.sort()).toEqual([locker.id, pt.id].sort());
    expect(res.body.skipped).toEqual([]);

    const { rows } = await db.query<any>(
      'SELECT name, gym_id, is_system, base_product_id, amount, billing_frequency FROM products WHERE gym_id = ? AND base_product_id IS NOT NULL',
      [gymId],
    );
    expect(rows).toHaveLength(2);
    const lockerRow = rows.find((r: any) => r.base_product_id === locker.id);
    expect(lockerRow).toMatchObject({ name: 'Locker Rental', is_system: 1, billing_frequency: 'month' });
    expect(Number(lockerRow.amount)).toBe(15);

    // Repeating the import creates nothing and reports the skip.
    const again = await request.post('/products/import').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ base_product_ids: [locker.id, pt.id] });
    expect(again.body.imported).toEqual([]);
    expect(again.body.skipped.sort()).toEqual([locker.id, pt.id].sort());
    const { rows: count } = await db.query<any>('SELECT id FROM products WHERE gym_id = ?', [gymId]);
    expect(count).toHaveLength(2);

    // The list now marks them.
    const list = await request.get('/products/base').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const importedIds = list.body.filter((r: any) => r.imported).map((r: any) => r.id).sort();
    expect(importedIds).toEqual([locker.id, pt.id].sort());
  });

  it('does not overwrite a Product the gym has since customised', async () => {
    const templates = await liveTemplates();
    const locker = templates.find((t: any) => t.charge_type_code === 'locker_rental');
    await db.query("UPDATE products SET amount = 99.5, name = 'My Lockers' WHERE gym_id = ? AND base_product_id = ?", [gymId, locker.id]);
    const res = await request.post('/products/import').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ base_product_ids: [locker.id] });
    expect(res.body.skipped).toEqual([locker.id]);
    const { rows } = await db.query<any>('SELECT name, amount FROM products WHERE gym_id = ? AND base_product_id = ?', [gymId, locker.id]);
    expect(rows[0].name).toBe('My Lockers');
    expect(Number(rows[0].amount)).toBe(99.5);
  });

  it('treats a pre-existing System Product of the same charge type as already imported', async () => {
    const legacyGym = await createTestGym('Import Products Legacy Gym');
    await createTestMembership(legacyGym, 'admin');
    await db.query(
      `INSERT INTO products (gym_id, charge_type_id, name, type, is_system, created_at)
       SELECT ?, id, name, 'fee', 1, UTC_TIMESTAMP() FROM charge_types WHERE code = 'locker_rental'`,
      [legacyGym],
    );
    const list = await request.get('/products/base?q=locker').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', legacyGym);
    expect(list.body[0].imported).toBe(true);
    const res = await request.post('/products/import').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', legacyGym)
      .send({ base_product_ids: [list.body[0].id] });
    expect(res.body.imported).toEqual([]);
  });

  it('is isolated between gyms', async () => {
    const list = await request.get('/products/base').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGym);
    expect(list.body.every((r: any) => r.imported === false)).toBe(true);
    const { rows } = await db.query<any>('SELECT id FROM products WHERE gym_id = ?', [otherGym]);
    expect(rows).toHaveLength(0);
  });

  it('ignores a deleted template and rejects a bad body', async () => {
    const { insertId } = await db.query(
      "INSERT INTO base_products (charge_type_code, name, type, billing_frequency, deleted_at, created_by) VALUES (NULL, 'Import Test Deleted', 'fee', 'once', UTC_TIMESTAMP(), 'test')",
    );
    const res = await request.post('/products/import').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGym)
      .send({ base_product_ids: [insertId] });
    expect(res.body).toEqual({ imported: [], skipped: [insertId] });
    await db.query('DELETE FROM base_products WHERE id = ?', [insertId]);

    for (const body of [{}, { base_product_ids: [] }, { base_product_ids: ['x'] }]) {
      const bad = await request.post('/products/import').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGym).send(body);
      expect(bad.status).toBe(400);
    }
  });
});
