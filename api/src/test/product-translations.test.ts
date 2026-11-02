// #2254 — Product Name and Description in English, Spanish and Catalan, for a
// gym's Products and for Cordel's Base Products, carried through Import and
// Resync.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { importBaseProducts } from '../api/gym-default-products';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let gymId: string;
let otherGym: string;
let templateId: number;
const h = (gym = gymId) => ({ 'x-gym-id': gym, Authorization: TEST_AUTH_HEADER });

beforeAll(async () => {
  gymId = await createTestGym('Product Translations Gym');
  await createTestMembership(gymId, 'admin');
  otherGym = await createTestGym('Product Translations Other Gym');
  await createTestMembership(otherGym, 'admin');
});

afterAll(async () => {
  if (templateId) {
    await db.query('DELETE FROM products WHERE base_product_id = ?', [templateId]);
    await db.query('DELETE FROM base_products WHERE id = ?', [templateId]);
  }
  await cleanupTestGyms();
  await db.end();
});

describe('gym Product translations', () => {
  it('stores per-locale text, resolves the request locale and falls back to the base text', async () => {
    const name = uniq('Towel');
    const created = await request.post('/products').set(h()).send({
      name, type: 'fee', amount: 3, billing_frequency: 'once', description: 'A towel',
      translations: { es: { name: 'Toalla', description: 'Una toalla' } },
    });
    expect(created.status).toBe(201);
    expect(created.body.translations.es).toEqual({ name: 'Toalla', description: 'Una toalla' });

    const es = await request.get(`/products/${created.body.id}`).set(h()).set('x-locale', 'es');
    expect(es.body.display_name).toBe('Toalla');
    const ca = await request.get(`/products/${created.body.id}`).set(h()).set('x-locale', 'ca');
    expect(ca.body.display_name).toBe(name);
    expect(ca.body.display_description).toBe('A towel');

    const found = await request.get('/products').set(h()).query({ q: 'Toalla' });
    expect(found.body.map((r: any) => r.id)).toContain(created.body.id);
    // Another gym never sees it.
    expect((await request.get(`/products/${created.body.id}`).set(h(otherGym))).status).toBe(404);
  });

  it('keeps translations when omitted, clears a blanked locale, refuses an unknown one', async () => {
    const created = await request.post('/products').set(h()).send({
      name: uniq('Locker'), type: 'fee', translations: { es: { name: 'Taquilla' }, ca: { name: 'Armariet' } },
    });
    const id = created.body.id;
    const keep = await request.put(`/products/${id}`).set(h()).send({ notes: 'x' });
    expect(keep.body.translations.es.name).toBe('Taquilla');
    const clear = await request.put(`/products/${id}`).set(h()).send({ translations: { es: { name: '', description: '' } } });
    expect(clear.status).toBe(200);
    expect(clear.body.translations.es).toBeUndefined();
    expect(clear.body.translations.ca.name).toBe('Armariet');
    const bad = await request.put(`/products/${id}`).set(h()).send({ translations: { fr: { name: 'x' } } });
    expect(bad.status).toBe(400);
  });

  it('copies translations on Duplicate', async () => {
    const created = await request.post('/products').set(h()).send({
      name: uniq('Shake'), type: 'fee', translations: { ca: { name: 'Batut' } },
    });
    const copy = await request.post(`/products/${created.body.id}/duplicate`).set(h());
    expect(copy.status).toBe(201);
    expect(copy.body.translations.ca.name).toBe('Batut');
  });
});

describe('Base Product translations, Import and Resync', () => {
  it('imports the template translations as the gym\'s own and Resync replaces them', async () => {
    const name = uniq('Base Tpl');
    const res = await db.query(
      `INSERT INTO base_products
         (charge_type_code, name, type, units, amount, billing_frequency, status, enrollment_status,
          mandatory, validity_days, one_time_purchase, description, tax_behavior, created_at, created_by)
       VALUES (NULL, ?, 'fee', NULL, 10, 'month', 'active', 'public', 0, NULL, 0, 'Base desc', 'inclusive', UTC_TIMESTAMP(), 'test')`,
      [name],
    );
    templateId = res.insertId;
    await db.query(
      `INSERT INTO base_product_translations (base_product_id, locale, name, description) VALUES (?, 'es', 'Plantilla', 'Desc ES'), (?, 'ca', 'Plantilla CA', NULL)`,
      [templateId, templateId],
    );

    await importBaseProducts(gymId, [templateId], 'test');
    const { rows } = await db.query<any>('SELECT id FROM products WHERE gym_id = ? AND base_product_id = ?', [gymId, templateId]);
    const productId = rows[0].id;
    const imported = await request.get(`/products/${productId}`).set(h()).set('x-locale', 'es');
    expect(imported.body.display_name).toBe('Plantilla');
    expect(imported.body.translations.ca.name).toBe('Plantilla CA');

    // The gym edits its copy; the template changes; Resync brings the template's text back.
    await request.put(`/products/${productId}`).set(h()).send({ translations: { es: { name: 'Mi nombre' } } });
    await db.query(`UPDATE base_product_translations SET name = 'Plantilla v2' WHERE base_product_id = ? AND locale = 'es'`, [templateId]);
    const sync = await request.post(`/products/${productId}/resync`).set(h());
    expect(sync.status).toBe(200);
    expect(sync.body.changed).toContain('translations');
    const after = await request.get(`/products/${productId}`).set(h()).set('x-locale', 'es');
    expect(after.body.display_name).toBe('Plantilla v2');
    // The template's own rows are untouched by the gym's edits.
    const { rows: tpl } = await db.query<any>(
      `SELECT name FROM base_product_translations WHERE base_product_id = ? AND locale = 'es'`, [templateId],
    );
    expect(tpl[0].name).toBe('Plantilla v2');
  });
});
