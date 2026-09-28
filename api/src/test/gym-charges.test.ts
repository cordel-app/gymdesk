// Tests for sellable-items.ts router (formerly gym-charges)

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

/**
 * Replicates the seeding that platformRouter.post('/gyms') runs.
 * createTestGym uses a direct INSERT so the trigger in the route handler
 * does not fire — we must seed gym_charges manually in tests.
 */
async function seedGymCharges(gymId: string): Promise<void> {
  await db.query(
    `INSERT IGNORE INTO gym_charges (gym_id, charge_type_id, name, type, is_system, created_at)
     SELECT ?, id, name, 'fee', 1, UTC_TIMESTAMP() FROM charge_types WHERE is_gym_charge = 1`,
    [gymId],
  );
}

/** Returns the id of the first gym_charge row for the given gym, or undefined. */
async function firstChargeId(gymId: string): Promise<number | undefined> {
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM gym_charges WHERE gym_id = ? ORDER BY id ASC LIMIT 1',
    [gymId],
  );
  return rows[0]?.id;
}

/** Inserts a custom tax rate directly and returns its id (mirrors createTestGym-style direct seeding). */
async function createTaxRate(gymId: string, name: string, ratePercent: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status, created_at)
     VALUES (?, ?, ?, 0, 'active', UTC_TIMESTAMP())`,
    [gymId, name, ratePercent],
  );
  return insertId;
}

/** Inserts a custom (non-system) professional_services row for a gym directly, mirroring professional-services.test.ts. */
async function createProfessionalService(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)`,
    [gymId, name],
  );
  await db.query(
    `INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`,
    [gymId, insertId],
  );
  return insertId;
}

/**
 * Resolves the id of a migration-seeded global system Professional Service
 * (gym_id IS NULL) by its system_key, mirroring professional-services.test.ts.
 * createTestGym() bypasses the POST /gyms seeding trigger, so a fresh test
 * gym has no gym_professional_services row for these — used to verify that
 * linking a system service does not depend on that per-gym row existing.
 */
let _systemServiceIdsBySystemKey: Record<string, number> | null = null;
async function systemProfessionalServiceId(systemKey: string): Promise<number> {
  if (!_systemServiceIdsBySystemKey) {
    const { rows } = await db.query<{ id: number; system_key: string }>(
      'SELECT id, system_key FROM professional_services WHERE is_system = 1',
    );
    _systemServiceIdsBySystemKey = {};
    for (const row of rows) _systemServiceIdsBySystemKey[row.system_key] = row.id;
  }
  const id = _systemServiceIdsBySystemKey[systemKey];
  if (id === undefined) throw new Error(`No seeded system professional service with system_key=${systemKey}`);
  return id;
}

// ─── GET /sellable-items ─────────────────────────────────────────────────────────

describe('GET /sellable-items', () => {
  let gymId: string;
  let gymNoModule: string;  // trainer_performance — FINANCIALS = NONE → 403
  let gymReadOnly: string;  // accountant — FINANCIALS = R → 200
  let gymNoMembership: string; // TEST_USER_ID has no row here → 403

  beforeAll(async () => {
    gymId = await createTestGym('Charges Admin Gym');
    await createTestMembership(gymId, 'admin');
    await seedGymCharges(gymId);

    gymNoModule = await createTestGym('Charges No Module Gym');
    await createTestMembership(gymNoModule, 'trainer_performance');

    gymReadOnly = await createTestGym('Charges Read Only Gym');
    await createTestMembership(gymReadOnly, 'accountant');
    await seedGymCharges(gymReadOnly);

    // Intentionally no createTestMembership call — user has no row in this gym.
    gymNoMembership = await createTestGym('Charges No Membership Gym');
  });

  it('returns 401 without auth', async () => {
    const res = await request.get('/sellable-items').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in the gym (tenant isolation)', async () => {
    const res = await request
      .get('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoMembership);
    expect(res.status).toBe(403);
  });

  it('returns 403 when the role has no FINANCIALS module access (trainer_performance)', async () => {
    const res = await request
      .get('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoModule);
    expect(res.status).toBe(403);
  });

  it('returns 200 with an array for admin', async () => {
    const res = await request
      .get('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns 200 with an array for accountant (FINANCIALS read-only access)', async () => {
    const res = await request
      .get('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymReadOnly);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // #543: charge-type-based system items must always have a name/type — a
  // NULL name/type renders as a blank name + "type_null" in the admin UI.
  it('returns non-null name/type for every charge-type-based system item', async () => {
    const res = await request
      .get('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const systemItems = (res.body as Array<{ charge_type_id: number | null; name: string | null; type: string | null }>)
      .filter((item) => item.charge_type_id !== null);
    expect(systemItems.length).toBeGreaterThan(0);
    for (const item of systemItems) {
      expect(item.name).not.toBeNull();
      expect(item.type).toBe('fee');
    }
  });
});

// ─── GET /sellable-items/:id ─────────────────────────────────────────────────────

describe('GET /sellable-items/:id', () => {
  let gymA: string;
  let gymB: string;

  beforeAll(async () => {
    gymA = await createTestGym('Charges GET Gym A');
    await createTestMembership(gymA, 'admin');
    await seedGymCharges(gymA);

    gymB = await createTestGym('Charges GET Gym B');
    await createTestMembership(gymB, 'admin');
    await seedGymCharges(gymB);
  });

  it('returns 200 for a valid charge id belonging to the gym', async () => {
    const chargeId = await firstChargeId(gymA);
    if (!chargeId) return; // no is_gym_charge rows in this DB — skip gracefully

    const res = await request
      .get(`/sellable-items/${chargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(chargeId);
    expect(res.body.gym_id).toBe(gymA);
  });

  it('returns 404 when the charge belongs to a different gym (cross-gym isolation)', async () => {
    const chargeId = await firstChargeId(gymA);
    if (!chargeId) return; // no is_gym_charge rows in this DB — skip gracefully

    // chargeId is from gymA; request scoped to gymB → WHERE id = ? AND gym_id = ? → empty
    const res = await request
      .get(`/sellable-items/${chargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });
});

// ─── GET /sellable-items filters ─────────────────────────────────────────────────

describe('GET /sellable-items filters', () => {
  let gymId: string;
  let activeChargeId: number | undefined;

  beforeAll(async () => {
    gymId = await createTestGym('Charges Filter Gym');
    await createTestMembership(gymId, 'admin');
    await seedGymCharges(gymId);

    // Mark the first charge active and a second inactive for filter tests.
    const { rows: charges } = await db.query<{ id: number }>(
      'SELECT id FROM gym_charges WHERE gym_id = ? ORDER BY id ASC LIMIT 2',
      [gymId],
    );
    if (charges.length >= 1) {
      activeChargeId = charges[0].id;
      await db.query(`UPDATE gym_charges SET status = 'active' WHERE id = ?`, [charges[0].id]);
    }
    if (charges.length >= 2) {
      await db.query(`UPDATE gym_charges SET status = 'inactive' WHERE id = ?`, [charges[1].id]);
    }
  });

  it('returns 400 for an invalid status query value', async () => {
    const res = await request
      .get('/sellable-items?status=bad')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid type query value', async () => {
    const res = await request
      .get('/sellable-items?type=bad')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid enrollment_status query value', async () => {
    const res = await request
      .get('/sellable-items?enrollment_status=bad')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('returns only active charges when ?status=active', async () => {
    const res = await request
      .get('/sellable-items?status=active')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.every((c: { status: string }) => c.status === 'active')).toBe(true);
  });

  it('returns only inactive charges when ?status=inactive', async () => {
    const res = await request
      .get('/sellable-items?status=inactive')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.every((c: { status: string }) => c.status === 'inactive')).toBe(true);
  });

  it('charge moves to ?status=inactive after deactivate endpoint', async () => {
    if (!activeChargeId) return;

    const deactivate = await request
      .post(`/sellable-items/${activeChargeId}/deactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.status).toBe('inactive');

    const after = await request
      .get('/sellable-items?status=inactive')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(after.status).toBe(200);
    const ids = (after.body as Array<{ id: number }>).map((c) => c.id);
    expect(ids).toContain(activeChargeId);
  });
});

// ─── PUT /sellable-items/:id ─────────────────────────────────────────────────────

describe('PUT /sellable-items/:id', () => {
  let gymAdmin: string;    // TEST_USER_ID = admin here → PUT allowed
  let gymAccountant: string; // TEST_USER_ID = accountant here → PUT blocked by requireRole
  let gymOther: string;    // used as cross-gym isolation source

  beforeAll(async () => {
    gymAdmin = await createTestGym('Charges PUT Admin Gym');
    await createTestMembership(gymAdmin, 'admin');
    await seedGymCharges(gymAdmin);

    gymAccountant = await createTestGym('Charges PUT Accountant Gym');
    await createTestMembership(gymAccountant, 'accountant');
    await seedGymCharges(gymAccountant);

    gymOther = await createTestGym('Charges PUT Other Gym');
    await createTestMembership(gymOther, 'admin');
    await seedGymCharges(gymOther);
  });

  it('returns 403 for accountant role (FINANCIALS access granted but requireRole("admin") blocks PUT)', async () => {
    const chargeId = await firstChargeId(gymAccountant);
    if (!chargeId) return; // no is_gym_charge rows in this DB — skip gracefully

    const res = await request
      .put(`/sellable-items/${chargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymAccountant)
      .send({ amount: 9.99, billing_frequency: 'month', availability: 'available' });
    expect(res.status).toBe(403);
  });

  it('returns 200 for admin and reflects updated values in the response', async () => {
    const chargeId = await firstChargeId(gymAdmin);
    if (!chargeId) return; // no is_gym_charge rows in this DB — skip gracefully

    const payload = {
      amount: 49.99,
      billing_frequency: 'month',
      status: 'active',
      notes: 'Updated by test',
    };

    const res = await request
      .put(`/sellable-items/${chargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymAdmin)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(chargeId);
    expect(parseFloat(res.body.amount)).toBeCloseTo(49.99, 2);
    expect(res.body.billing_frequency).toBe('month');
    expect(res.body.status).toBe('active');
    expect(res.body.notes).toBe('Updated by test');
  });

  it('accepts billing_frequency = four_weeks on update', async () => {
    const chargeId = await firstChargeId(gymAdmin);
    if (!chargeId) return; // no is_gym_charge rows in this DB — skip gracefully

    const res = await request
      .put(`/sellable-items/${chargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymAdmin)
      .send({ billing_frequency: 'four_weeks' });
    expect(res.status).toBe(200);
    expect(res.body.billing_frequency).toBe('four_weeks');
  });

  it('returns 404 when the charge belongs to a different gym (cross-gym isolation on write)', async () => {
    // chargeId comes from gymOther; request scoped to gymAdmin → WHERE id = ? AND gym_id = ? → 0 rows
    const chargeId = await firstChargeId(gymOther);
    if (!chargeId) return; // no is_gym_charge rows in this DB — skip gracefully

    const res = await request
      .put(`/sellable-items/${chargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymAdmin)
      .send({ amount: 1.0 });
    expect(res.status).toBe(404);
  });
});

// ─── enrollment_status ────────────────────────────────────────────────────────

describe('Sellable Item enrollment_status', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Charges Enrollment Gym');
    await createTestMembership(gymId, 'admin');
    await seedGymCharges(gymId);
  });

  it('defaults new custom items to enrollment_status = public', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Public By Default', type: 'fee', amount: 10 });
    expect(res.status).toBe(201);
    expect(res.body.enrollment_status).toBe('public');
  });

  it('creates a custom item with an explicit enrollment_status = staff_only', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Internal Only Item', type: 'fee', amount: 10, enrollment_status: 'staff_only' });
    expect(res.status).toBe(201);
    expect(res.body.enrollment_status).toBe('staff_only');
  });

  it('returns 400 for an invalid enrollment_status on create', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Bad Enrollment', type: 'fee', enrollment_status: 'members_only' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid enrollment_status on update', async () => {
    const chargeId = await firstChargeId(gymId);
    if (!chargeId) return; // no is_gym_charge rows in this DB — skip gracefully

    const res = await request
      .put(`/sellable-items/${chargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'members_only' });
    expect(res.status).toBe(400);
  });

  it('updates enrollment_status to staff_only and back to public independently of status', async () => {
    const chargeId = await firstChargeId(gymId);
    if (!chargeId) return; // no is_gym_charge rows in this DB — skip gracefully

    const toStaffOnly = await request
      .put(`/sellable-items/${chargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ status: 'active', enrollment_status: 'staff_only' });
    expect(toStaffOnly.status).toBe(200);
    expect(toStaffOnly.body.status).toBe('active');
    expect(toStaffOnly.body.enrollment_status).toBe('staff_only');

    const backToPublic = await request
      .put(`/sellable-items/${chargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'public' });
    expect(backToPublic.status).toBe(200);
    expect(backToPublic.body.enrollment_status).toBe('public');
    // status is left untouched by the enrollment_status-only update
    expect(backToPublic.body.status).toBe('active');
  });

  it('filters by ?enrollment_status=staff_only', async () => {
    const chargeId = await firstChargeId(gymId);
    if (!chargeId) return; // no is_gym_charge rows in this DB — skip gracefully

    await request
      .put(`/sellable-items/${chargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'staff_only' });

    const res = await request
      .get('/sellable-items?enrollment_status=staff_only')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.every((c: { enrollment_status: string }) => c.enrollment_status === 'staff_only')).toBe(true);
    expect((res.body as Array<{ id: number }>).map((c) => c.id)).toContain(chargeId);
  });

  it('deactivating an item does not change its enrollment_status', async () => {
    const chargeId = await firstChargeId(gymId);
    if (!chargeId) return; // no is_gym_charge rows in this DB — skip gracefully

    await request
      .put(`/sellable-items/${chargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ status: 'active', enrollment_status: 'public' });

    const deactivate = await request
      .post(`/sellable-items/${chargeId}/deactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.status).toBe('inactive');
    expect(deactivate.body.enrollment_status).toBe('public');
  });
});

// ─── POST /sellable-items — create custom sellable item ─────────────────────────

describe('POST /sellable-items', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Charges POST Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ type: 'fee', amount: 10 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when type is missing', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Test Item' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when units is not a positive integer', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Bad Units', type: 'sessions', units: -5 });
    expect(res.status).toBe(400);
  });

  it('creates a custom sellable item and returns 201 with is_system = 0', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'Custom Fee',
        type: 'fee',
        amount: 25.0,
        billing_frequency: 'month',
        description: 'A custom test fee',
      });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Custom Fee');
    expect(res.body.type).toBe('fee');
    expect(res.body.is_system).toBe(0);
    expect(parseFloat(res.body.amount)).toBeCloseTo(25.0, 2);
  });

  it('creates a sessions item with units', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Session Pack 10', type: 'sessions', units: 10, amount: 90 });
    expect(res.status).toBe(201);
    expect(res.body.units).toBe(10);
    expect(res.body.type).toBe('sessions');
  });

  it('creates an item with billing_frequency = four_weeks', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: '4-Week Package', type: 'sessions', units: 10, amount: 90, billing_frequency: 'four_weeks' });
    expect(res.status).toBe(201);
    expect(res.body.billing_frequency).toBe('four_weeks');
  });

  it('returns 400 for an invalid billing_frequency', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Bad Frequency', type: 'fee', amount: 10, billing_frequency: 'fortnight' });
    expect(res.status).toBe(400);
  });

  // #821: 'week' left the product surface. It is still a value the column may
  // hold (migration 123's CHECK is untouched, so rows written before the ticket
  // stay valid), but no new item may be created on it.
  it('returns 400 for billing_frequency = week and writes nothing', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Weekly Locker', type: 'service', amount: 5, billing_frequency: 'week' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('no longer offered');
    const { rows } = await db.query(
      'SELECT id FROM gym_charges WHERE gym_id = ? AND name = ?',
      [gymId, 'Weekly Locker'],
    );
    expect(rows).toHaveLength(0);
  });

  it('creates an item on each offered billing_frequency', async () => {
    for (const freq of ['once', 'per_session', 'four_weeks', 'month', 'year']) {
      const res = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: `Offered ${freq}`, type: 'service', amount: 10, billing_frequency: freq });
      expect(res.status).toBe(201);
      expect(res.body.billing_frequency).toBe(freq);
    }
  });
});

// ─── #821 — a Sellable Item stored on the retired 'week' frequency ──────────────

describe('#821 legacy week frequency', () => {
  let gymId: string;
  let weeklyId: number;
  let monthlyId: number;

  beforeAll(async () => {
    gymId = await createTestGym();
    await createTestMembership(gymId, 'admin');
    // Written directly, the way a pre-#821 item exists in a real gym: the API
    // refuses to create one now, which is the point of the ticket.
    const weekly = await db.query(
      `INSERT INTO gym_charges (gym_id, name, type, amount, currency, billing_frequency, status, enrollment_status, is_system)
       VALUES (?, 'Legacy Weekly Locker', 'service', 5.00, 'EUR', 'week', 'active', 'public', 0)`,
      [gymId],
    );
    weeklyId = weekly.insertId as number;
    const monthly = await db.query(
      `INSERT INTO gym_charges (gym_id, name, type, amount, currency, billing_frequency, status, enrollment_status, is_system)
       VALUES (?, 'Monthly Locker', 'service', 20.00, 'EUR', 'month', 'active', 'public', 0)`,
      [gymId],
    );
    monthlyId = monthly.insertId as number;
  });

  const put = (id: number, body: Record<string, unknown>) => request
    .put(`/sellable-items/${id}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send(body);

  it('still reads the stored frequency back', async () => {
    const res = await request
      .get(`/sellable-items/${weeklyId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.billing_frequency).toBe('week');
  });

  it('still classifies it as a periodical benefit', async () => {
    const res = await request
      .get(`/sellable-items/${weeklyId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.body.benefit_category).toBe('periodical');
  });

  it('lets another field be edited with the frequency submitted back unchanged', async () => {
    const res = await put(weeklyId, { name: 'Legacy Weekly Locker', amount: 6.5, billing_frequency: 'week' });
    expect(res.status).toBe(200);
    expect(res.body.billing_frequency).toBe('week');
    expect(parseFloat(res.body.amount)).toBeCloseTo(6.5, 2);
  });

  it('lets it move onto an offered frequency', async () => {
    const res = await put(weeklyId, { name: 'Legacy Weekly Locker', billing_frequency: 'four_weeks' });
    expect(res.status).toBe(200);
    expect(res.body.billing_frequency).toBe('four_weeks');
    // …and cannot come back once it has moved.
    const back = await put(weeklyId, { name: 'Legacy Weekly Locker', billing_frequency: 'week' });
    expect(back.status).toBe(400);
    expect(back.body.error).toContain('no longer offered');
    const { rows } = await db.query(
      'SELECT billing_frequency FROM gym_charges WHERE id = ?', [weeklyId],
    );
    expect(rows[0].billing_frequency).toBe('four_weeks');
  });

  it('refuses to move an item that never was weekly onto week', async () => {
    const res = await put(monthlyId, { name: 'Monthly Locker', billing_frequency: 'week' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('no longer offered');
    const { rows } = await db.query(
      'SELECT billing_frequency FROM gym_charges WHERE id = ?', [monthlyId],
    );
    expect(rows[0].billing_frequency).toBe('month');
  });

  it('duplicates a weekly item faithfully, frequency included', async () => {
    const legacy = await db.query(
      `INSERT INTO gym_charges (gym_id, name, type, amount, currency, billing_frequency, status, enrollment_status, is_system)
       VALUES (?, 'Weekly To Duplicate', 'service', 7.00, 'EUR', 'week', 'active', 'public', 0)`,
      [gymId],
    );
    const res = await request
      .post(`/sellable-items/${legacy.insertId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.billing_frequency).toBe('week');
  });
});

// ─── DELETE /sellable-items/:id — soft-delete custom items ──────────────────────

describe('DELETE /sellable-items/:id', () => {
  let gymId: string;
  let gymOther: string;
  let systemChargeId: number | undefined;
  let customChargeId: number | undefined;

  beforeAll(async () => {
    gymId = await createTestGym('Charges DELETE Gym');
    await createTestMembership(gymId, 'admin');
    await seedGymCharges(gymId);
    systemChargeId = await firstChargeId(gymId);

    gymOther = await createTestGym('Charges DELETE Other Gym');
    await createTestMembership(gymOther, 'admin');

    // Create a custom item to test soft-delete
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Deletable Item', type: 'service', amount: 5 });
    customChargeId = res.body?.id;
  });

  it('returns 403 when attempting to delete a system item', async () => {
    if (!systemChargeId) return;
    const res = await request
      .delete(`/sellable-items/${systemChargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
  });

  it('returns 404 when charge belongs to a different gym (cross-gym isolation)', async () => {
    if (!customChargeId) return;
    const res = await request
      .delete(`/sellable-items/${customChargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymOther);
    expect(res.status).toBe(404);
  });

  it('soft-deletes a custom item and returns 204', async () => {
    if (!customChargeId) return;
    const res = await request
      .delete(`/sellable-items/${customChargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('deleted item is hidden from GET / list', async () => {
    if (!customChargeId) return;
    const res = await request
      .get('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((c) => c.id);
    expect(ids).not.toContain(customChargeId);
  });

  it('deleted item is still accessible by GET /:id (Recycle Bin access)', async () => {
    if (!customChargeId) return;
    const res = await request
      .get(`/sellable-items/${customChargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.deleted_at).not.toBeNull();
  });

  it('returns 404 on second delete attempt (already soft-deleted)', async () => {
    if (!customChargeId) return;
    const res = await request
      .delete(`/sellable-items/${customChargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── Computed tax fields ───────────────────────────────────────────────────────

describe('GET /sellable-items — computed price fields', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Tax Fields Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns amount_incl_tax and amount_excl_tax for inclusive tax_behavior', async () => {
    // Create a custom item with amount=100 and inclusive tax (no explicit tax_rate_id — null → no rate)
    const create = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Tax Test Item', type: 'fee', amount: 100, tax_behavior: 'inclusive' });
    expect(create.status).toBe(201);
    // With no tax_rate_id, applied_tax_rate is null → incl/excl amounts are also null
    expect(create.body.tax_behavior).toBe('inclusive');
    expect(create.body.applied_tax_rate).toBeNull();
    expect(create.body.amount_incl_tax).toBeNull();
    expect(create.body.amount_excl_tax).toBeNull();
  });

  it('returns 400 for invalid tax_behavior', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Bad Behavior', type: 'fee', tax_behavior: 'bad' });
    expect(res.status).toBe(400);
  });
});

// ─── benefit_category (#550) ────────────────────────────────────────────────────
// Server-computed via classifySellableItem() (api/src/domain/sellableItemClassification.ts)
// — the single source of truth Promotions' Session/One-off/Periodical Benefit
// pickers group by, instead of re-deriving the type/frequency rules client-side.

describe('GET /sellable-items — benefit_category', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Benefit Category Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('classifies a Sessions-type item as session', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'BC Group Class', type: 'sessions' });
    expect(res.status).toBe(201);
    expect(res.body.benefit_category).toBe('session');
  });

  it('classifies a non-Sessions item with a recurring frequency as periodical', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'BC Locker Rental', type: 'service', billing_frequency: 'month' });
    expect(res.status).toBe(201);
    expect(res.body.benefit_category).toBe('periodical');
  });

  it('classifies a non-Sessions item with a non-recurring (or no) frequency as oneoff', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'BC Registration Fee', type: 'fee' });
    expect(res.status).toBe(201);
    expect(res.body.benefit_category).toBe('oneoff');
  });

  it('includes benefit_category on GET /sellable-items list and GET /:id', async () => {
    const created = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'BC List Item', type: 'sessions' });
    expect(created.status).toBe(201);

    const list = await request
      .get('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list.status).toBe(200);
    const row = list.body.find((r: any) => r.id === created.body.id);
    expect(row?.benefit_category).toBe('session');

    const single = await request
      .get(`/sellable-items/${created.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(single.status).toBe(200);
    expect(single.body.benefit_category).toBe('session');
  });
});

// ─── Editing tax_rate_id (#368) ─────────────────────────────────────────────────

describe('POST /sellable-items — tax_rate_id validation', () => {
  let gymId: string;
  let otherGymId: string;
  let taxRateId: number;
  let otherGymTaxRateId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Tax Rate Create Gym');
    await createTestMembership(gymId, 'admin');
    taxRateId = await createTaxRate(gymId, 'VAT 21%', 21);

    otherGymId = await createTestGym('Tax Rate Other Gym');
    await createTestMembership(otherGymId, 'admin');
    otherGymTaxRateId = await createTaxRate(otherGymId, 'VAT 10%', 10);
  });

  it('creates an item with a valid tax_rate_id and computes tax fields', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Taxed Item', type: 'fee', amount: 121, tax_behavior: 'inclusive', tax_rate_id: taxRateId });
    expect(res.status).toBe(201);
    expect(res.body.tax_rate_id).toBe(taxRateId);
    expect(res.body.applied_tax_rate).toBe(21);
    expect(res.body.amount_excl_tax).toBeCloseTo(100, 2);
    expect(res.body.amount_incl_tax).toBeCloseTo(121, 2);
  });

  it('returns 400 for a tax_rate_id that does not exist', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Bad Tax Item', type: 'fee', amount: 10, tax_rate_id: 999999 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a tax_rate_id belonging to another gym (tenant isolation)', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Cross Gym Tax Item', type: 'fee', amount: 10, tax_rate_id: otherGymTaxRateId });
    expect(res.status).toBe(400);
  });
});

describe('PUT /sellable-items/:id — tax_rate_id validation', () => {
  let gymId: string;
  let otherGymId: string;
  let itemId: number;
  let taxRateId: number;
  let otherGymTaxRateId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Tax Rate Edit Gym');
    await createTestMembership(gymId, 'admin');
    taxRateId = await createTaxRate(gymId, 'VAT 21%', 21);

    otherGymId = await createTestGym('Tax Rate Edit Other Gym');
    await createTestMembership(otherGymId, 'admin');
    otherGymTaxRateId = await createTaxRate(otherGymId, 'VAT 10%', 10);

    const create = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Editable Tax Item', type: 'fee', amount: 100 });
    itemId = create.body.id;
  });

  it('updates the tax_rate_id and returns the recomputed tax fields', async () => {
    // PUT overwrites amount unconditionally when the field is omitted (matches
    // real frontend usage, which always submits the full form), so it must be
    // resent here alongside the fields under test.
    const res = await request
      .put(`/sellable-items/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ amount: 100, tax_rate_id: taxRateId, tax_behavior: 'exclusive' });
    expect(res.status).toBe(200);
    expect(res.body.tax_rate_id).toBe(taxRateId);
    expect(res.body.applied_tax_rate).toBe(21);
    expect(res.body.amount_excl_tax).toBeCloseTo(100, 2);
    expect(res.body.amount_incl_tax).toBeCloseTo(121, 2);
  });

  it('returns 400 when updating to a tax_rate_id that does not exist', async () => {
    const res = await request
      .put(`/sellable-items/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ tax_rate_id: 999999 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when updating to a tax_rate_id belonging to another gym', async () => {
    const res = await request
      .put(`/sellable-items/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ tax_rate_id: otherGymTaxRateId });
    expect(res.status).toBe(400);
  });
});

// ─── POST /sellable-items/:id/duplicate (#545) ───────────────────────────────

describe('POST /sellable-items/:id/duplicate', () => {
  let gymId: string;
  let gymOther: string;
  let gymAccountant: string;
  let customSourceId: number;
  let systemSourceId: number | undefined;

  beforeAll(async () => {
    gymId = await createTestGym('Charges Duplicate Gym');
    await createTestMembership(gymId, 'admin');
    await seedGymCharges(gymId);
    systemSourceId = await firstChargeId(gymId);

    gymOther = await createTestGym('Charges Duplicate Other Gym');
    await createTestMembership(gymOther, 'admin');
    await seedGymCharges(gymOther);

    gymAccountant = await createTestGym('Charges Duplicate Accountant Gym');
    await createTestMembership(gymAccountant, 'accountant');

    const create = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'Original Custom Item',
        type: 'sessions',
        units: 10,
        description: 'Ten-session pack',
        amount: 150,
        billing_frequency: 'once',
        status: 'active',
        enrollment_status: 'staff_only',
        notes: 'Internal notes',
        package_information: 'Valid for 90 days',
        validity_days: 90,
      });
    expect(create.status).toBe(201);
    customSourceId = create.body.id;
  });

  it('returns 401 without auth', async () => {
    const res = await request.post(`/sellable-items/${customSourceId}/duplicate`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin role', async () => {
    const chargeId = await firstChargeId(gymAccountant);
    if (!chargeId) return; // no is_gym_charge rows in this DB — skip gracefully
    const res = await request
      .post(`/sellable-items/${chargeId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymAccountant);
    expect(res.status).toBe(403);
  });

  it('returns 404 when the source item belongs to a different gym (tenant isolation)', async () => {
    const res = await request
      .post(`/sellable-items/${customSourceId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymOther);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent source item', async () => {
    const res = await request
      .post('/sellable-items/999999/duplicate')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('duplicates a custom item: new id, "Copy of" name, copied fields, original unchanged', async () => {
    const dup = await request
      .post(`/sellable-items/${customSourceId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dup.status).toBe(201);

    // New unique id, not the source's.
    expect(dup.body.id).not.toBe(customSourceId);
    // Duplicate-name convention.
    expect(dup.body.name).toBe('Copy of Original Custom Item');
    // Current gym/tenant, current user as creator.
    expect(dup.body.gym_id).toBe(gymId);
    expect(dup.body.created_by_membership_id).toBeTruthy();
    // Always created as a custom item.
    expect(dup.body.is_system).toBe(0);
    // Copied configuration fields, including status/enrollment visibility.
    expect(dup.body.type).toBe('sessions');
    expect(dup.body.units).toBe(10);
    expect(dup.body.description).toBe('Ten-session pack');
    expect(parseFloat(dup.body.amount)).toBeCloseTo(150, 2);
    expect(dup.body.billing_frequency).toBe('once');
    expect(dup.body.status).toBe('active');
    expect(dup.body.enrollment_status).toBe('staff_only');
    expect(dup.body.notes).toBe('Internal notes');
    expect(dup.body.package_information).toBe('Valid for 90 days');
    expect(dup.body.validity_days).toBe(90);

    // Original item is completely unchanged.
    const original = await request
      .get(`/sellable-items/${customSourceId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(original.status).toBe(200);
    expect(original.body.name).toBe('Original Custom Item');
    expect(original.body.id).toBe(customSourceId);
  });

  it('duplicating a system item creates an independent custom item, leaving the system item untouched', async () => {
    if (!systemSourceId) return; // no is_gym_charge rows in this DB — skip gracefully

    const dup = await request
      .post(`/sellable-items/${systemSourceId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dup.status).toBe(201);
    expect(dup.body.id).not.toBe(systemSourceId);
    expect(dup.body.is_system).toBe(0);

    const original = await request
      .get(`/sellable-items/${systemSourceId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(original.body.is_system).toBe(1);
    expect(original.body.id).toBe(systemSourceId);
  });

  it('does not carry over historical/transactional linkage (charge_type_id, class_package_id) from the source', async () => {
    const dup = await request
      .post(`/sellable-items/${customSourceId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dup.status).toBe(201);
    const { rows } = await db.query<{ charge_type_id: number | null; class_package_id: number | null }>(
      'SELECT charge_type_id, class_package_id FROM gym_charges WHERE id = ?',
      [dup.body.id],
    );
    expect(rows[0].charge_type_id).toBeNull();
    expect(rows[0].class_package_id).toBeNull();
  });

  it('duplicating twice does not mutate the original and produces two independent rows', async () => {
    const first = await request
      .post(`/sellable-items/${customSourceId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const second = await request
      .post(`/sellable-items/${customSourceId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).not.toBe(second.body.id);

    const original = await request
      .get(`/sellable-items/${customSourceId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(original.body.name).toBe('Original Custom Item');
  });
});

// ─── #546: Professional Services linkage on Session-type Sellable Items ────────

describe('Sellable Items — Professional Services linkage (#546)', () => {
  let gymId: string;
  let otherGymId: string;
  let psOne: number;
  let psTwo: number;
  let psInOtherGym: number;

  beforeAll(async () => {
    gymId = await createTestGym('Charges PS Gym');
    await createTestMembership(gymId, 'admin');
    psOne = await createProfessionalService(gymId, 'Personal Training');
    psTwo = await createProfessionalService(gymId, 'Physiotherapy Session');

    otherGymId = await createTestGym('Charges PS Other Gym');
    await createTestMembership(otherGymId, 'admin');
    psInOtherGym = await createProfessionalService(otherGymId, 'Other Gym Service');
  });

  // ── create ────────────────────────────────────────────────────────────────

  it('creates a sessions item with a single linked Professional Service', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'PT Single Session', type: 'sessions', units: 1, professional_service_ids: [psOne] });
    expect(res.status).toBe(201);
    expect(res.body.professional_services).toHaveLength(1);
    expect(res.body.professional_services.map((s: any) => s.id)).toEqual([psOne]);
  });

  it('creates a sessions item with multiple linked Professional Services', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Mixed Session Pack', type: 'sessions', units: 10, professional_service_ids: [psOne, psTwo] });
    expect(res.status).toBe(201);
    expect(res.body.professional_services.map((s: any) => s.id).sort()).toEqual([psOne, psTwo].sort());
  });

  it('creates a sessions item with no Professional Services selected (empty is allowed, not required)', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Unassigned Session Pack', type: 'sessions', units: 5 });
    expect(res.status).toBe(201);
    expect(res.body.professional_services).toEqual([]);
  });

  it('ignores professional_service_ids for a non-sessions type (field not applicable)', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Merch Item', type: 'merchandise', professional_service_ids: [psOne] });
    expect(res.status).toBe(201);
    expect(res.body.professional_services).toEqual([]);
  });

  it('returns 400 when a professional_service_id belongs to another gym (tenant isolation)', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Cross Tenant Attempt', type: 'sessions', professional_service_ids: [psInOtherGym] });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a non-existent professional_service_id', async () => {
    const res = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Bogus PS Id', type: 'sessions', professional_service_ids: [9999999] });
    expect(res.status).toBe(400);
  });

  // ── read ──────────────────────────────────────────────────────────────────

  it('includes professional_services on GET /sellable-items list', async () => {
    const created = await request
      .post('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Listed Session Item', type: 'sessions', professional_service_ids: [psOne] });
    expect(created.status).toBe(201);

    const list = await request
      .get('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list.status).toBe(200);
    const row = (list.body as Array<{ id: number; professional_services: Array<{ id: number }> }>)
      .find((r) => r.id === created.body.id);
    expect(row?.professional_services.map((s) => s.id)).toEqual([psOne]);
  });

  it('does not include another gym\'s Professional Service data (no cross-tenant leakage)', async () => {
    const res = await request
      .get('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ professional_services: Array<{ id: number }> }>)
      .flatMap((r) => r.professional_services.map((s) => s.id));
    expect(ids).not.toContain(psOne);
    expect(ids).not.toContain(psTwo);
  });

  // ── edit (add/remove) ────────────────────────────────────────────────────

  describe('editing selections on an existing Session item', () => {
    let itemId: number;

    beforeAll(async () => {
      const created = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Editable Session Item', type: 'sessions', professional_service_ids: [psOne] });
      itemId = created.body.id;
    });

    it('loads the currently selected Professional Services on GET /:id', async () => {
      const res = await request
        .get(`/sellable-items/${itemId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      expect(res.body.professional_services.map((s: any) => s.id)).toEqual([psOne]);
    });

    it('adds a second Professional Service via PUT', async () => {
      const res = await request
        .put(`/sellable-items/${itemId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ professional_service_ids: [psOne, psTwo] });
      expect(res.status).toBe(200);
      expect(res.body.professional_services.map((s: any) => s.id).sort()).toEqual([psOne, psTwo].sort());
    });

    it('removes a Professional Service via PUT (replace-all semantics)', async () => {
      const res = await request
        .put(`/sellable-items/${itemId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ professional_service_ids: [psTwo] });
      expect(res.status).toBe(200);
      expect(res.body.professional_services.map((s: any) => s.id)).toEqual([psTwo]);
    });

    it('leaves selections untouched when a PUT omits professional_service_ids entirely', async () => {
      const res = await request
        .put(`/sellable-items/${itemId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ notes: 'unrelated update' });
      expect(res.status).toBe(200);
      expect(res.body.professional_services.map((s: any) => s.id)).toEqual([psTwo]);
    });

    it('returns 400 and leaves selections unchanged when PUT sends a cross-tenant professional_service_id', async () => {
      const res = await request
        .put(`/sellable-items/${itemId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ professional_service_ids: [psInOtherGym] });
      expect(res.status).toBe(400);

      const after = await request
        .get(`/sellable-items/${itemId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(after.body.professional_services.map((s: any) => s.id)).toEqual([psTwo]);
    });
  });

  // ── type changes ─────────────────────────────────────────────────────────

  describe('type changes', () => {
    it('clears linked Professional Services when type changes away from sessions', async () => {
      const created = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Session To Fee', type: 'sessions', professional_service_ids: [psOne, psTwo] });
      expect(created.body.professional_services).toHaveLength(2);

      const res = await request
        .put(`/sellable-items/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ type: 'fee' });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('fee');
      expect(res.body.professional_services).toEqual([]);

      const { rows } = await db.query(
        'SELECT COUNT(*) AS cnt FROM sellable_item_professional_services WHERE sellable_item_id = ?',
        [created.body.id],
      );
      expect(rows[0].cnt).toBe(0);
    });

    it('does not persist professional_service_ids sent alongside a non-sessions type change', async () => {
      const created = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Fee Item For Type Change', type: 'fee' });

      const res = await request
        .put(`/sellable-items/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ type: 'merchandise', professional_service_ids: [psOne] });
      expect(res.status).toBe(200);
      expect(res.body.professional_services).toEqual([]);
    });

    it('shows the field (allows selection) when type changes to sessions, without auto-selecting any service', async () => {
      const created = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Fee To Session', type: 'fee' });
      expect(created.body.professional_services).toEqual([]);

      const toSessions = await request
        .put(`/sellable-items/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ type: 'sessions' });
      expect(toSessions.status).toBe(200);
      expect(toSessions.body.type).toBe('sessions');
      // No default/auto-selected service — architecture has no such precedent.
      expect(toSessions.body.professional_services).toEqual([]);

      const withSelection = await request
        .put(`/sellable-items/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ professional_service_ids: [psOne] });
      expect(withSelection.status).toBe(200);
      expect(withSelection.body.professional_services.map((s: any) => s.id)).toEqual([psOne]);
    });
  });

  // ── duplicate ─────────────────────────────────────────────────────────────

  describe('duplication', () => {
    it('copies linked Professional Services onto the duplicate of a sessions item', async () => {
      const created = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Duplicate Source Session', type: 'sessions', professional_service_ids: [psOne, psTwo] });

      const dup = await request
        .post(`/sellable-items/${created.body.id}/duplicate`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(dup.status).toBe(201);
      expect(dup.body.professional_services.map((s: any) => s.id).sort()).toEqual([psOne, psTwo].sort());

      // Original is unaffected.
      const original = await request
        .get(`/sellable-items/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(original.body.professional_services.map((s: any) => s.id).sort()).toEqual([psOne, psTwo].sort());
    });

    it('does not attach any Professional Services when duplicating a non-sessions item', async () => {
      const created = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Duplicate Source Fee', type: 'fee' });

      const dup = await request
        .post(`/sellable-items/${created.body.id}/duplicate`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(dup.status).toBe(201);
      expect(dup.body.professional_services).toEqual([]);
    });
  });

  // ── system Professional Services ─────────────────────────────────────────

  describe('linking a global system Professional Service', () => {
    it('links a system Professional Service without a seeded gym_professional_services row for this gym', async () => {
      // createTestGym() bypasses the POST /gyms seeding trigger (see the
      // header comment on seedGymCharges above), so gymId has no
      // gym_professional_services row at all for this system service yet.
      // Linking must still succeed: professional_service_ids validation is
      // keyed off `professional_services.gym_id IS NULL`, not per-gym
      // enablement.
      const systemServiceId = await systemProfessionalServiceId('personal_training_individual');

      const res = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'PT With System Service', type: 'sessions', professional_service_ids: [systemServiceId] });
      expect(res.status).toBe(201);
      expect(res.body.professional_services).toHaveLength(1);
      expect(res.body.professional_services[0]).toMatchObject({ id: systemServiceId, is_system: 1 });
    });
  });

  // ── input validation ─────────────────────────────────────────────────────

  describe('professional_service_ids input validation', () => {
    it('returns 400 for a non-integer id in the array', async () => {
      const res = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Bad Array Element', type: 'sessions', professional_service_ids: ['not-a-number'] });
      expect(res.status).toBe(400);
    });

    it('returns 400 for a negative id in the array', async () => {
      const res = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Negative Array Element', type: 'sessions', professional_service_ids: [-1] });
      expect(res.status).toBe(400);
    });

    it('returns 400 when professional_service_ids is not an array', async () => {
      const res = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Not An Array', type: 'sessions', professional_service_ids: psOne });
      expect(res.status).toBe(400);
    });

    it('returns 400 for a soft-deleted professional_service_id', async () => {
      const toDelete = await createProfessionalService(gymId, 'Soon Deleted Service');
      const del = await request
        .delete(`/professional-services/${toDelete}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(del.status).toBe(204);

      const res = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Deleted PS Attempt', type: 'sessions', professional_service_ids: [toDelete] });
      expect(res.status).toBe(400);
    });

    it('dedupes repeated ids in the array instead of erroring', async () => {
      const res = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Duplicate Ids In Array', type: 'sessions', professional_service_ids: [psOne, psOne] });
      expect(res.status).toBe(201);
      expect(res.body.professional_services.map((s: any) => s.id)).toEqual([psOne]);
    });
  });

  // ── a linked service is later soft-deleted ───────────────────────────────

  describe('a linked Professional Service is soft-deleted afterwards', () => {
    it('drops the soft-deleted service from the response without erroring', async () => {
      const toDelete = await createProfessionalService(gymId, 'Deleted After Linking');
      const created = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Item Linked Then Orphaned', type: 'sessions', professional_service_ids: [psOne, toDelete] });
      expect(created.body.professional_services).toHaveLength(2);

      const del = await request
        .delete(`/professional-services/${toDelete}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(del.status).toBe(204);

      const res = await request
        .get(`/sellable-items/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      expect(res.body.professional_services.map((s: any) => s.id)).toEqual([psOne]);
    });
  });

  // ── activate / deactivate response shape ─────────────────────────────────

  describe('activate / deactivate preserve the professional_services field', () => {
    it('includes professional_services in the /activate and /deactivate responses', async () => {
      const created = await request
        .post('/sellable-items')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Toggle Status Session Item', type: 'sessions', professional_service_ids: [psOne] });
      expect(created.status).toBe(201);

      const deactivate = await request
        .post(`/sellable-items/${created.body.id}/deactivate`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(deactivate.status).toBe(200);
      expect(deactivate.body.status).toBe('inactive');
      expect(deactivate.body.professional_services.map((s: any) => s.id)).toEqual([psOne]);

      const activate = await request
        .post(`/sellable-items/${created.body.id}/activate`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(activate.status).toBe(200);
      expect(activate.body.status).toBe('active');
      expect(activate.body.professional_services.map((s: any) => s.id)).toEqual([psOne]);
    });
  });
});

// ─── #832 Mandatory attribute ────────────────────────────────────────────────────

describe('#832 mandatory attribute', () => {
  let gymId: string;
  let systemId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Charges Mandatory Gym');
    await createTestMembership(gymId, 'admin');
    await seedGymCharges(gymId);
    systemId = (await firstChargeId(gymId))!;
  });

  const post = (body: Record<string, unknown>) => request
    .post('/sellable-items')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send(body);

  const put = (id: number, body: Record<string, unknown>) => request
    .put(`/sellable-items/${id}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send(body);

  const stored = async (id: number) => {
    const { rows } = await db.query<{ mandatory: number }>(
      'SELECT mandatory FROM gym_charges WHERE id = ?', [id],
    );
    return rows[0].mandatory;
  };

  it('defaults to false when the field is omitted on create', async () => {
    const res = await post({ name: 'Mandatory Omitted', type: 'service' });
    expect(res.status).toBe(201);
    expect(res.body.mandatory).toBe(0);
    expect(await stored(res.body.id)).toBe(0);
  });

  it('persists mandatory = true on create', async () => {
    const res = await post({ name: 'Mandatory On Create', type: 'service', mandatory: true });
    expect(res.status).toBe(201);
    expect(res.body.mandatory).toBe(1);
    expect(await stored(res.body.id)).toBe(1);
  });

  it('persists mandatory = false on create', async () => {
    const res = await post({ name: 'Mandatory Off Create', type: 'service', mandatory: false });
    expect(res.status).toBe(201);
    expect(res.body.mandatory).toBe(0);
  });

  it('reads the flag back on GET /:id and in the list', async () => {
    const created = await post({ name: 'Mandatory Readback', type: 'fee', mandatory: true });
    const one = await request
      .get(`/sellable-items/${created.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(one.status).toBe(200);
    expect(one.body.mandatory).toBe(1);

    const list = await request
      .get('/sellable-items')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list.status).toBe(200);
    const row = (list.body as Array<{ id: number; mandatory: number }>).find((i) => i.id === created.body.id);
    expect(row?.mandatory).toBe(1);
  });

  // The COALESCE trap: `false` is a value the user chose, not an absent field,
  // so unchecking the box has to reach the column.
  it('toggles the flag both ways through PUT', async () => {
    const created = await post({ name: 'Mandatory Toggle', type: 'service' });
    const id = created.body.id as number;

    const on = await put(id, { name: 'Mandatory Toggle', mandatory: true });
    expect(on.status).toBe(200);
    expect(on.body.mandatory).toBe(1);
    expect(await stored(id)).toBe(1);

    const off = await put(id, { name: 'Mandatory Toggle', mandatory: false });
    expect(off.status).toBe(200);
    expect(off.body.mandatory).toBe(0);
    expect(await stored(id)).toBe(0);
  });

  it('leaves the flag untouched when PUT does not mention it', async () => {
    const created = await post({ name: 'Mandatory Untouched', type: 'service', mandatory: true });
    const id = created.body.id as number;
    const res = await put(id, { name: 'Mandatory Untouched', amount: 12.5 });
    expect(res.status).toBe(200);
    expect(res.body.mandatory).toBe(1);
    expect(await stored(id)).toBe(1);
  });

  // §2: the flag is editable on a Base (System) Sellable Item too, which is why
  // the UPDATE writes it outside the is_system guard the catalogue-shape
  // columns carry — name/type on a System row still cannot move.
  it('is editable on a System item, whose name and type still cannot be', async () => {
    const { rows: before } = await db.query<{ name: string; type: string; is_system: number }>(
      'SELECT name, type, is_system FROM gym_charges WHERE id = ?', [systemId],
    );
    expect(before[0].is_system).toBe(1);

    const res = await put(systemId, { name: 'Renamed System Item', type: 'other', mandatory: true });
    expect(res.status).toBe(200);
    expect(res.body.mandatory).toBe(1);
    expect(res.body.name).toBe(before[0].name);
    expect(res.body.type).toBe(before[0].type);

    const off = await put(systemId, { mandatory: false });
    expect(off.status).toBe(200);
    expect(off.body.mandatory).toBe(0);
  });

  it('accepts 0/1 as well as booleans, and refuses anything else', async () => {
    const one = await post({ name: 'Mandatory Numeric One', type: 'service', mandatory: 1 });
    expect(one.status).toBe(201);
    expect(one.body.mandatory).toBe(1);

    const zero = await post({ name: 'Mandatory Numeric Zero', type: 'service', mandatory: 0 });
    expect(zero.status).toBe(201);
    expect(zero.body.mandatory).toBe(0);

    // "false" is truthy in JS — coercing it would silently mark the item
    // mandatory, so the string is refused rather than interpreted.
    const bad = await post({ name: 'Mandatory Bad Value', type: 'service', mandatory: 'false' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('mandatory');

    const created = await post({ name: 'Mandatory Bad On Put', type: 'service', mandatory: true });
    const badPut = await put(created.body.id, { mandatory: 'no' });
    expect(badPut.status).toBe(400);
    expect(await stored(created.body.id)).toBe(1);
  });

  it('treats an explicit null as "not supplied"', async () => {
    const created = await post({ name: 'Mandatory Null', type: 'service', mandatory: true });
    const id = created.body.id as number;
    const res = await put(id, { name: 'Mandatory Null', mandatory: null });
    expect(res.status).toBe(200);
    expect(res.body.mandatory).toBe(1);
  });

  it('copies the flag onto a duplicate', async () => {
    const created = await post({ name: 'Mandatory To Duplicate', type: 'service', mandatory: true });
    const res = await request
      .post(`/sellable-items/${created.body.id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.mandatory).toBe(1);
  });
});
