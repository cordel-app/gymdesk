// #2009 stage 2 — importing a Base Product copies every applicable field 1:1
// (text, tax behaviour, image URLs by reference) and editing the imported
// Product never reaches the template.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { importBaseProducts } from '../api/gym-default-products';
import { parseBaseProductInput } from '../domain/baseProducts';
import { cleanupTestGyms, createTestGym } from './helpers';

const NAME = 'Import Fields Template (#2009)';
let gymId: string;
let templateId: number;

beforeAll(async () => {
  gymId = await createTestGym('Import Fields Gym');
  await db.query('DELETE FROM base_products WHERE name = ?', [NAME]);
  const res = await db.query(
    `INSERT INTO base_products
       (charge_type_code, name, type, units, amount, billing_frequency, status, enrollment_status,
        mandatory, validity_days, one_time_purchase, description, notes, package_information,
        tax_behavior, image_url, image_thumbnail_url, created_at, created_by)
     VALUES (NULL, ?, 'sessions', 5, 50, 'once', 'active', 'public', 0, 90, 1,
        'Five sessions', 'Internal note', 'Valid 90 days', 'exclusive',
        'https://img.example/p.webp', 'https://img.example/p-thumbnail.webp', UTC_TIMESTAMP(), 'test')`,
    [NAME],
  );
  templateId = res.insertId;
});

afterAll(async () => {
  await db.query('DELETE FROM products WHERE base_product_id = ?', [templateId]);
  await db.query('DELETE FROM base_products WHERE id = ?', [templateId]);
  await cleanupTestGyms();
  await db.end();
});

describe('Base Product import field mapping', () => {
  it('copies text, tax behaviour and image references; the template is untouched by later edits', async () => {
    const result = await importBaseProducts(gymId, [templateId], 'test');
    expect(result.imported).toEqual([templateId]);

    const { rows } = await db.query<any>('SELECT * FROM products WHERE gym_id = ? AND base_product_id = ?', [gymId, templateId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: NAME, type: 'sessions', units: 5, validity_days: 90, one_time_purchase: 1,
      description: 'Five sessions', notes: 'Internal note', package_information: 'Valid 90 days',
      tax_behavior: 'exclusive', image_url: 'https://img.example/p.webp',
      image_thumbnail_url: 'https://img.example/p-thumbnail.webp',
    });
    expect(Number(rows[0].amount)).toBe(50);

    await db.query("UPDATE products SET description = 'Changed', image_url = NULL WHERE id = ?", [rows[0].id]);
    const { rows: tpl } = await db.query<any>('SELECT description, image_url FROM base_products WHERE id = ?', [templateId]);
    expect(tpl[0]).toMatchObject({ description: 'Five sessions', image_url: 'https://img.example/p.webp' });
  });
});

describe('parseBaseProductInput text fields', () => {
  it('defaults, keeps on omission, clears on blank and rejects bad values', () => {
    const created = parseBaseProductInput({ name: 'X' });
    if ('error' in created) throw new Error(created.error);
    expect(created.value).toMatchObject({ description: null, notes: null, package_information: null, tax_behavior: 'inclusive' });

    const withText = parseBaseProductInput({ description: ' d ', tax_behavior: 'exclusive' }, created.value);
    if ('error' in withText) throw new Error(withText.error);
    expect(withText.value).toMatchObject({ description: 'd', tax_behavior: 'exclusive' });

    const kept = parseBaseProductInput({ name: 'Y' }, withText.value);
    if ('error' in kept) throw new Error(kept.error);
    expect(kept.value.description).toBe('d');

    const cleared = parseBaseProductInput({ description: '  ' }, withText.value);
    if ('error' in cleared) throw new Error(cleared.error);
    expect(cleared.value.description).toBeNull();

    expect('error' in parseBaseProductInput({ name: 'X', tax_behavior: 'none' })).toBe(true);
    expect('error' in parseBaseProductInput({ name: 'X', description: 'a'.repeat(501) })).toBe(true);
    expect('error' in parseBaseProductInput({ name: 'X', notes: 5 })).toBe(true);
  });
});
