// Tests for taxes.ts router

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// Single shared getUser mock so tenantContext.ts sees whatever actor identity
// the current test needs. Defaults to a regular (non-superadmin) staff user,
// matching the global mock in setup.ts — individual tests override it with
// mockImplementationOnce to simulate a platform superadmin acting directly.
const mockGetUser = vi.hoisted(() =>
  vi.fn().mockImplementation(async () => ({
    publicMetadata: {},
    fullName: 'Test User',
    firstName: 'Test',
    lastName: 'User',
    emailAddresses: [],
    primaryEmailAddressId: null,
  })),
);

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: mockGetUser,
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: {
        createInvitation: vi.fn().mockResolvedValue({ id: 'inv-test-id' }),
        revokeInvitation: vi.fn().mockResolvedValue({}),
      },
      emailAddresses: {
        getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 'test@example.com' }),
      },
    })),
  };
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ─── Shared setup helpers ─────────────────────────────────────────────────────

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Inserts a tax_rates row directly, bypassing the router. */
async function createTaxRate(
  gymId: string,
  overrides: Record<string, unknown> = {},
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO tax_rates (gym_id, name, description, rate_percent, is_system, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      gymId,
      (overrides.name as string | undefined) ?? uniqueName('Tax'),
      (overrides.description as string | undefined) ?? null,
      (overrides.rate_percent as number | undefined) ?? 10,
      (overrides.is_system as number | undefined) ?? 0,
      (overrides.status as string | undefined) ?? 'active',
    ],
  );
  return insertId;
}

/**
 * Returns `n` fresh charge_types ids — a global lookup table, always pre-seeded.
 * Hands out ids from a shared cursor so repeated calls (even across tests sharing
 * one gym) never collide with gym_charges' unique (gym_id, charge_type_id) index.
 */
let _chargeTypeIdsCache: number[] | null = null;
let _chargeTypeCursor = 0;
async function chargeTypeIds(n: number): Promise<number[]> {
  if (!_chargeTypeIdsCache) {
    const { rows } = await db.query<{ id: number }>('SELECT id FROM charge_types ORDER BY id ASC');
    _chargeTypeIdsCache = rows.map((r) => r.id);
  }
  const ids = _chargeTypeIdsCache.slice(_chargeTypeCursor, _chargeTypeCursor + n);
  if (ids.length < n) throw new Error('Not enough charge_types seeded for this test run');
  _chargeTypeCursor += n;
  return ids;
}

/** Inserts a gym_charges (Sellable Item) row referencing the given tax rate. */
async function createGymCharge(gymId: string, chargeTypeId: number, taxRateId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_charges (gym_id, charge_type_id, tax_rate_id) VALUES (?, ?, ?)`,
    [gymId, chargeTypeId, taxRateId],
  );
  return insertId;
}

/** Inserts a membership_plans row referencing the given tax rate. */
async function createMembershipPlan(gymId: string, taxRateId: number | null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, tax_rate_id)
     VALUES (?, ?, 'draft', 'closed', ?)`,
    [gymId, uniqueName('Plan'), taxRateId],
  );
  return insertId;
}

/** Overrides the shared Clerk mock for exactly the next getUser() call (one HTTP request). */
function mockNextActorAsSuperadmin() {
  mockGetUser.mockImplementationOnce(async () => ({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin',
    firstName: 'Super',
    lastName: 'Admin',
    emailAddresses: [],
    primaryEmailAddressId: null,
  }));
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe('Auth guard', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Taxes Auth Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 401 on GET / without auth', async () => {
    const res = await request.get('/taxes').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 401 on POST / without auth', async () => {
    const res = await request
      .post('/taxes')
      .set('x-gym-id', gymId)
      .send({ name: 'No Auth Tax', rate_percent: 5 });
    expect(res.status).toBe(401);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('Tenant isolation', () => {
  let gymA: string;
  let gymB: string;
  let taxInGymA: number;

  beforeAll(async () => {
    gymA = await createTestGym('Taxes Tenant Gym A');
    await createTestMembership(gymA, 'admin');
    taxInGymA = await createTaxRate(gymA, { name: 'Gym A VAT' });

    gymB = await createTestGym('Taxes Tenant Gym B');
    await createTestMembership(gymB, 'admin');
  });

  it('returns 403 when the user has no membership in the requested gym', async () => {
    const noMembershipGym = await createTestGym('Taxes No Membership Gym');
    const res = await request
      .get('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', noMembershipGym);
    expect(res.status).toBe(403);
  });

  it('returns 404 on GET /:id for a tax rate belonging to another gym', async () => {
    const res = await request
      .get(`/taxes/${taxInGymA}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });

  it('returns 404 on PUT /:id for a tax rate belonging to another gym', async () => {
    const res = await request
      .put(`/taxes/${taxInGymA}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ name: 'Hijacked Name' });
    expect(res.status).toBe(404);
  });

  it('does not include gymA tax rates in gymB list', async () => {
    const res = await request
      .get('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: number }>).map((t) => t.id)).not.toContain(taxInGymA);
  });
});

// ─── Role guard (requireRole('admin')) ────────────────────────────────────────

describe('Role guard', () => {
  let gymId: string;
  let taxId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Taxes Role Guard Gym');
    // front_desk has no admin role — requireRole('admin') should block writes.
    await createTestMembership(gymId, 'front_desk');
    taxId = await createTaxRate(gymId, { name: 'Role Guard Tax' });
  });

  it('allows a non-admin role to GET the list', async () => {
    const res = await request
      .get('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('allows a non-admin role to GET a single tax rate', async () => {
    const res = await request
      .get(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
  });

  it('returns 403 when a non-admin role attempts POST /', async () => {
    const res = await request
      .post('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Forbidden Tax', rate_percent: 5 });
    expect(res.status).toBe(403);
  });

  it('returns 403 when a non-admin role attempts PUT /:id', async () => {
    const res = await request
      .put(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Should Fail' });
    expect(res.status).toBe(403);
  });

  it('returns 403 when a non-admin role attempts POST /:id/activate', async () => {
    const res = await request
      .post(`/taxes/${taxId}/activate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
  });

  it('returns 403 when a non-admin role attempts POST /:id/deactivate', async () => {
    const res = await request
      .post(`/taxes/${taxId}/deactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
  });

  it('returns 403 when a non-admin role attempts DELETE /:id', async () => {
    const res = await request
      .delete(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
  });
});

// ─── POST / — create ──────────────────────────────────────────────────────────

describe('POST /taxes', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Taxes Create Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('creates a tax rate with description and staff audit fields', async () => {
    const res = await request
      .post('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'City Sales Tax', rate_percent: 8.5, description: 'Applies to in-city sales' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('City Sales Tax');
    expect(res.body.description).toBe('Applies to in-city sales');
    expect(Number(res.body.rate_percent)).toBe(8.5);
    expect(res.body.is_system).toBe(0);
    expect(res.body.status).toBe('active');
    expect(res.body.created_by_name).toBe('Test User');
    expect(res.body.created_by_type).toBe('staff');
    expect(res.body.modified_by_name).toBe('Test User');
    expect(res.body.modified_by_type).toBe('staff');
  });

  it('defaults description to null when omitted', async () => {
    const res = await request
      .post('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'No Description Tax', rate_percent: 5 });
    expect(res.status).toBe(201);
    expect(res.body.description).toBeNull();
  });

  it('creates a tax rate with created_by_type = superadmin for a platform superadmin actor', async () => {
    mockNextActorAsSuperadmin();
    const res = await request
      .post('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Superadmin Created Tax', rate_percent: 12 });
    expect(res.status).toBe(201);
    expect(res.body.created_by_name).toBe('Super Admin');
    expect(res.body.created_by_type).toBe('superadmin');
    expect(res.body.modified_by_type).toBe('superadmin');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request
      .post('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ rate_percent: 5 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when rate_percent is negative', async () => {
    const res = await request
      .post('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Negative Rate Tax', rate_percent: -1 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when rate_percent is over 100', async () => {
    const res = await request
      .post('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Over 100 Rate Tax', rate_percent: 100.01 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when rate_percent is not a number', async () => {
    const res = await request
      .post('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'NaN Rate Tax', rate_percent: 'abc' });
    expect(res.status).toBe(400);
  });

  it('accepts a boundary rate_percent of 0', async () => {
    const res = await request
      .post('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Zero Rate Tax', rate_percent: 0 });
    expect(res.status).toBe(201);
    expect(Number(res.body.rate_percent)).toBe(0);
  });

  it('accepts a boundary rate_percent of 100', async () => {
    const res = await request
      .post('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Hundred Rate Tax', rate_percent: 100 });
    expect(res.status).toBe(201);
    expect(Number(res.body.rate_percent)).toBe(100);
  });

  it('returns 400 for an invalid status value', async () => {
    const res = await request
      .post('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Bad Status Tax', rate_percent: 5, status: 'bogus' });
    expect(res.status).toBe(400);
  });
});

// ─── GET / and GET /:id ────────────────────────────────────────────────────────

describe('GET /taxes and GET /taxes/:id', () => {
  let gymId: string;
  let taxId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Taxes Get Gym');
    await createTestMembership(gymId, 'admin');
    const res = await request
      .post('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Fetchable Tax', rate_percent: 15, description: 'Fetch me' });
    taxId = res.body.id;
  });

  it('returns 200 with an array that includes the created tax rate', async () => {
    const res = await request
      .get('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as Array<{ id: number }>).map((t) => t.id)).toContain(taxId);
  });

  it('returns the tax rate by id with description and audit fields', async () => {
    const res = await request
      .get(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(taxId);
    expect(res.body.name).toBe('Fetchable Tax');
    expect(res.body.description).toBe('Fetch me');
    expect(res.body.created_by_type).toBe('staff');
  });

  it('returns 404 for a non-existent id', async () => {
    const res = await request
      .get('/taxes/9999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 400 for an invalid status filter', async () => {
    const res = await request
      .get('/taxes?status=bogus')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('filters by ?status=active', async () => {
    const res = await request
      .get('/taxes?status=active')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.every((t: { status: string }) => t.status === 'active')).toBe(true);
  });
});

// ─── PUT /:id — happy path + validation ───────────────────────────────────────

describe('PUT /taxes/:id', () => {
  let gymId: string;
  let taxId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Taxes Update Gym');
    await createTestMembership(gymId, 'admin');
    taxId = await createTaxRate(gymId, { name: 'Update Me Tax', rate_percent: 5, description: 'Old description' });
  });

  it('updates name, description, rate_percent and status, and stamps modified_by fields', async () => {
    const res = await request
      .put(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'Updated Tax Name',
        description: 'New description',
        rate_percent: 7.25,
        status: 'inactive',
      });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Tax Name');
    expect(res.body.description).toBe('New description');
    expect(Number(res.body.rate_percent)).toBe(7.25);
    expect(res.body.status).toBe('inactive');
    expect(res.body.modified_by_name).toBe('Test User');
    expect(res.body.modified_by_type).toBe('staff');
  });

  it('sets modified_by_type = superadmin for a platform superadmin actor', async () => {
    mockNextActorAsSuperadmin();
    const res = await request
      .put(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Superadmin Edited Tax' });
    expect(res.status).toBe(200);
    expect(res.body.modified_by_name).toBe('Super Admin');
    expect(res.body.modified_by_type).toBe('superadmin');
  });

  it('returns 404 for a non-existent id', async () => {
    const res = await request
      .put('/taxes/9999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Ghost Tax' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when rate_percent is out of range', async () => {
    const res = await request
      .put(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ rate_percent: 150 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when rate_percent is negative', async () => {
    const res = await request
      .put(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ rate_percent: -5 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid status value', async () => {
    const res = await request
      .put(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ status: 'bogus' });
    expect(res.status).toBe(400);
  });
});

// ─── PUT /:id — impact-confirmation flow (#388) ───────────────────────────────

describe('PUT /taxes/:id — impact confirmation', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Taxes Impact Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('succeeds directly when no sellable items or membership plans reference the tax rate', async () => {
    const taxId = await createTaxRate(gymId, { name: 'Zero Impact Tax', rate_percent: 5 });
    const res = await request
      .put(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Zero Impact Tax Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Zero Impact Tax Renamed');
  });

  it('returns 409 with impact counts when sellable items reference the tax rate and confirmImpact is not sent', async () => {
    const taxId = await createTaxRate(gymId, { name: 'Sellable Impact Tax', rate_percent: 5 });
    const [chargeTypeId] = await chargeTypeIds(1);
    await createGymCharge(gymId, chargeTypeId, taxId);

    const res = await request
      .put(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Should Not Persist' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'confirmation_required',
      impact: { sellable_items: 1, membership_plans: 0 },
    });

    // The rename must not have persisted.
    const unchanged = await request
      .get(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(unchanged.body.name).toBe('Sellable Impact Tax');
  });

  it('returns 409 with impact counts when membership plans reference the tax rate and confirmImpact is not sent', async () => {
    const taxId = await createTaxRate(gymId, { name: 'Plan Impact Tax', rate_percent: 5 });
    await createMembershipPlan(gymId, taxId);

    const res = await request
      .put(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Should Not Persist Either' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'confirmation_required',
      impact: { sellable_items: 0, membership_plans: 1 },
    });
  });

  it('returns 409 with combined counts when both sellable items and membership plans reference the tax rate', async () => {
    const taxId = await createTaxRate(gymId, { name: 'Combined Impact Tax', rate_percent: 5 });
    const [ct1, ct2] = await chargeTypeIds(2);
    await createGymCharge(gymId, ct1, taxId);
    await createGymCharge(gymId, ct2, taxId);
    await createMembershipPlan(gymId, taxId);

    const res = await request
      .put(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ rate_percent: 9 });
    expect(res.status).toBe(409);
    expect(res.body.impact).toEqual({ sellable_items: 2, membership_plans: 1 });
  });

  it('persists the change when confirmImpact: true is sent despite non-zero impact', async () => {
    const taxId = await createTaxRate(gymId, { name: 'Confirmed Impact Tax', rate_percent: 5 });
    const [chargeTypeId] = await chargeTypeIds(1);
    await createGymCharge(gymId, chargeTypeId, taxId);

    const res = await request
      .put(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Confirmed Impact Tax Renamed', confirmImpact: true });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Confirmed Impact Tax Renamed');

    const check = await request
      .get(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(check.body.name).toBe('Confirmed Impact Tax Renamed');
  });

  it('does not count a soft-deleted sellable item towards the impact', async () => {
    const taxId = await createTaxRate(gymId, { name: 'Deleted Charge Impact Tax', rate_percent: 5 });
    const [chargeTypeId] = await chargeTypeIds(1);
    const chargeId = await createGymCharge(gymId, chargeTypeId, taxId);
    await db.query('UPDATE gym_charges SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [chargeId]);

    const res = await request
      .put(`/taxes/${taxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Should Persist Directly' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Should Persist Directly');
  });
});

// ─── POST /:id/activate and /:id/deactivate ───────────────────────────────────

describe('POST /taxes/:id/activate and /deactivate', () => {
  let gymId: string;
  let taxId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Taxes Activate Gym');
    await createTestMembership(gymId, 'admin');
    taxId = await createTaxRate(gymId, { name: 'Toggle Tax', rate_percent: 5, status: 'active' });
  });

  it('deactivates a tax rate and stamps modified_by fields', async () => {
    const res = await request
      .post(`/taxes/${taxId}/deactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('inactive');
    expect(res.body.modified_by_name).toBe('Test User');
    expect(res.body.modified_by_type).toBe('staff');
  });

  it('reactivates a tax rate and stamps modified_by fields', async () => {
    const res = await request
      .post(`/taxes/${taxId}/activate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.modified_by_name).toBe('Test User');
    expect(res.body.modified_by_type).toBe('staff');
  });

  it('sets modified_by_type = superadmin on activate for a platform superadmin actor', async () => {
    await request
      .post(`/taxes/${taxId}/deactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    mockNextActorAsSuperadmin();
    const res = await request
      .post(`/taxes/${taxId}/activate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.modified_by_name).toBe('Super Admin');
    expect(res.body.modified_by_type).toBe('superadmin');
  });

  it('returns 404 on activate for a non-existent id', async () => {
    const res = await request
      .post('/taxes/9999999/activate')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 on deactivate for a non-existent id', async () => {
    const res = await request
      .post('/taxes/9999999/deactivate')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── DELETE /:id — soft-delete custom tax rates only ──────────────────────────

describe('DELETE /taxes/:id', () => {
  let gymId: string;
  let customTaxId: number;
  let systemTaxId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Taxes Delete Gym');
    await createTestMembership(gymId, 'admin');
    customTaxId = await createTaxRate(gymId, { name: 'Deletable Tax' });
    systemTaxId = await createTaxRate(gymId, { name: 'System Tax', is_system: 1 });
  });

  it('returns 403 when attempting to delete an is_system tax rate', async () => {
    const res = await request
      .delete(`/taxes/${systemTaxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
  });

  it('soft-deletes a custom tax rate and returns 204', async () => {
    const res = await request
      .delete(`/taxes/${customTaxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('hides the soft-deleted tax rate from GET /', async () => {
    const res = await request
      .get('/taxes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: number }>).map((t) => t.id)).not.toContain(customTaxId);
  });

  it('returns 404 on GET /:id for the soft-deleted tax rate', async () => {
    const res = await request
      .get(`/taxes/${customTaxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 on a second delete attempt (already soft-deleted)', async () => {
    const res = await request
      .delete(`/taxes/${customTaxId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 when deleting a non-existent id', async () => {
    const res = await request
      .delete('/taxes/9999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
