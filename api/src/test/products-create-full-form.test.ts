// #2948 — `+ Add Product` is the Edit form, so `POST /products` must take
// every field `PUT /products/:id` does and persist it in the one request:
// an administrator never has to create a product and reopen it to finish.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
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

describe('POST /products with the full product form (#2948)', () => {
  let gymId: string;
  let taxRateId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Create Full Form Gym');
    await createTestMembership(gymId, 'admin');
    const { insertId } = await db.query(
      `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status, created_at)
       VALUES (?, 'VAT 21', 21, 0, 'active', UTC_TIMESTAMP())`,
      [gymId],
    );
    taxRateId = insertId;
  });

  function post(body: Record<string, unknown>) {
    return request
      .post('/products')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(body);
  }

  it('persists every field the edit form configures', async () => {
    const res = await post({
      name: 'Locker Rental',
      type: 'service',
      units: 1,
      description: 'A locker for the month',
      translations: {
        es: { name: 'Alquiler de taquilla', description: 'Una taquilla al mes' },
        ca: { name: 'Lloguer de taquilla', description: null },
      },
      amount: 12.5,
      billing_frequency: 'month',
      status: 'inactive',
      enrollment_status: 'staff_only',
      notes: 'Front desk keeps the keys',
      package_information: 'Key deposit at the desk',
      validity_days: 30,
      tax_rate_id: taxRateId,
      mandatory: true,
      one_time_purchase: true,
      one_per_member: true,
      sharing_type: 'shared',
    });
    expect(res.status).toBe(201);

    const { rows } = await db.query<any>(
      `SELECT name, type, units, description, amount, billing_frequency, status, enrollment_status,
              notes, package_information, validity_days, tax_rate_id, mandatory, one_time_purchase,
              one_per_member, sharing_type, is_system
         FROM products WHERE id = ? AND gym_id = ?`,
      [res.body.id, gymId],
    );
    expect(rows[0]).toMatchObject({
      name: 'Locker Rental',
      type: 'service',
      units: 1,
      description: 'A locker for the month',
      billing_frequency: 'month',
      status: 'inactive',
      enrollment_status: 'staff_only',
      notes: 'Front desk keeps the keys',
      package_information: 'Key deposit at the desk',
      validity_days: 30,
      tax_rate_id: taxRateId,
      mandatory: 1,
      one_time_purchase: 1,
      one_per_member: 1,
      sharing_type: 'shared',
      is_system: 0,
    });
    expect(Number(rows[0].amount)).toBe(12.5);

    const { rows: tr } = await db.query<any>(
      'SELECT locale, name, description FROM product_translations WHERE product_id = ? ORDER BY locale',
      [res.body.id],
    );
    expect(tr).toEqual([
      { locale: 'ca', name: 'Lloguer de taquilla', description: null },
      { locale: 'es', name: 'Alquiler de taquilla', description: 'Una taquilla al mes' },
    ]);
  });

  it('keeps the previous defaults for a field the body leaves out', async () => {
    const res = await post({ name: 'Plain Fee', type: 'fee' });
    expect(res.status).toBe(201);
    const { rows } = await db.query<any>(
      'SELECT status, enrollment_status, mandatory, one_time_purchase, one_per_member, sharing_type FROM products WHERE id = ?',
      [res.body.id],
    );
    expect(rows[0]).toEqual({
      status: 'active',
      enrollment_status: 'public',
      mandatory: 0,
      one_time_purchase: 0,
      one_per_member: 0,
      sharing_type: 'individual',
    });
  });

  it('refuses the values the edit form refuses, writing nothing', async () => {
    for (const body of [
      { name: 'Bad Status', type: 'fee', status: 'archived' },
      { name: 'Bad One-time', type: 'fee', one_time_purchase: 'yes' },
      { name: 'Bad One per Member', type: 'fee', one_per_member: 'no' },
      { name: 'Bad Validity', type: 'fee', validity_days: -3 },
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const { rows } = await db.query<any>(
        'SELECT id FROM products WHERE gym_id = ? AND name = ?',
        [gymId, body.name],
      );
      expect(rows).toHaveLength(0);
    }
  });
});
