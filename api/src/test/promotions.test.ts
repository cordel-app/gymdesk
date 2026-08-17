// Tests for promotions.ts and promotion-details.ts routers (#272)

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createPromo(gymId: string, name = 'Test Promo'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status)
     VALUES (?, ?, '2026-08-01', '2026-08-31', 'active')`,
    [gymId, name],
  );
  return insertId;
}

async function getChargeTypeId(code: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM charge_types WHERE code = ?', [code]);
  return rows[0]?.id;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('Auth', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Auth Test Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('GET /promotions → 401 without token', async () => {
    const res = await request.get('/promotions').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('POST /promotions → 401 without token', async () => {
    const res = await request.post('/promotions').set('x-gym-id', gymId).send({});
    expect(res.status).toBe(401);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('Tenant isolation', () => {
  let gymA: string;
  let gymB: string;
  let promoIdA: number;

  beforeAll(async () => {
    gymA = await createTestGym('Gym A');
    gymB = await createTestGym('Gym B');
    await createTestMembership(gymA, 'admin');
    await createTestMembership(gymB, 'admin');
    promoIdA = await createPromo(gymA, 'Gym A Promo');
  });

  it('GET /:id with gym B header returns 404 for gym A promo', async () => {
    const res = await request
      .get(`/promotions/${promoIdA}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });

  it('DELETE /:id with gym B header returns 404 for gym A promo', async () => {
    const res = await request
      .delete(`/promotions/${promoIdA}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });
});

// ─── Happy path — new field names ─────────────────────────────────────────────

describe('Promotion CRUD with new field names', () => {
  let gymId: string;
  let promoId: number;

  beforeAll(async () => {
    gymId = await createTestGym('CRUD Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('POST /promotions creates with free_months, paid_months, bonus_months', async () => {
    const res = await request
      .post('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'Summer Promo',
        starts_at: '2026-08-01',
        ends_at: '2026-08-31',
        free_months: 1,
        paid_months: 2,
        bonus_months: 1,
      });
    expect(res.status).toBe(201);
    expect(res.body.free_months).toBe(1);
    expect(res.body.paid_months).toBe(2);
    expect(res.body.bonus_months).toBe(1);
    promoId = res.body.id;
  });

  it('GET /promotions list returns new field names', async () => {
    const res = await request
      .get('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const promo = res.body.find((p: any) => p.id === promoId);
    expect(promo).toBeDefined();
    expect(promo.free_months).toBe(1);
    expect(promo.paid_months).toBe(2);
    expect(promo.bonus_months).toBe(1);
    // Old field names must not be present
    expect(promo.free_period_paid_months).toBeUndefined();
    expect(promo.free_period_bonus_months).toBeUndefined();
  });

  it('GET /promotions/:id returns new field names', async () => {
    const res = await request
      .get(`/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.free_months).toBe(1);
    expect(res.body.paid_months).toBe(2);
    expect(res.body.bonus_months).toBe(1);
  });

  it('PUT /promotions/:id updates new field names', async () => {
    const res = await request
      .put(`/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ free_months: 2, paid_months: 3, bonus_months: 0 });
    expect(res.status).toBe(200);
    expect(res.body.free_months).toBe(2);
    expect(res.body.paid_months).toBe(3);
  });
});

// ─── Period benefits with duration_months ─────────────────────────────────────

describe('Period benefits — duration_months', () => {
  let gymId: string;
  let promoId: number;
  let chargeTypeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PB Gym');
    await createTestMembership(gymId, 'admin');
    promoId = await createPromo(gymId, 'PB Promo');
    chargeTypeId = await getChargeTypeId('nutrition_service');
  });

  it('PUT /period-benefits stores duration_months', async () => {
    const res = await request
      .put(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{
          charge_type_id: chargeTypeId,
          quantity: 1,
          frequency_interval: 1,
          frequency_unit: 'month',
          duration_months: 3,
          enabled: true,
        }],
      });
    expect(res.status).toBe(200);
    expect(res.body[0].duration_months).toBe(3);
  });

  it('GET /period-benefits returns duration_months', async () => {
    const res = await request
      .get(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body[0].duration_months).toBe(3);
  });

  it('PUT /period-benefits rejects invalid duration_months', async () => {
    const res = await request
      .put(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{
          charge_type_id: chargeTypeId,
          quantity: 1,
          frequency_interval: 1,
          frequency_unit: 'month',
          duration_months: -1,
        }],
      });
    expect(res.status).toBe(400);
  });
});

// ─── Charge benefits — fixed_price action ─────────────────────────────────────

describe('Charge benefits — fixed_price action', () => {
  let gymId: string;
  let promoId: number;
  let gymChargeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('CB Gym');
    await createTestMembership(gymId, 'admin');
    promoId = await createPromo(gymId, 'CB Promo');
    const { rows } = await db.query<{ id: number }>(
      "SELECT id FROM gym_charges WHERE gym_id = ? AND availability = 'available' LIMIT 1",
      [gymId],
    );
    gymChargeId = rows[0]?.id;
  });

  it('PUT /charge-benefits accepts fixed_price action', async () => {
    if (!gymChargeId) return; // gym has no charges configured
    const res = await request
      .put(`/promotions/${promoId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{
          gym_charge_id: gymChargeId,
          action: 'fixed_price',
          value: 29.99,
        }],
      });
    expect(res.status).toBe(200);
    expect(res.body[0]?.action).toBe('fixed_price');
  });

  it('PUT /charge-benefits rejects unknown action', async () => {
    if (!gymChargeId) return;
    const res = await request
      .put(`/promotions/${promoId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{
          gym_charge_id: gymChargeId,
          action: 'invalid_action',
          value: 10,
        }],
      });
    expect(res.status).toBe(400);
  });
});

// ─── Included benefits ────────────────────────────────────────────────────────

describe('Included benefits', () => {
  let gymId: string;
  let gymB: string;
  let promoId: number;
  let chargeTypeId: number;
  let gymChargeTypeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('IB Gym');
    gymB = await createTestGym('IB Gym B');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(gymB, 'admin');
    promoId = await createPromo(gymId, 'IB Promo');
    chargeTypeId = await getChargeTypeId('personal_training');
    // Get a gym_charge charge_type (is_gym_charge = 1)
    const { rows } = await db.query<{ id: number }>(
      'SELECT id FROM charge_types WHERE is_gym_charge = 1 LIMIT 1',
    );
    gymChargeTypeId = rows[0]?.id;
  });

  it('GET /included-benefits returns empty initially', async () => {
    const res = await request
      .get(`/promotions/${promoId}/included-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('PUT /included-benefits replaces all items', async () => {
    const res = await request
      .put(`/promotions/${promoId}/included-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{ charge_type_id: chargeTypeId, quantity: 2 }],
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].charge_type_id).toBe(chargeTypeId);
    expect(res.body[0].quantity).toBe(2);
    expect(res.body[0].charge_type_name).toBeDefined();
  });

  it('GET /included-benefits returns saved items', async () => {
    const res = await request
      .get(`/promotions/${promoId}/included-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('PUT /included-benefits rejects gym charge types (is_gym_charge=1)', async () => {
    if (!gymChargeTypeId) return;
    const res = await request
      .put(`/promotions/${promoId}/included-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{ charge_type_id: gymChargeTypeId, quantity: 1 }],
      });
    expect(res.status).toBe(400);
  });

  it('PUT /included-benefits is tenant-isolated (gym B cannot modify gym A promo)', async () => {
    const res = await request
      .put(`/promotions/${promoId}/included-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ items: [] });
    expect(res.status).toBe(404);
  });
});
