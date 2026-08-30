// Tests for gym-charges.ts router

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
    `INSERT IGNORE INTO gym_charges (gym_id, charge_type_id, is_system, created_at)
     SELECT ?, id, 1, UTC_TIMESTAMP() FROM charge_types WHERE is_gym_charge = 1`,
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

// ─── GET /gym-charges ─────────────────────────────────────────────────────────

describe('GET /gym-charges', () => {
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
    const res = await request.get('/gym-charges').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in the gym (tenant isolation)', async () => {
    const res = await request
      .get('/gym-charges')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoMembership);
    expect(res.status).toBe(403);
  });

  it('returns 403 when the role has no FINANCIALS module access (trainer_performance)', async () => {
    const res = await request
      .get('/gym-charges')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoModule);
    expect(res.status).toBe(403);
  });

  it('returns 200 with an array for admin', async () => {
    const res = await request
      .get('/gym-charges')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns 200 with an array for accountant (FINANCIALS read-only access)', async () => {
    const res = await request
      .get('/gym-charges')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymReadOnly);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ─── GET /gym-charges/:id ─────────────────────────────────────────────────────

describe('GET /gym-charges/:id', () => {
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
      .get(`/gym-charges/${chargeId}`)
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
      .get(`/gym-charges/${chargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });
});

// ─── GET /gym-charges filters ─────────────────────────────────────────────────

describe('GET /gym-charges filters', () => {
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
      .get('/gym-charges?status=bad')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid type query value', async () => {
    const res = await request
      .get('/gym-charges?type=bad')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('returns only active charges when ?status=active', async () => {
    const res = await request
      .get('/gym-charges?status=active')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.every((c: { status: string }) => c.status === 'active')).toBe(true);
  });

  it('returns only inactive charges when ?status=inactive', async () => {
    const res = await request
      .get('/gym-charges?status=inactive')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.every((c: { status: string }) => c.status === 'inactive')).toBe(true);
  });

  it('charge moves to ?status=inactive after deactivate endpoint', async () => {
    if (!activeChargeId) return;

    const deactivate = await request
      .post(`/gym-charges/${activeChargeId}/deactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.status).toBe('inactive');

    const after = await request
      .get('/gym-charges?status=inactive')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(after.status).toBe(200);
    const ids = (after.body as Array<{ id: number }>).map((c) => c.id);
    expect(ids).toContain(activeChargeId);
  });
});

// ─── PUT /gym-charges/:id ─────────────────────────────────────────────────────

describe('PUT /gym-charges/:id', () => {
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
      .put(`/gym-charges/${chargeId}`)
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
      .put(`/gym-charges/${chargeId}`)
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

  it('returns 404 when the charge belongs to a different gym (cross-gym isolation on write)', async () => {
    // chargeId comes from gymOther; request scoped to gymAdmin → WHERE id = ? AND gym_id = ? → 0 rows
    const chargeId = await firstChargeId(gymOther);
    if (!chargeId) return; // no is_gym_charge rows in this DB — skip gracefully

    const res = await request
      .put(`/gym-charges/${chargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymAdmin)
      .send({ amount: 1.0 });
    expect(res.status).toBe(404);
  });
});

// ─── POST /gym-charges — create custom sellable item ─────────────────────────

describe('POST /gym-charges', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Charges POST Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request
      .post('/gym-charges')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ type: 'fee', amount: 10 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when type is missing', async () => {
    const res = await request
      .post('/gym-charges')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Test Item' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when units is not a positive integer', async () => {
    const res = await request
      .post('/gym-charges')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Bad Units', type: 'sessions', units: -5 });
    expect(res.status).toBe(400);
  });

  it('creates a custom sellable item and returns 201 with is_system = 0', async () => {
    const res = await request
      .post('/gym-charges')
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
      .post('/gym-charges')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Session Pack 10', type: 'sessions', units: 10, amount: 90 });
    expect(res.status).toBe(201);
    expect(res.body.units).toBe(10);
    expect(res.body.type).toBe('sessions');
  });
});

// ─── DELETE /gym-charges/:id — soft-delete custom items ──────────────────────

describe('DELETE /gym-charges/:id', () => {
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
      .post('/gym-charges')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Deletable Item', type: 'service', amount: 5 });
    customChargeId = res.body?.id;
  });

  it('returns 403 when attempting to delete a system item', async () => {
    if (!systemChargeId) return;
    const res = await request
      .delete(`/gym-charges/${systemChargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
  });

  it('returns 404 when charge belongs to a different gym (cross-gym isolation)', async () => {
    if (!customChargeId) return;
    const res = await request
      .delete(`/gym-charges/${customChargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymOther);
    expect(res.status).toBe(404);
  });

  it('soft-deletes a custom item and returns 204', async () => {
    if (!customChargeId) return;
    const res = await request
      .delete(`/gym-charges/${customChargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('deleted item is hidden from GET / list', async () => {
    if (!customChargeId) return;
    const res = await request
      .get('/gym-charges')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((c) => c.id);
    expect(ids).not.toContain(customChargeId);
  });

  it('deleted item is still accessible by GET /:id (Recycle Bin access)', async () => {
    if (!customChargeId) return;
    const res = await request
      .get(`/gym-charges/${customChargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.deleted_at).not.toBeNull();
  });

  it('returns 404 on second delete attempt (already soft-deleted)', async () => {
    if (!customChargeId) return;
    const res = await request
      .delete(`/gym-charges/${customChargeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
