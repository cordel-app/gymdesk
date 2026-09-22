// Tests for promotions.ts and promotion-details.ts routers (#272)

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
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

async function createPlan(
  gymId: string,
  name: string,
  lifecycleStatus: 'draft' | 'active' | 'paused' | 'inactive' = 'active',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, ?, 'staff_only')`,
    [gymId, name, lifecycleStatus],
  );
  return insertId;
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

// ─── Membership Fee Benefits (#551) ────────────────────────────────────────────
// Reuses the Period Benefits table/validation/action-value mechanism (#487
// stage 1) exactly, as a singleton row whose charge_type is always
// 'membership_fee', server-resolved — never accepted from the client. The
// generic Period Benefits endpoints this once had to be isolated from were
// retired in #550 stage 3 (superseded by /session-benefits, /oneoff-benefits,
// /periodical-benefits below) — /membership-fee-benefit is now the only
// writer of promotion_period_benefits.

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

  // #625: a Promotion Period Benefit can never outlast the Promotion, so the
  // Membership Fee Benefit duration is capped at free + paid + bonus months.
  async function createPromoWithDuration(name: string, free: number, paid: number, bonus: number): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, free_months, paid_months, bonus_months)
       VALUES (?, ?, '2026-08-01', '2026-08-31', 'active', ?, ?, ?)`,
      [gymId, name, free, paid, bonus],
    );
    return insertId;
  }

  it('accepts a duration equal to the promotion duration (Case 1)', async () => {
    const promo = await createPromoWithDuration('MF Dur Eq', 1, 2, 2); // duration 5
    const res = await request
      .put(`/promotions/${promo}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(mfBody({ action: 'fixed_price', value: 100, duration_months: 5 }));
    expect(res.status).toBe(200);
    expect(res.body.duration_months).toBe(5);
  });

  it('accepts a duration below the promotion duration (Case 2)', async () => {
    const promo = await createPromoWithDuration('MF Dur Below', 1, 2, 2); // duration 5
    const res = await request
      .put(`/promotions/${promo}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(mfBody({ action: 'fixed_price', value: 100, duration_months: 3 }));
    expect(res.status).toBe(200);
    expect(res.body.duration_months).toBe(3);
  });

  it('rejects a duration greater than the promotion duration (Case 3)', async () => {
    const promo = await createPromoWithDuration('MF Dur Over', 1, 2, 2); // duration 5
    const res = await request
      .put(`/promotions/${promo}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(mfBody({ action: 'fixed_price', value: 100, duration_months: 7 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/promotion duration/i);
  });

  it('uses free + paid + bonus for the max — not paid alone (Case 5)', async () => {
    const promo = await createPromoWithDuration('MF Dur Sum', 1, 2, 2); // duration 5, paid alone = 2
    // duration 5 is valid because the max is 5, not 2.
    const ok = await request
      .put(`/promotions/${promo}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(mfBody({ action: 'fixed_price', value: 100, duration_months: 5 }));
    expect(ok.status).toBe(200);
  });

  it('rejects any positive duration when the promotion has no duration (Case 6)', async () => {
    const promo = await createPromoWithDuration('MF Dur Zero', 0, 0, 0); // duration 0
    const res = await request
      .put(`/promotions/${promo}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(mfBody({ action: 'fixed_price', value: 100, duration_months: 1 }));
    expect(res.status).toBe(400);
  });

  it('allows a null (unbounded) duration regardless of the promotion duration', async () => {
    const promo = await createPromoWithDuration('MF Dur Null', 0, 0, 0); // duration 0
    const res = await request
      .put(`/promotions/${promo}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(mfBody({ action: 'fixed_price', value: 100 })); // duration_months absent
    expect(res.status).toBe(200);
    expect(res.body.duration_months).toBeNull();
  });

  it('duplicate copies the membership fee benefit', async () => {
    const source = await request
      .post('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      // #625: the benefit duration (6) must fit inside the promotion duration
      // (free + paid + bonus = 6), otherwise the PUT below is rejected.
      .send({ name: 'MF Dup Source', starts_at: '2026-08-01', ends_at: '2026-08-31', free_months: 2, paid_months: 2, bonus_months: 2 });
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

// ─── Suitable Membership Plans (#554) ──────────────────────────────────────────
// GET/PUT /promotions/:id/plans — which active plans a promotion may be
// applied to. Persisted in promotion_membership_plans (added in #26,
// migration 020) and already enforced at apply-time by
// membership-promotions.ts (applyPromotionToMembership / POST
// /user-memberships/:id/promotions both reject a promotion that doesn't
// target the membership's plan) — this ticket adds active-plan validation
// on write plus the frontend section; no new enforcement plumbing beyond that.

describe('Suitable Membership Plans', () => {
  let gymId: string;
  let gymB: string;
  let promoId: number;
  let activePlanA: number;
  let activePlanB: number;
  let inactivePlan: number;
  let otherGymPlan: number;

  beforeAll(async () => {
    gymId = await createTestGym('SMP Gym');
    gymB = await createTestGym('SMP Gym B');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(gymB, 'admin');
    promoId = await createPromo(gymId, 'SMP Promo');
    activePlanA = await createPlan(gymId, `SMP Active A ${Date.now()}`, 'active');
    activePlanB = await createPlan(gymId, `SMP Active B ${Date.now()}`, 'active');
    inactivePlan = await createPlan(gymId, `SMP Inactive ${Date.now()}`, 'inactive');
    otherGymPlan = await createPlan(gymB, `SMP Other Gym ${Date.now()}`, 'active');
  });

  it('GET /:id/plans → 401 without token', async () => {
    const res = await request.get(`/promotions/${promoId}/plans`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('PUT /:id/plans → 403 for a non-admin role (accountant has FINANCIALS read/write, but writes here are admin-only)', async () => {
    const accountantId = 'smp-accountant';
    // This path is matched by both the broad `/promotions` mount and the nested
    // `/promotions/:id` mount, so requireAuth() (and verifyToken) runs twice per
    // request — queue the override identity for both calls.
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: accountantId } as any);
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: accountantId } as any);
    await createTestMembership(gymId, 'accountant', accountantId);
    const res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_ids: [activePlanA] });
    expect(res.status).toBe(403);
  });

  it('GET /:id/plans returns empty initially', async () => {
    const res = await request
      .get(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('PUT /:id/plans rejects a plan belonging to another gym', async () => {
    const res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_ids: [otherGymPlan] });
    expect(res.status).toBe(400);
  });

  it('PUT /:id/plans rejects an inactive plan as a new selection', async () => {
    const res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_ids: [inactivePlan] });
    expect(res.status).toBe(400);
  });

  it('PUT /:id/plans rejects a non-existent plan id', async () => {
    const res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_ids: [999999999] });
    expect(res.status).toBe(400);
  });

  it('PUT /:id/plans accepts active plans and persists the association', async () => {
    const res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_ids: [activePlanA, activePlanB] });
    expect(res.status).toBe(200);
    expect(res.body.membership_plan_ids.sort()).toEqual([activePlanA, activePlanB].sort());

    const getRes = await request
      .get(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(getRes.status).toBe(200);
    expect(getRes.body.map((p: any) => p.id).sort()).toEqual([activePlanA, activePlanB].sort());
    expect(getRes.body.every((p: any) => typeof p.name === 'string')).toBe(true);
  });

  it('PUT /:id/plans dedupes duplicate ids in the request instead of erroring', async () => {
    const res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_ids: [activePlanA, activePlanA, activePlanB] });
    expect(res.status).toBe(200);
    const { rows } = await db.query(
      'SELECT membership_plan_id FROM promotion_membership_plans WHERE promotion_id = ? AND gym_id = ?',
      [promoId, gymId],
    );
    expect(rows).toHaveLength(2);
  });

  it('unchecking (removing) a plan from the selection removes its association', async () => {
    const res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_ids: [activePlanA] });
    expect(res.status).toBe(200);

    const getRes = await request
      .get(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(getRes.body.map((p: any) => p.id)).toEqual([activePlanA]);
  });

  it('preserves a historical association when the associated plan later goes inactive (does not silently drop it on an unrelated re-save)', async () => {
    // Re-associate B alongside A, both active at this point.
    let res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_ids: [activePlanA, activePlanB] });
    expect(res.status).toBe(200);

    // Plan B goes inactive independently of this promotion (e.g. retired by
    // the Membership Plans page).
    await db.query("UPDATE membership_plans SET lifecycle_status = 'inactive' WHERE id = ?", [activePlanB]);

    // The promotion is saved again with the same selection it already had
    // (the admin page always resubmits the full current draft) — this must
    // still succeed, since B was already associated, not newly added.
    res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_ids: [activePlanA, activePlanB] });
    expect(res.status).toBe(200);

    const getRes = await request
      .get(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(getRes.body.map((p: any) => p.id).sort()).toEqual([activePlanA, activePlanB].sort());
  });

  it('PUT /:id/plans is tenant-isolated (gym B cannot modify gym A promo)', async () => {
    const res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ membership_plan_ids: [] });
    expect(res.status).toBe(404);
  });

  it('GET /:id/plans with gym B header returns 404 for gym A promo', async () => {
    // Consistent with the other /:id sub-resources' tenant-isolation
    // behavior in this file — a cross-tenant id never leaks a 200/empty vs.
    // 404 distinction the caller could use to probe for existence.
    const res = await request
      .get(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─── Session / One-off / Periodical benefits (#550 stage 2) ───────────────────
// Replaces the "quantity granted" half of Period/Included Benefits with three
// tables keyed to a real Sellable Item (`gym_charges`) instead of the old
// `charge_types` pseudo-catalog, classified via `classifySellableItem()`.

async function createSellableItem(
  gymId: string,
  name: string,
  type: 'sessions' | 'service' | 'fee' | 'merchandise' | 'other',
  billingFrequency: string | null,
  status: 'active' | 'inactive' = 'active',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_charges (gym_id, name, type, billing_frequency, status, is_system, currency)
     VALUES (?, ?, ?, ?, ?, 0, 'EUR')`,
    [gymId, name, type, billingFrequency, status],
  );
  return insertId;
}

describe.each([
  { path: 'session-benefits', category: 'session' as const },
  { path: 'oneoff-benefits', category: 'oneoff' as const },
  { path: 'periodical-benefits', category: 'periodical' as const },
])('$path', ({ path, category }) => {
  let gymId: string;
  let gymB: string;
  let promoId: number;
  let matchingItemId: number;
  let mismatchedItemId: number;
  let inactiveItemId: number;

  beforeAll(async () => {
    gymId = await createTestGym(`SIB ${category} Gym`);
    gymB = await createTestGym(`SIB ${category} Gym B`);
    await createTestMembership(gymId, 'admin');
    await createTestMembership(gymB, 'admin');
    promoId = await createPromo(gymId, `SIB ${category} Promo`);

    if (category === 'session') {
      matchingItemId = await createSellableItem(gymId, 'Group Class', 'sessions', null);
      mismatchedItemId = await createSellableItem(gymId, 'Locker Rental', 'service', 'month');
    } else if (category === 'oneoff') {
      matchingItemId = await createSellableItem(gymId, 'Registration Fee', 'fee', 'once');
      mismatchedItemId = await createSellableItem(gymId, 'Group Class', 'sessions', null);
    } else {
      matchingItemId = await createSellableItem(gymId, 'Locker Rental', 'service', 'month');
      mismatchedItemId = await createSellableItem(gymId, 'Registration Fee', 'fee', 'once');
    }
    inactiveItemId = await createSellableItem(gymId, 'Retired Item', 'other', null, 'inactive');
  });

  it(`GET /${path} returns empty initially`, async () => {
    const res = await request
      .get(`/promotions/${promoId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it(`PUT /${path} replaces all items for a matching Sellable Item`, async () => {
    const res = await request
      .put(`/promotions/${promoId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: matchingItemId, quantity: 3 }] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].gym_charge_id).toBe(matchingItemId);
    expect(res.body[0].quantity).toBe(3);
    expect(res.body[0].gym_charge_name).toBeDefined();
  });

  it(`GET /${path} returns saved items`, async () => {
    const res = await request
      .get(`/promotions/${promoId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it(`PUT /${path} rejects a Sellable Item that classifies into a different category`, async () => {
    const res = await request
      .put(`/promotions/${promoId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: mismatchedItemId, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it(`PUT /${path} rejects an inactive Sellable Item`, async () => {
    const res = await request
      .put(`/promotions/${promoId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: inactiveItemId, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  // #550: "Existing selected items must remain visible when editing a
  // promotion, even if they are now inactive" — a resubmit of an already-
  // saved selection must not 400 just because the item went inactive after
  // it was selected; only a *new* (not-yet-associated) inactive item is rejected.
  it(`PUT /${path} keeps an already-selected Sellable Item that has since gone inactive`, async () => {
    const goesInactivePromo = await createPromo(gymId, `SIB ${category} Deactivation Promo`);
    const itemId = await createSellableItem(
      gymId,
      `${category} Later Inactive Item`,
      category === 'session' ? 'sessions' : category === 'periodical' ? 'service' : 'fee',
      category === 'periodical' ? 'month' : category === 'session' ? null : 'once',
    );

    const firstSave = await request
      .put(`/promotions/${goesInactivePromo}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: itemId, quantity: 2 }] });
    expect(firstSave.status).toBe(200);

    await db.query("UPDATE gym_charges SET status = 'inactive' WHERE id = ?", [itemId]);

    const resave = await request
      .put(`/promotions/${goesInactivePromo}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: itemId, quantity: 3 }] });
    expect(resave.status).toBe(200);
    expect(resave.body).toHaveLength(1);
    expect(resave.body[0].gym_charge_id).toBe(itemId);
    expect(resave.body[0].quantity).toBe(3);
    expect(resave.body[0].gym_charge_status).toBe('inactive');

    const getRes = await request
      .get(`/promotions/${goesInactivePromo}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(getRes.status).toBe(200);
    expect(getRes.body).toHaveLength(1);
    expect(getRes.body[0].gym_charge_status).toBe('inactive');
  });

  it(`PUT /${path} rejects a non-positive quantity`, async () => {
    const res = await request
      .put(`/promotions/${promoId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: matchingItemId, quantity: 0 }] });
    expect(res.status).toBe(400);
  });

  it(`PUT /${path} rejects a duplicate gym_charge_id within the same request`, async () => {
    const res = await request
      .put(`/promotions/${promoId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [
          { gym_charge_id: matchingItemId, quantity: 1 },
          { gym_charge_id: matchingItemId, quantity: 2 },
        ],
      });
    expect(res.status).toBe(400);
  });

  it(`PUT /${path} is tenant-isolated (gym B cannot modify gym A promo)`, async () => {
    const res = await request
      .put(`/promotions/${promoId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ items: [] });
    expect(res.status).toBe(404);
  });

  it(`PUT /${path} → 403 for a non-admin role`, async () => {
    const trainerGymId = await createTestGym(`SIB ${category} Trainer Gym`);
    await createTestMembership(trainerGymId, 'front_desk');
    const trainerPromoId = await createPromo(trainerGymId, `SIB ${category} Trainer Promo`);
    const res = await request
      .put(`/promotions/${trainerPromoId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', trainerGymId)
      .send({ items: [] });
    expect(res.status).toBe(403);
  });
});

describe('Session / One-off / Periodical benefits — duplicate', () => {
  let gymId: string;
  let promoId: number;
  let sessionItemId: number;

  beforeAll(async () => {
    gymId = await createTestGym('SIB Duplicate Gym');
    await createTestMembership(gymId, 'admin');
    promoId = await createPromo(gymId, 'SIB Duplicate Promo');
    sessionItemId = await createSellableItem(gymId, 'Group Class', 'sessions', null);
    await request
      .put(`/promotions/${promoId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: sessionItemId, quantity: 2 }] });
  });

  it('duplicate copies session/one-off/periodical benefits', async () => {
    const dupRes = await request
      .post(`/promotions/${promoId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dupRes.status).toBe(201);
    const newId = dupRes.body.id;

    const res = await request
      .get(`/promotions/${newId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].gym_charge_id).toBe(sessionItemId);
    expect(res.body[0].quantity).toBe(2);
  });
});
