// Tests for payment-providers.ts router
//
// #636: the Cordel-level (platform-wide) `payment_providers` catalogue, mounted
// at /platform/payment-providers and superadmin-only, plus the mandatory
// `gyms.payment_provider_id` end of the relation on /platform/gyms.
//
// The catalogue is global (no gym_id), so the seeded MONEI row is shared state:
// `createTestGym` in helpers.ts resolves the default provider for every test
// file. Tests that must own the default flag for a moment restore it to the
// seeded row before they finish, and afterAll puts the row back byte-for-byte.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// Every provider name this file creates carries this suffix, so a parallel
// worker's rows can never collide with ours on `active_name_key`.
const SUFFIX = Math.random().toString(36).slice(2, 8);

/** An id no `payment_providers` / `gyms` row will ever have. */
const UNKNOWN_PROVIDER_ID = 99999999;

// Providers created through the API here — hard-deleted in afterAll, after every
// gym pointing at one has been moved back to the seeded default (FK is RESTRICT).
const createdProviderIds: number[] = [];
// Gyms created through POST /platform/gyms (not via createTestGym).
const extraGymIds: string[] = [];

interface SeededProvider {
  id: number;
  name: string;
  provider_key: string;
  status: string;
  is_default: number;
  modified_at: string | null;
  modified_by_name: string | null;
}

let seeded: SeededProvider;
let gymId: string;

// Default: TEST_USER_ID is a superadmin. Tests that need a non-superadmin user
// override this via mockResolvedValue (beforeEach puts it back).
const mockGetUser = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin',
    firstName: 'Super',
    lastName: 'Admin',
    emailAddresses: [],
    primaryEmailAddressId: null,
  }),
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

beforeAll(async () => {
  const { rows } = await db.query<SeededProvider>(
    `SELECT id, name, provider_key, status, is_default, modified_at, modified_by_name
     FROM payment_providers
     WHERE is_default = 1 AND deleted_at IS NULL LIMIT 1`,
  );
  // Migration 175 seeds it; without it createTestGym cannot insert a gym at all.
  expect(rows).toHaveLength(1);
  seeded = { ...rows[0], id: Number(rows[0].id) };

  gymId = await createTestGym(`PP Main Gym ${SUFFIX}`);
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  if (createdProviderIds.length > 0) {
    const marks = createdProviderIds.map(() => '?').join(',');
    // The FK is RESTRICT: move every gym off a provider this file created before
    // the rows can go. The seeded default is where createTestGym would have put
    // them anyway, so this is safe even for a row another worker touched.
    await db.query(
      `UPDATE gyms SET payment_provider_id = ? WHERE payment_provider_id IN (${marks})`,
      [seeded.id, ...createdProviderIds],
    );
  }

  if (extraGymIds.length > 0) {
    const marks = extraGymIds.map(() => '?').join(',');
    await db.query(`DELETE FROM gym_charges WHERE gym_id IN (${marks})`, extraGymIds);
    await db.query(`DELETE FROM gyms WHERE id IN (${marks})`, extraGymIds);
  }

  await cleanupTestGyms();

  if (createdProviderIds.length > 0) {
    const marks = createdProviderIds.map(() => '?').join(',');
    // Hard delete (not the API's soft delete): these rows must not linger in a
    // catalogue every other test file and the admin UI read.
    await db.query(`DELETE FROM payment_providers WHERE id IN (${marks})`, createdProviderIds);
  }

  // Put the seeded row back exactly as found — the default flag above all, since
  // helpers.createTestGym depends on one existing.
  await db.query(
    `UPDATE payment_providers
     SET is_default = ?, status = ?, name = ?, modified_at = ?, modified_by_name = ?
     WHERE id = ?`,
    [seeded.is_default, seeded.status, seeded.name, seeded.modified_at, seeded.modified_by_name, seeded.id],
  );

  await db.end();
});

beforeEach(() => {
  mockGetUser.mockClear();
  mockGetUser.mockResolvedValue({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin',
    firstName: 'Super',
    lastName: 'Admin',
    emailAddresses: [],
    primaryEmailAddressId: null,
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** POST a provider as superadmin, tracking a created row for cleanup. */
async function createProvider(body: Record<string, unknown>) {
  const res = await request
    .post('/platform/payment-providers')
    .set('Authorization', TEST_AUTH_HEADER)
    .send(body);
  if (res.status === 201 && res.body?.id) createdProviderIds.push(Number(res.body.id));
  return res;
}

/** A unique, supported provider row. */
async function createSupportedProvider(label: string, extra: Record<string, unknown> = {}) {
  const res = await createProvider({ name: `PP ${label} ${SUFFIX}`, provider_key: 'monei', ...extra });
  expect(res.status).toBe(201);
  return Number(res.body.id);
}

/** Hand the default flag back to the seeded row through the API. */
async function restoreSeededDefault() {
  const res = await request
    .put(`/platform/payment-providers/${seeded.id}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .send({ is_default: true });
  expect(res.status).toBe(200);
  expect(res.body.is_default).toBe(true);
}

async function defaultProviderIds(): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM payment_providers WHERE is_default = 1 AND deleted_at IS NULL',
  );
  return rows.map((r) => Number(r.id));
}

/** Points an existing gym at a provider directly (setup, not the action under test). */
async function pointGymAtProvider(targetGymId: string, providerId: number) {
  await db.query('UPDATE gyms SET payment_provider_id = ? WHERE id = ?', [providerId, targetGymId]);
}

async function listProviders() {
  const res = await request
    .get('/platform/payment-providers')
    .set('Authorization', TEST_AUTH_HEADER);
  expect(res.status).toBe(200);
  return res.body as any[];
}

/** POST /platform/gyms as superadmin, tracking the created gym for cleanup. */
async function platformCreateGym(body: Record<string, unknown>) {
  const res = await request
    .post('/platform/gyms')
    .set('Authorization', TEST_AUTH_HEADER)
    .send(body);
  if (res.status === 201 && res.body?.id) extraGymIds.push(res.body.id);
  return res;
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe('Auth guard', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request.get('/platform/payment-providers');
    expect(res.status).toBe(401);
  });

  it('returns 403 when the authenticated user is not a superadmin', async () => {
    mockGetUser.mockResolvedValue({
      publicMetadata: {},
      fullName: 'Regular User',
      firstName: 'Regular',
      lastName: 'User',
      emailAddresses: [],
      primaryEmailAddressId: null,
    });
    const res = await request
      .get('/platform/payment-providers')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(403);
  });
});

// ─── GET / ────────────────────────────────────────────────────────────────────

describe('GET /platform/payment-providers', () => {
  it('returns an array containing the seeded MONEI row as the default, with a numeric gym_count', async () => {
    const rows = await listProviders();
    expect(Array.isArray(rows)).toBe(true);

    const monei = rows.find((p) => Number(p.id) === seeded.id);
    expect(monei).toBeDefined();
    expect(monei).toMatchObject({
      name: 'MONEI',
      provider_key: 'monei',
      status: 'active',
      is_default: true,
    });
    expect(typeof monei.gym_count).toBe('number');
    // The gym created in beforeAll takes the default provider.
    expect(monei.gym_count).toBeGreaterThan(0);
    // Generated helper columns must never leak into the response.
    expect(monei).not.toHaveProperty('default_provider_key');
    expect(monei).not.toHaveProperty('active_name_key');
  });
});

// ─── GET /deployment ──────────────────────────────────────────────────────────

describe('GET /platform/payment-providers/deployment', () => {
  it('reports the API deployment status in the documented shape', async () => {
    const res = await request
      .get('/platform/payment-providers/deployment')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      provider_key: expect.any(String),
      credentials_configured: expect.any(Boolean),
      missing_config: expect.any(Array),
      supported_provider_keys: expect.arrayContaining(['monei']),
    });
    // Nullable, but the keys must be present so the UI can render "not set".
    expect(res.body).toHaveProperty('environment');
    expect(res.body).toHaveProperty('webhook_url');
    for (const entry of res.body.missing_config) expect(typeof entry).toBe('string');
  });
});

// ─── POST / ───────────────────────────────────────────────────────────────────

describe('POST /platform/payment-providers', () => {
  it('creates a provider and returns 201 with the shaped row', async () => {
    const res = await createProvider({
      name: `PP Created ${SUFFIX}`,
      provider_key: 'monei',
      description: 'Created by payment-providers.test.ts',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: `PP Created ${SUFFIX}`,
      provider_key: 'monei',
      description: 'Created by payment-providers.test.ts',
      status: 'active',
      is_default: false,
      gym_count: 0,
    });
    expect(Number(res.body.id)).toBeGreaterThan(0);
    expect(res.body.created_at).not.toBeNull();
  });

  it('returns 400 when name is missing', async () => {
    const res = await createProvider({ provider_key: 'monei' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it('returns 400 for a provider_key no adapter implements', async () => {
    const res = await createProvider({ name: `PP Stripe ${SUFFIX}`, provider_key: 'stripe' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provider_key/);
  });

  it('returns 409 for a name already used by a non-deleted provider', async () => {
    const name = `PP Duplicate ${SUFFIX}`;
    const first = await createProvider({ name, provider_key: 'monei' });
    expect(first.status).toBe(201);

    const second = await createProvider({ name, provider_key: 'monei' });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already exists/i);
  });

  it('moves the default flag off the previous default when created with is_default', async () => {
    expect(await defaultProviderIds()).toEqual([seeded.id]);

    const res = await createProvider({
      name: `PP New Default ${SUFFIX}`,
      provider_key: 'monei',
      is_default: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.is_default).toBe(true);
    const newId = Number(res.body.id);

    // The unique index allows exactly one default among non-deleted rows.
    expect(await defaultProviderIds()).toEqual([newId]);

    const seededAfter = await request
      .get(`/platform/payment-providers/${seeded.id}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(seededAfter.status).toBe(200);
    expect(seededAfter.body.is_default).toBe(false);

    await restoreSeededDefault();
    expect(await defaultProviderIds()).toEqual([seeded.id]);
  });

  it('returns 400 when an inactive provider is asked to be the default', async () => {
    const res = await createProvider({
      name: `PP Inactive Default ${SUFFIX}`,
      provider_key: 'monei',
      status: 'inactive',
      is_default: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/active/i);
  });
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

describe('PUT /platform/payment-providers/:id', () => {
  it('renames a provider and sets modified_at', async () => {
    const id = await createSupportedProvider('Rename Before');

    const res = await request
      .put(`/platform/payment-providers/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `PP Rename After ${SUFFIX}` });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`PP Rename After ${SUFFIX}`);
    expect(res.body.modified_at).not.toBeNull();
  });

  it('returns 400 when clearing is_default on the current default', async () => {
    const res = await request
      .put(`/platform/payment-providers/${seeded.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ is_default: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/another payment provider/i);
    // The flag must be untouched.
    expect(await defaultProviderIds()).toEqual([seeded.id]);
  });

  it('returns 409 with usageCount when deactivating a provider gyms point at', async () => {
    const providerId = await createSupportedProvider('Deactivate Blocked');
    const usingGymId = await createTestGym(`PP Deactivate Gym ${SUFFIX}`);
    await pointGymAtProvider(usingGymId, providerId);

    const res = await request
      .put(`/platform/payment-providers/${providerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ status: 'inactive' });
    expect(res.status).toBe(409);
    expect(res.body.usageCount).toBeGreaterThanOrEqual(1);
    expect(res.body.error).toMatch(/cannot be deactivated/i);
    expect(res.body.references.map((r: any) => r.name)).toContain(`PP Deactivate Gym ${SUFFIX}`);

    // Still active in the DB — the 409 must not have written anything.
    const { rows } = await db.query<{ status: string }>(
      'SELECT status FROM payment_providers WHERE id = ?',
      [providerId],
    );
    expect(rows[0].status).toBe('active');
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request
      .put(`/platform/payment-providers/${UNKNOWN_PROVIDER_ID}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `PP Ghost ${SUFFIX}` });
    expect(res.status).toBe(404);
  });
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

describe('DELETE /platform/payment-providers/:id', () => {
  it('returns 409 when gyms still point at the provider', async () => {
    const providerId = await createSupportedProvider('Delete Blocked');
    const usingGymId = await createTestGym(`PP Delete Gym ${SUFFIX}`);
    await pointGymAtProvider(usingGymId, providerId);

    const res = await request
      .delete(`/platform/payment-providers/${providerId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(409);
    expect(res.body.usageCount).toBeGreaterThanOrEqual(1);
    expect(res.body.error).toMatch(/cannot be deleted/i);
    expect(res.body.references.map((r: any) => r.name)).toContain(`PP Delete Gym ${SUFFIX}`);

    const { rows } = await db.query<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM payment_providers WHERE id = ?',
      [providerId],
    );
    expect(rows[0].deleted_at).toBeNull();
  });

  it('says the default cannot be deleted even when gyms also point at it', async () => {
    // The default is checked before usage on purpose: "move them to another
    // provider first" is advice that cannot work for the default, since moving
    // every gym off it still leaves it undeletable.
    const providerId = await createSupportedProvider('Delete Default Used', { is_default: true });
    try {
      const usingGymId = await createTestGym(`PP Default Used Gym ${SUFFIX}`);
      await pointGymAtProvider(usingGymId, providerId);

      const res = await request
        .delete(`/platform/payment-providers/${providerId}`)
        .set('Authorization', TEST_AUTH_HEADER);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/default payment provider cannot be deleted/i);
      expect(res.body.usageCount).toBeGreaterThanOrEqual(1);
      expect(res.body.references.map((r: any) => r.name)).toContain(`PP Default Used Gym ${SUFFIX}`);
    } finally {
      await restoreSeededDefault();
    }
  });

  it('returns 409 for the default provider even when no gym uses it', async () => {
    // Owning the default flag for a moment is the only way to reach this branch:
    // the seeded default always has gyms, which the usage check catches first.
    const providerId = await createSupportedProvider('Delete Default', { is_default: true });
    try {
      const res = await request
        .delete(`/platform/payment-providers/${providerId}`)
        .set('Authorization', TEST_AUTH_HEADER);
      expect(res.status).toBe(409);
      expect(res.body.usageCount).toBe(0);
      expect(res.body.error).toMatch(/default payment provider cannot be deleted/i);
    } finally {
      await restoreSeededDefault();
    }
    expect(await defaultProviderIds()).toEqual([seeded.id]);
  });

  it('soft-deletes an unused non-default provider: 204, hidden from the list, deleted_at set', async () => {
    const providerId = await createSupportedProvider('Delete Ok');

    const res = await request
      .delete(`/platform/payment-providers/${providerId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(204);

    const rows = await listProviders();
    expect(rows.map((p) => Number(p.id))).not.toContain(providerId);

    const getRes = await request
      .get(`/platform/payment-providers/${providerId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(getRes.status).toBe(404);

    const { rows: dbRows } = await db.query<{ deleted_at: string | null; status: string }>(
      'SELECT deleted_at, status FROM payment_providers WHERE id = ?',
      [providerId],
    );
    expect(dbRows).toHaveLength(1);
    expect(dbRows[0].deleted_at).not.toBeNull();
    expect(dbRows[0].status).toBe('inactive');
  });
});

// ─── GET /:id/references ──────────────────────────────────────────────────────

describe('GET /platform/payment-providers/:id/references', () => {
  it('returns usageCount and the names of the gyms pointing at the provider', async () => {
    const providerId = await createSupportedProvider('References');
    const usingGymId = await createTestGym(`PP References Gym ${SUFFIX}`);
    await pointGymAtProvider(usingGymId, providerId);

    const res = await request
      .get(`/platform/payment-providers/${providerId}/references`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Number(res.body.entityId)).toBe(providerId);
    expect(res.body.usageCount).toBe(1);
    expect(res.body.references).toEqual([
      { id: usingGymId, name: `PP References Gym ${SUFFIX}` },
    ]);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request
      .get(`/platform/payment-providers/${UNKNOWN_PROVIDER_ID}/references`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });
});

// ─── The gym side of the relation (gyms.payment_provider_id) ───────────────────

describe('Gym payment_provider_id (platform gyms router)', () => {
  it('assigns the default provider when POST /platform/gyms names none', async () => {
    const [currentDefaultId] = await defaultProviderIds();
    expect(currentDefaultId).toBe(seeded.id);

    const res = await platformCreateGym({ name: `PP Default Assign Gym ${SUFFIX}` });
    expect(res.status).toBe(201);
    expect(Number(res.body.payment_provider_id)).toBe(currentDefaultId);
    expect(res.body.payment_provider).toMatchObject({
      id: currentDefaultId,
      provider_key: 'monei',
      is_default: true,
    });

    const { rows } = await db.query<{ payment_provider_id: number }>(
      'SELECT payment_provider_id FROM gyms WHERE id = ?',
      [res.body.id],
    );
    expect(Number(rows[0].payment_provider_id)).toBe(currentDefaultId);
  });

  it('accepts an explicit active payment_provider_id on POST /platform/gyms', async () => {
    const providerId = await createSupportedProvider('Explicit Assign');

    const res = await platformCreateGym({
      name: `PP Explicit Assign Gym ${SUFFIX}`,
      payment_provider_id: providerId,
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.payment_provider_id)).toBe(providerId);
    expect(res.body.payment_provider.is_default).toBe(false);
  });

  it('returns 400 when POST /platform/gyms names an unknown payment_provider_id', async () => {
    const res = await request
      .post('/platform/gyms')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `PP Bad Provider Gym ${SUFFIX}`, payment_provider_id: UNKNOWN_PROVIDER_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/payment_provider_id/);
  });

  it('returns 400 for a payment_provider_id that is not an id at all', async () => {
    // `Number(true)` is 1, so a coercing check would have silently re-pointed
    // the gym at whichever provider happens to be id 1.
    const { rows: before } = await db.query<{ payment_provider_id: number }>(
      'SELECT payment_provider_id FROM gyms WHERE id = ?',
      [gymId],
    );
    for (const value of [true, {}, [], 'abc']) {
      const res = await request
        .put(`/platform/gyms/${gymId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .send({ payment_provider_id: value });
      expect(res.status, `payment_provider_id: ${JSON.stringify(value)}`).toBe(400);
    }
    const { rows: after } = await db.query<{ payment_provider_id: number }>(
      'SELECT payment_provider_id FROM gyms WHERE id = ?',
      [gymId],
    );
    expect(after[0].payment_provider_id).toBe(before[0].payment_provider_id);
  });

  it('returns 400 when PUT /platform/gyms/:id tries to null payment_provider_id', async () => {
    const res = await request
      .put(`/platform/gyms/${gymId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ payment_provider_id: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/payment_provider_id/);

    // The gym keeps the provider it had.
    const { rows } = await db.query<{ payment_provider_id: number | null }>(
      'SELECT payment_provider_id FROM gyms WHERE id = ?',
      [gymId],
    );
    expect(rows[0].payment_provider_id).not.toBeNull();
  });
});
