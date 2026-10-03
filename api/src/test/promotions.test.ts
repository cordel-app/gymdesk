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
import { PROMOTION_TARGETS } from '../domain/promotionTarget';

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

// ─── Only applicable for new members (#633) ──────────────────────────────────

// The flag is stored and returned only — no eligibility, stacking or
// assign-plan behaviour keys off it yet (#633 §5), so these tests assert
// persistence and the create-time default, not any application logic.
describe('only_applicable_for_new_members', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('New Members Flag Gym');
    await createTestMembership(gymId, 'admin');
  });

  function post(body: Record<string, unknown>) {
    return request
      .post('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Flag Promo', starts_at: '2026-08-01', ends_at: '2026-08-31', ...body });
  }

  it('POST defaults the flag to true when it is omitted', async () => {
    const res = await post({});
    expect(res.status).toBe(201);
    expect(res.body.only_applicable_for_new_members).toBe(1);
  });

  it('POST persists false when the flag is unchecked', async () => {
    const res = await post({ only_applicable_for_new_members: false });
    expect(res.status).toBe(201);
    expect(res.body.only_applicable_for_new_members).toBe(0);
  });

  it('GET list and GET /:id return the flag', async () => {
    const created = await post({ only_applicable_for_new_members: false });
    const id = created.body.id;

    const list = await request
      .get('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list.status).toBe(200);
    expect(list.body.find((p: any) => p.id === id).only_applicable_for_new_members).toBe(0);

    const detail = await request
      .get(`/promotions/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(detail.status).toBe(200);
    expect(detail.body.only_applicable_for_new_members).toBe(0);
  });

  it('PUT updates the flag, and leaves it untouched when omitted', async () => {
    const created = await post({});
    const id = created.body.id;

    const off = await request
      .put(`/promotions/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ only_applicable_for_new_members: false });
    expect(off.status).toBe(200);
    expect(off.body.only_applicable_for_new_members).toBe(0);

    // A PUT that carries other fields must not reset the flag to its default.
    const untouched = await request
      .put(`/promotions/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Flag Promo Renamed' });
    expect(untouched.status).toBe(200);
    expect(untouched.body.only_applicable_for_new_members).toBe(0);

    const on = await request
      .put(`/promotions/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ only_applicable_for_new_members: true });
    expect(on.status).toBe(200);
    expect(on.body.only_applicable_for_new_members).toBe(1);
  });

  it('duplicate carries the flag over', async () => {
    const created = await post({ only_applicable_for_new_members: false });
    const dup = await request
      .post(`/promotions/${created.body.id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dup.status).toBe(201);
    expect(dup.body.only_applicable_for_new_members).toBe(0);
  });

  it('existing promotions inserted without the column default to true', async () => {
    // Mirrors the migration's backfill: rows that predate the flag read as 1.
    const legacyId = await createPromo(gymId, 'Legacy Flag Promo');
    const res = await request
      .get(`/promotions/${legacyId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.only_applicable_for_new_members).toBe(1);
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
// A singleton row per Promotion in `promotion_membership_fee_benefits`
// (#635 stage 5, migration 179), which replaced the row this benefit used to
// squat in `promotion_period_benefits` — a table keyed to the `charge_types`
// pseudo-catalog, dropped by the same migration along with
// `promotion_charge_benefits` and `promotion_included_benefits`. There is no
// item to choose here and never was, so the payload no longer carries one.

describe('Membership Fee Benefit', () => {
  let gymId: string;
  let gymB: string;
  let promoId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MF Benefit Gym');
    gymB = await createTestGym('MF Benefit Gym B');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(gymB, 'admin');
    promoId = await createPromo(gymId, 'MF Benefit Promo');
  });

  // #814: the benefit is duration + action + value + enabled. The PUT used to
  // require `quantity`/`frequency_interval`/`frequency_unit` in every body;
  // migration 199 dropped the columns and the validation went with them, so a
  // body carries only what is still configurable.
  function mfBody(overrides: Record<string, any> = {}) {
    return { ...overrides };
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

  it('PUT /membership-fee-benefit round-trips each of the 5 actions', async () => {
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
      // #635 stage 5: no charge_type_* triplet — the benefit is keyed to the
      // Promotion alone.
      expect(res.body.charge_type_id).toBeUndefined();
      expect(res.body.charge_type_code).toBeUndefined();
      expect(res.body.promotion_id).toBe(promoId);
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
      'SELECT COUNT(*) AS n FROM promotion_membership_fee_benefits WHERE promotion_id = ?',
      [promoId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('a charge_type_id in the request body is ignored — the benefit has no item', async () => {
    const otherCtId = await getChargeTypeId('nutrition_service');
    const res = await request
      .put(`/promotions/${promoId}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(mfBody({ charge_type_id: otherCtId, action: 'waive' }));
    expect(res.status).toBe(200);
    expect(res.body.charge_type_id).toBeUndefined();
    expect(res.body.action).toBe('waive');
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

  // ── #814: no recurrence on the Membership Fee Benefit ───────────────────
  const REMOVED_RECURRENCE_FIELDS = ['quantity', 'frequency_interval', 'frequency_unit'] as const;

  it('PUT /membership-fee-benefit succeeds with no recurrence fields at all', async () => {
    const promo = await createPromo(gymId, 'MF No Recurrence');
    const res = await request
      .put(`/promotions/${promo}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ action: 'percentage_discount', value: 50, enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('percentage_discount');
    expect(parseFloat(res.body.value)).toBeCloseTo(50, 2);
    expect(Number(res.body.enabled)).toBe(1);
  });

  it('neither GET nor PUT exposes quantity, frequency_interval or frequency_unit', async () => {
    const promo = await createPromo(gymId, 'MF Shape');
    const put = await request
      .put(`/promotions/${promo}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ action: 'waive' });
    expect(put.status).toBe(200);
    const get = await request
      .get(`/promotions/${promo}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(get.status).toBe(200);
    for (const field of REMOVED_RECURRENCE_FIELDS) {
      expect(put.body[field]).toBeUndefined();
      expect(get.body[field]).toBeUndefined();
    }
  });

  it('a stale client still sending the recurrence fields is accepted, and they are ignored', async () => {
    const promo = await createPromo(gymId, 'MF Stale Client');
    const res = await request
      .put(`/promotions/${promo}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ quantity: 2, frequency_interval: 3, frequency_unit: 'week', action: 'fixed_price', value: 40 });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('fixed_price');
    for (const field of REMOVED_RECURRENCE_FIELDS) {
      expect(res.body[field]).toBeUndefined();
    }
  });

  it('a non-positive quantity or frequency_interval is no longer a validation error', async () => {
    const promo = await createPromo(gymId, 'MF No Recurrence Validation');
    for (const body of [
      { quantity: 0, action: 'waive' },
      { frequency_interval: 0, action: 'waive' },
      { frequency_unit: 'decade', action: 'waive' },
    ]) {
      const res = await request
        .put(`/promotions/${promo}/membership-fee-benefit`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send(body);
      expect(res.status).toBe(200);
    }
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

// ─── Charge Benefits are gone from Promotions (#635 stage 5) ─────────────────
// #626 removed the Promotion's Charge Benefits editor; stage 5 removed the
// endpoints and the table behind them (migration 179). The Membership Fee
// Benefit — the only one that ever reached billing — lives in
// `promotion_membership_fee_benefits` and is covered above.

describe('Promotion Charge Benefits are retired', () => {
  let gymId: string;
  let promoId: number;

  beforeAll(async () => {
    gymId = await createTestGym('CB Retired Gym');
    await createTestMembership(gymId, 'admin');
    promoId = await createPromo(gymId, 'CB Retired Promo');
  });

  it('no longer routes GET /promotions/:id/charge-benefits', async () => {
    const res = await request
      .get(`/promotions/${promoId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('no longer routes PUT /promotions/:id/charge-benefits', async () => {
    const res = await request
      .put(`/promotions/${promoId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [] });
    expect(res.status).toBe(404);
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
// tables keyed to a real Product (`gym_charges`) instead of the old
// `charge_types` pseudo-catalog, classified via `classifyProduct()`.

async function createProduct(
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
      matchingItemId = await createProduct(gymId, 'Group Class', 'sessions', null);
      mismatchedItemId = await createProduct(gymId, 'Locker Rental', 'service', 'month');
    } else if (category === 'oneoff') {
      matchingItemId = await createProduct(gymId, 'Registration Fee', 'fee', 'once');
      mismatchedItemId = await createProduct(gymId, 'Group Class', 'sessions', null);
    } else {
      matchingItemId = await createProduct(gymId, 'Locker Rental', 'service', 'month');
      mismatchedItemId = await createProduct(gymId, 'Registration Fee', 'fee', 'once');
    }
    inactiveItemId = await createProduct(gymId, 'Retired Item', 'other', null, 'inactive');
  });

  it(`GET /${path} returns empty initially`, async () => {
    const res = await request
      .get(`/promotions/${promoId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it(`PUT /${path} replaces all items for a matching Product`, async () => {
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

  it(`PUT /${path} rejects a Product that classifies into a different category`, async () => {
    const res = await request
      .put(`/promotions/${promoId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: mismatchedItemId, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it(`PUT /${path} rejects an inactive Product`, async () => {
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
  it(`PUT /${path} keeps an already-selected Product that has since gone inactive`, async () => {
    const goesInactivePromo = await createPromo(gymId, `SIB ${category} Deactivation Promo`);
    const itemId = await createProduct(
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
    sessionItemId = await createProduct(gymId, 'Group Class', 'sessions', null);
    await request
      .put(`/promotions/${promoId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{ gym_charge_id: sessionItemId, quantity: 2, action: 'fixed_price', value: 25 }],
      });
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
    // #896 stage 2: Duplicate is a copy, so the pricing treatment travels too.
    expect(res.body[0].action).toBe('fixed_price');
    expect(res.body[0].value).toBe(25);
  });
});

// ─── GET /promotions?membership_plan_id= (#628) ───────────────────────────────

describe('GET /promotions — membership_plan_id filter', () => {
  let gymId: string;
  let planA: number;
  let planB: number;
  let promoForA: number;
  let promoForB: number;

  beforeAll(async () => {
    gymId = await createTestGym('Promo Plan Filter Gym');
    await createTestMembership(gymId, 'admin');
    planA = await createPlan(gymId, `PPF Plan A ${Date.now()}`, 'active');
    planB = await createPlan(gymId, `PPF Plan B ${Date.now()}`, 'active');
    promoForA = await createPromo(gymId, 'PPF Promo A');
    promoForB = await createPromo(gymId, 'PPF Promo B');
    await db.query(
      'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promoForA, planA],
    );
    await db.query(
      'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promoForB, planB],
    );
  });

  it('returns 401 without a token', async () => {
    const res = await request.get(`/promotions?membership_plan_id=${planA}`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns only the promotions targeting the given plan', async () => {
    const res = await request
      .get(`/promotions?membership_plan_id=${planA}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((p: any) => p.id);
    expect(ids).toContain(promoForA);
    expect(ids).not.toContain(promoForB);
  });

  it("does not leak another gym's targeting rows", async () => {
    const gymB = await createTestGym('Promo Plan Filter Gym B');
    await createTestMembership(gymB, 'admin', 'ppf-other-admin');
    const res = await request
      .get(`/promotions?membership_plan_id=${planA}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.every((p: any) => p.gym_id === gymId)).toBe(true);
  });

  it('returns 400 for a non-numeric membership_plan_id', async () => {
    const res = await request
      .get('/promotions?membership_plan_id=abc')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('is ignored when omitted (all promotions still returned)', async () => {
    const res = await request
      .get('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((p: any) => p.id);
    expect(ids).toContain(promoForA);
    expect(ids).toContain(promoForB);
  });
});

// ─── The grant's pricing treatment (#896 stage 2) ─────────────────────────────

describe('Promotion benefit actions', () => {
  let gymId: string;
  let promoId: number;
  let itemId: number;

  const putSession = (items: unknown[]) => request
    .put(`/promotions/${promoId}/session-benefits`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ items });

  beforeAll(async () => {
    gymId = await createTestGym('SIB Action Gym');
    await createTestMembership(gymId, 'admin');
    promoId = await createPromo(gymId, 'SIB Action Promo');
    itemId = await createProduct(gymId, 'Action Group Class', 'sessions', null);
  });

  it('defaults a brand new grant to the neutral action', async () => {
    const res = await putSession([{ gym_charge_id: itemId, quantity: 3 }]);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ quantity: 3, action: 'no_benefit', value: null });
  });

  it('stores all five actions a Promotion may configure', async () => {
    for (const [action, value] of [
      ['waive', null], ['percentage_discount', 20], ['fixed_discount', 5], ['fixed_price', 12],
      ['no_benefit', null],
    ] as const) {
      const res = await putSession([
        value == null
          ? { gym_charge_id: itemId, quantity: 3, action }
          : { gym_charge_id: itemId, quantity: 3, action, value },
      ]);
      expect(res.status).toBe(200);
      // The value comes back a number, not mysql2's DECIMAL string.
      expect(res.body[0]).toMatchObject({ action, value: value ?? null });
    }
  });

  it('keeps a stored treatment when the save does not mention it', async () => {
    // This is what protects migration 203's `waive` backfill: a grant configured
    // before stage 4's editor exists must not be rewritten to "charge the normal
    // price" by an unrelated quantity edit.
    await putSession([{ gym_charge_id: itemId, quantity: 3, action: 'waive' }]);
    const res = await putSession([{ gym_charge_id: itemId, quantity: 8 }]);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ quantity: 8, action: 'waive', value: null });
  });

  it('refuses a missing, out-of-range or superfluous value', async () => {
    expect((await putSession([{ gym_charge_id: itemId, quantity: 1, action: 'fixed_price' }])).status)
      .toBe(400);
    expect((await putSession([{ gym_charge_id: itemId, quantity: 1, action: 'percentage_discount', value: 120 }])).status)
      .toBe(400);
    expect((await putSession([{ gym_charge_id: itemId, quantity: 1, action: 'no_benefit', value: 5 }])).status)
      .toBe(400);
    expect((await putSession([{ gym_charge_id: itemId, quantity: 1, action: 'nonsense' }])).status)
      .toBe(400);
    const orphanValue = await putSession([{ gym_charge_id: itemId, quantity: 1, value: 20 }]);
    expect(orphanValue.status).toBe(400);
    expect(orphanValue.body.error).toBe('value requires an action');
  });

  it('leaves the section untouched when one line is rejected', async () => {
    const before = await request
      .get(`/promotions/${promoId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    await putSession([{ gym_charge_id: itemId, quantity: 1, action: 'percentage_discount', value: -1 }]);
    const after = await request
      .get(`/promotions/${promoId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(after.body).toEqual(before.body);
  });
});

// ─── Applies To (#926) ───────────────────────────────────────────────────────

// `promotions.applies_to` (migration 204) is configuration and nothing else in
// this ticket: no apply, pricing or snapshot path reads it. It decides which
// sections the Promotion editor shows, so these tests assert persistence, the
// create-time default, the accepted set — and, most importantly, that switching
// the target reinterprets none of the Membership-Plan-specific configuration
// already stored (§4).
describe('applies_to', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Applies To Gym');
    await createTestMembership(gymId, 'admin');
  });

  function post(body: Record<string, unknown>) {
    return request
      .post('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `AT ${Date.now()}-${Math.random()}`, starts_at: '2026-08-01', ends_at: '2026-08-31', ...body });
  }

  it('POST defaults to membership_plan when the field is omitted', async () => {
    const res = await post({});
    expect(res.status).toBe(201);
    expect(res.body.applies_to).toBe('membership_plan');
  });

  // Every accepted target, not just the new one: this is the only test that
  // exercises `chk_promotions_applies_to` itself, so a value the domain module
  // accepts and the CHECK does not has to fail here rather than in production.
  it('POST stores every target the domain module accepts', async () => {
    for (const target of PROMOTION_TARGETS) {
      const res = await post({ applies_to: target });
      expect(res.status, `${target}: ${JSON.stringify(res.body)}`).toBe(201);
      expect(res.body.applies_to).toBe(target);
    }
  });

  it('POST rejects a target outside the accepted set', async () => {
    const res = await post({ applies_to: 'bundle' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('applies_to');
  });

  it('GET list and GET /:id both report the stored target', async () => {
    const created = await post({ applies_to: 'sellable_item' });
    const id = created.body.id;

    const list = await request
      .get('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list.status).toBe(200);
    expect(list.body.find((p: any) => p.id === id)?.applies_to).toBe('sellable_item');

    const one = await request
      .get(`/promotions/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(one.status).toBe(200);
    expect(one.body.applies_to).toBe('sellable_item');
  });

  it('PUT switches the target, and rejects an unknown one', async () => {
    const created = await post({});
    const id = created.body.id;

    const bad = await request
      .put(`/promotions/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ applies_to: 'nonsense' });
    expect(bad.status).toBe(400);

    const ok = await request
      .put(`/promotions/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ applies_to: 'sellable_item' });
    expect(ok.status).toBe(200);
    expect(ok.body.applies_to).toBe('sellable_item');
  });

  it('PUT leaves the target alone when the body does not name it', async () => {
    const created = await post({ applies_to: 'sellable_item' });
    const id = created.body.id;
    const res = await request
      .put(`/promotions/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ description: 'renamed, target untouched' });
    expect(res.status).toBe(200);
    expect(res.body.applies_to).toBe('sellable_item');
  });

  // §4: "Changing the target should not silently migrate or reinterpret
  // existing configuration." The two Membership-Plan-specific sub-resources are
  // the Membership Fee Benefit and Suitable Membership Plans, and a round trip
  // through sellable_item has to leave both exactly as they were — that is what
  // makes hiding the sections safe rather than destructive.
  it('switching the target keeps the Membership-Plan-specific configuration', async () => {
    const created = await post({ paid_months: 3 });
    const id = created.body.id;
    const planId = await createPlan(gymId, `AT Plan ${Date.now()}`, 'active');

    const plans = await request
      .put(`/promotions/${id}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_ids: [planId] });
    expect(plans.status).toBe(200);

    const mf = await request
      .put(`/promotions/${id}/membership-fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ duration_months: 2, enabled: true, action: 'percentage_discount', value: 25 });
    expect(mf.status).toBe(200);

    for (const target of ['sellable_item', 'membership_plan']) {
      const res = await request
        .put(`/promotions/${id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ applies_to: target });
      expect(res.status).toBe(200);
      expect(res.body.applies_to).toBe(target);

      const { rows: planRows } = await db.query(
        'SELECT membership_plan_id FROM promotion_membership_plans WHERE promotion_id = ? AND gym_id = ?',
        [id, gymId],
      );
      expect(planRows.map((r: any) => r.membership_plan_id)).toEqual([planId]);

      const { rows: mfRows } = await db.query(
        'SELECT action, value, duration_months FROM promotion_membership_fee_benefits WHERE promotion_id = ? AND gym_id = ?',
        [id, gymId],
      );
      expect(mfRows).toHaveLength(1);
      expect(mfRows[0].action).toBe('percentage_discount');
      expect(Number(mfRows[0].value)).toBe(25);
      expect(mfRows[0].duration_months).toBe(2);
    }
  });

  it('POST /:id/duplicate copies the target verbatim', async () => {
    const created = await post({ applies_to: 'sellable_item' });
    const res = await request
      .post(`/promotions/${created.body.id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.applies_to).toBe('sellable_item');
  });

  it('refuses a target the CHECK would reject, rather than letting the database answer', async () => {
    // The 400 above is the router's; this asserts the other half of the pair —
    // the CHECK migration 204 adds — so a future writer that skipped the
    // validation still cannot store a third value.
    await expect(
      db.query(
        `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, applies_to)
         VALUES (?, ?, '2026-08-01', '2026-08-31', 'active', 'bundle')`,
        [gymId, `AT Check ${Date.now()}`],
      ),
    ).rejects.toThrow();
  });
});
