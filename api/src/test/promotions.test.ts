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

  it('GET /promotions/timeline → 401 without token', async () => {
    const res = await request.get('/promotions/timeline').set('x-gym-id', gymId);
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

// ─── Pay Beforehand (#486) ─────────────────────────────────────────────────────

describe('Pay Beforehand', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Pay Beforehand Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('existing Promotions default pay_beforehand_months to 0', async () => {
    const promoId = await createPromo(gymId, 'Legacy Promo');
    const res = await request
      .get(`/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.pay_beforehand_months).toBe(0);
  });

  it('POST /promotions creates with pay_beforehand_months', async () => {
    const res = await request
      .post('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'Prepaid Promo',
        starts_at: '2026-08-01',
        ends_at: '2026-08-31',
        paid_months: 3,
        pay_beforehand_months: 2,
      });
    expect(res.status).toBe(201);
    expect(res.body.pay_beforehand_months).toBe(2);
  });

  it('POST /promotions rejects pay_beforehand_months > paid_months', async () => {
    const res = await request
      .post('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'Invalid Promo',
        starts_at: '2026-08-01',
        ends_at: '2026-08-31',
        paid_months: 2,
        pay_beforehand_months: 3,
      });
    expect(res.status).toBe(400);
  });

  it('POST /promotions rejects pay_beforehand_months > 0 when paid_months is 0', async () => {
    const res = await request
      .post('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'Invalid Promo 2',
        starts_at: '2026-08-01',
        ends_at: '2026-08-31',
        paid_months: 0,
        pay_beforehand_months: 1,
      });
    expect(res.status).toBe(400);
  });

  it('PUT /promotions/:id validates pay_beforehand_months against the existing paid_months', async () => {
    const promoId = await createPromo(gymId, 'Combo Promo');
    await request
      .put(`/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ paid_months: 2 });

    const badRes = await request
      .put(`/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ pay_beforehand_months: 3 });
    expect(badRes.status).toBe(400);

    const okRes = await request
      .put(`/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ pay_beforehand_months: 2 });
    expect(okRes.status).toBe(200);
    expect(okRes.body.pay_beforehand_months).toBe(2);
  });

  it('duplicate copies pay_beforehand_months', async () => {
    const created = await request
      .post('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'Dup Source',
        starts_at: '2026-08-01',
        ends_at: '2026-08-31',
        paid_months: 3,
        pay_beforehand_months: 1,
      });
    const dup = await request
      .post(`/promotions/${created.body.id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dup.status).toBe(201);
    expect(dup.body.pay_beforehand_months).toBe(1);
  });
});

// ─── Timeline / Forecast endpoint (#486) ───────────────────────────────────────

describe('GET /promotions/timeline', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Timeline Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('matches the ticket\'s canonical example (free=1, paid=3, pay_beforehand=2, bonus=1)', async () => {
    const res = await request
      .get('/promotions/timeline')
      .query({ free_months: 1, paid_months: 3, pay_beforehand_months: 2, bonus_months: 1, anchor_date: '2026-01-01' })
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.periods.map((p: any) => p.status)).toEqual([
      'free_promotion',
      'prepaid_promotion',
      'prepaid_promotion',
      'pay_promotion',
      'bonus_promotion',
      'pay_regular',
    ]);
  });

  it('rejects pay_beforehand_months greater than paid_months', async () => {
    const res = await request
      .get('/promotions/timeline')
      .query({ paid_months: 1, pay_beforehand_months: 2 })
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('rejects negative/non-integer query params', async () => {
    const res = await request
      .get('/promotions/timeline')
      .query({ paid_months: -1 })
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('defaults missing params to 0 and returns just the regular period', async () => {
    const res = await request
      .get('/promotions/timeline')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.periods).toHaveLength(1);
    expect(res.body.periods[0].status).toBe('pay_regular');
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
