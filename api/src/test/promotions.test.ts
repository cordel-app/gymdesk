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

  // #552 — Billing column reflects the (unsaved, draft) Membership Fee Benefit.
  it('rejects an invalid membership_fee_action', async () => {
    const res = await request
      .get('/promotions/timeline')
      .query({ paid_months: 1, membership_fee_action: 'bogus' })
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('rejects a non-numeric membership_fee_value', async () => {
    const res = await request
      .get('/promotions/timeline')
      .query({ paid_months: 1, membership_fee_action: 'percentage_discount', membership_fee_value: 'abc' })
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('rejects a non-positive membership_fee_duration_months', async () => {
    const res = await request
      .get('/promotions/timeline')
      .query({ paid_months: 1, membership_fee_duration_months: '0' })
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('returns the Membership Fee Benefit action/value only on paid promotional periods', async () => {
    const res = await request
      .get('/promotions/timeline')
      .query({
        free_months: 1, paid_months: 1, bonus_months: 1,
        membership_fee_action: 'percentage_discount', membership_fee_value: '30', membership_fee_enabled: '1',
        anchor_date: '2026-01-01',
      })
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.periods.map((p: any) => [p.status, p.billingAction, p.billingValue])).toEqual([
      ['free_promotion', null, null],
      ['pay_promotion', 'percentage_discount', 30],
      ['bonus_promotion', null, null],
      ['pay_regular', null, null],
    ]);
  });

  it('ignores the Membership Fee Benefit when membership_fee_enabled is not set', async () => {
    const res = await request
      .get('/promotions/timeline')
      .query({ paid_months: 1, membership_fee_action: 'waive', membership_fee_value: '0' })
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.periods.every((p: any) => p.billingAction === null)).toBe(true);
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

// ─── Period benefits — pre-existing rows without action/value (#487 stage 1) ──

describe('Period benefits — pre-migration-shape rows', () => {
  let gymId: string;
  let promoId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PB Shape Gym');
    await createTestMembership(gymId, 'admin');
    promoId = await createPromo(gymId, 'PB Shape Promo');
  });

  it('pre-existing (pre-migration-shape) period benefits without action/value remain valid', async () => {
    // Insert directly, bypassing the API, to simulate a row written before action/value existed.
    const nutritionCtId = await getChargeTypeId('nutrition_service');
    await db.query(
      `INSERT INTO promotion_period_benefits (gym_id, promotion_id, charge_type_id, quantity, frequency_interval, frequency_unit, enabled)
       VALUES (?, ?, ?, 1, 1, 'month', 1)`,
      [gymId, promoId, nutritionCtId],
    );
    const res = await request
      .get(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.charge_type_id === nutritionCtId);
    expect(row).toBeTruthy();
    expect(row.action).toBeNull();
    expect(row.value).toBeNull();
  });
});

// ─── Membership Fee Benefits (#551) ────────────────────────────────────────────
// Reuses the Period Benefits table/validation/action-value mechanism (#487
// stage 1) exactly, as a singleton row whose charge_type is always
// 'membership_fee', server-resolved — never accepted from the client. The
// generic /period-benefits endpoints must never see or touch this row.

describe('Membership Fee Benefit', () => {
  let gymId: string;
  let gymB: string;
  let promoId: number;
  let membershipFeeCtId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MF Benefit Gym');
    gymB = await createTestGym('MF Benefit Gym B');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(gymB, 'admin');
    promoId = await createPromo(gymId, 'MF Benefit Promo');
    membershipFeeCtId = await getChargeTypeId('membership_fee');
  });

  function mfBody(overrides: Record<string, any> = {}) {
    return {
      quantity: 1,
      frequency_interval: 1,
      frequency_unit: 'month',
      ...overrides,
    };
  }

  const VALUE_ACTIONS = ['percentage_discount', 'fixed_discount', 'fixed_price'];

  it('GET /membership-fee-benefit returns null before anything is configured', async () => {
    const promo = await createPromo(gymId, 'MF Benefit Fresh Promo');
    const res = await request
      .get(`/promotions/${promo}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('PUT /membership-fee-benefit round-trips each of the 5 actions and always targets the membership_fee item', async () => {
    const cases: [string, number | undefined][] = [
      ['no_benefit', undefined],
      ['waive', undefined],
      ['percentage_discount', 25],
      ['fixed_discount', 10.5],
      ['fixed_price', 29.99],
    ];
    for (const [action, value] of cases) {
      const res = await request
        .put(`/promotions/${promoId}/membership-fee-benefit`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send(mfBody({ action, value }));
      expect(res.status).toBe(200);
      expect(res.body.action).toBe(action);
      expect(res.body.charge_type_id).toBe(membershipFeeCtId);
      expect(res.body.charge_type_code).toBe('membership_fee');
      if (VALUE_ACTIONS.includes(action)) {
        expect(parseFloat(res.body.value)).toBeCloseTo(value as number, 2);
      } else {
        expect(res.body.value).toBeNull();
      }
    }
  });

  it('PUT /membership-fee-benefit upserts a single row (not duplicated on repeat writes)', async () => {
    for (let i = 0; i < 3; i++) {
      await request
        .put(`/promotions/${promoId}/membership-fee-benefit`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send(mfBody({ action: 'waive' }));
    }
    const { rows } = await db.query(
      'SELECT COUNT(*) AS n FROM promotion_period_benefits WHERE promotion_id = ? AND charge_type_id = ?',
      [promoId, membershipFeeCtId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('the charge_type_id in the request body cannot override the membership_fee item', async () => {
    const otherCtId = await getChargeTypeId('nutrition_service');
    const res = await request
      .put(`/promotions/${promoId}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(mfBody({ charge_type_id: otherCtId, action: 'waive' }));
    expect(res.status).toBe(200);
    expect(res.body.charge_type_id).toBe(membershipFeeCtId);
  });

  it('GET /membership-fee-benefit returns action and value', async () => {
    const res = await request
      .get(`/promotions/${promoId}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('action');
    expect(res.body).toHaveProperty('value');
  });

  it('PUT /membership-fee-benefit accepts percentage_discount boundary values 0 and 100', async () => {
    for (const value of [0, 100]) {
      const res = await request
        .put(`/promotions/${promoId}/membership-fee-benefit`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send(mfBody({ action: 'percentage_discount', value }));
      expect(res.status).toBe(200);
      expect(parseFloat(res.body.value)).toBeCloseTo(value, 2);
    }
  });

  it('PUT /membership-fee-benefit rejects percentage_discount value below 0 or above 100', async () => {
    for (const value of [-1, 101]) {
      const res = await request
        .put(`/promotions/${promoId}/membership-fee-benefit`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send(mfBody({ action: 'percentage_discount', value }));
      expect(res.status).toBe(400);
    }
  });

  it('PUT /membership-fee-benefit rejects negative value for fixed_discount and fixed_price', async () => {
    for (const action of ['fixed_discount', 'fixed_price']) {
      const res = await request
        .put(`/promotions/${promoId}/membership-fee-benefit`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send(mfBody({ action, value: -5 }));
      expect(res.status).toBe(400);
    }
  });

  it('PUT /membership-fee-benefit rejects an unknown action', async () => {
    const res = await request
      .put(`/promotions/${promoId}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(mfBody({ action: 'bogus_action' }));
    expect(res.status).toBe(400);
  });

  it('no_benefit and waive store a null value even if a value is sent', async () => {
    for (const action of ['no_benefit', 'waive']) {
      const res = await request
        .put(`/promotions/${promoId}/membership-fee-benefit`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send(mfBody({ action, value: 999 }));
      expect(res.status).toBe(200);
      expect(res.body.value).toBeNull();
    }
  });

  it('absent action stores null action and null value', async () => {
    const res = await request
      .put(`/promotions/${promoId}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(mfBody());
    expect(res.status).toBe(200);
    expect(res.body.action).toBeNull();
    expect(res.body.value).toBeNull();
  });

  it('duplicate copies the membership fee benefit', async () => {
    const source = await request
      .post('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'MF Dup Source', starts_at: '2026-08-01', ends_at: '2026-08-31' });
    await request
      .put(`/promotions/${source.body.id}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(mfBody({ action: 'fixed_discount', value: 12.34, duration_months: 6 }));
    const dup = await request
      .post(`/promotions/${source.body.id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dup.status).toBe(201);
    const dupMf = await request
      .get(`/promotions/${dup.body.id}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dupMf.status).toBe(200);
    expect(dupMf.body.action).toBe('fixed_discount');
    expect(parseFloat(dupMf.body.value)).toBeCloseTo(12.34, 2);
    expect(dupMf.body.duration_months).toBe(6);
  });

  it('tenant isolation: gym B does not see gym A membership fee benefit', async () => {
    const res = await request
      .get(`/promotions/${promoId}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('tenant isolation: gym B cannot write gym A membership fee benefit (404)', async () => {
    const res = await request
      .put(`/promotions/${promoId}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send(mfBody({ action: 'waive' }));
    expect(res.status).toBe(404);
  });

  it('PUT /membership-fee-benefit → 401 without token', async () => {
    const res = await request
      .put(`/promotions/${promoId}/membership-fee-benefit`)
      .set('x-gym-id', gymId)
      .send(mfBody());
    expect(res.status).toBe(401);
  });

  it('PUT /membership-fee-benefit → 403 for non-admin role', async () => {
    const fdGymId = await createTestGym('MF Benefit FD Gym');
    await createTestMembership(fdGymId, 'front_desk');
    const fdPromoId = await createPromo(fdGymId, 'FD Promo');
    const res = await request
      .put(`/promotions/${fdPromoId}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', fdGymId)
      .send(mfBody());
    expect(res.status).toBe(403);
  });

  // ─── Isolation from the generic /period-benefits section ────────────────

  it('GET /period-benefits never includes the Membership Fee row', async () => {
    const res = await request
      .get(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.find((r: any) => r.charge_type_code === 'membership_fee')).toBeUndefined();
  });

  it('PUT /period-benefits rejects a membership_fee charge_type_id', async () => {
    const res = await request
      .put(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ charge_type_id: membershipFeeCtId, quantity: 1, frequency_interval: 1, frequency_unit: 'month' }] });
    expect(res.status).toBe(400);
  });

  it('POST /period-benefits rejects a membership_fee charge_type_id', async () => {
    const res = await request
      .post(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ charge_type_id: membershipFeeCtId, quantity: 1, frequency_interval: 1, frequency_unit: 'month' });
    expect(res.status).toBe(400);
  });

  it('bulk-saving the generic Period Benefits list never deletes the Membership Fee row', async () => {
    const nutritionCtId = await getChargeTypeId('nutrition_service');
    await request
      .put(`/promotions/${promoId}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(mfBody({ action: 'waive' }));

    const saveGeneric = await request
      .put(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ charge_type_id: nutritionCtId, quantity: 2, frequency_interval: 1, frequency_unit: 'week' }] });
    expect(saveGeneric.status).toBe(200);

    const mf = await request
      .get(`/promotions/${promoId}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(mf.status).toBe(200);
    expect(mf.body).not.toBeNull();
    expect(mf.body.action).toBe('waive');
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
    // createTestGym does a raw INSERT INTO gyms, bypassing POST /gyms's
    // gym_charges seeding — insert one directly so this describe block
    // actually exercises the endpoint (#487 stage 2: this block previously
    // always no-opped via the `if (!gymChargeId) return` guards below, since
    // gymChargeId was always undefined).
    const membershipFeeTypeId = await getChargeTypeId('membership_fee');
    const { insertId } = await db.query(
      `INSERT INTO gym_charges (gym_id, charge_type_id, amount, currency, billing_frequency, availability)
       VALUES (?, ?, 0, 'EUR', 'month', 'available')`,
      [gymId, membershipFeeTypeId],
    );
    gymChargeId = insertId;
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
