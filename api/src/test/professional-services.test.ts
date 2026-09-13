// Tests for professional-services.ts router

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

// ─── Shared setup helpers ─────────────────────────────────────────────────────

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Seeds an 'active' gym_professional_services row for every seeded system
 * Professional Service, for the given gym. This mirrors the seeding that
 * POST /gyms performs on real gym creation (api/src/api/gyms.ts). Because
 * createTestGym() inserts directly into `gyms` and bypasses that route, a
 * test gym has NO gym_professional_services rows by default — and since the
 * router's SELECT inner-joins gym_professional_services, the 5 system
 * services would silently not appear for it at all unless seeded here.
 */
async function seedSystemServicesForGym(gymId: string): Promise<void> {
  await db.query(
    `INSERT IGNORE INTO gym_professional_services (gym_id, professional_service_id, status, created_at)
     SELECT ?, id, 'active', UTC_TIMESTAMP() FROM professional_services WHERE is_system = 1`,
    [gymId],
  );
}

/** Resolves the id of a migration-seeded system Professional Service by its system_key. */
let _systemServiceIdsBySystemKey: Record<string, number> | null = null;
async function systemServiceId(systemKey: string): Promise<number> {
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

/** Inserts a custom (non-system) professional_services row plus its gym_professional_services row directly. */
async function createCustomService(
  gymId: string,
  overrides: Record<string, unknown> = {},
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO professional_services (gym_id, name, description, is_system, system_key)
     VALUES (?, ?, ?, 0, NULL)`,
    [
      gymId,
      (overrides.name as string | undefined) ?? uniqueName('Custom Service'),
      (overrides.description as string | undefined) ?? null,
    ],
  );
  await db.query(
    `INSERT INTO gym_professional_services (gym_id, professional_service_id, status)
     VALUES (?, ?, ?)`,
    [gymId, insertId, (overrides.status as string | undefined) ?? 'active'],
  );
  return insertId;
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe('Auth guard', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('PS Auth Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 401 on GET / without auth', async () => {
    const res = await request.get('/professional-services').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 401 on POST / without auth', async () => {
    const res = await request
      .post('/professional-services')
      .set('x-gym-id', gymId)
      .send({ name: 'No Auth Service' });
    expect(res.status).toBe(401);
  });

  it('returns 401 on DELETE /:id without auth', async () => {
    const res = await request.delete('/professional-services/1').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('Tenant isolation', () => {
  let gymA: string;
  let gymB: string;
  let customInGymA: number;

  beforeAll(async () => {
    gymA = await createTestGym('PS Tenant Gym A');
    await createTestMembership(gymA, 'admin');
    customInGymA = await createCustomService(gymA, { name: 'Gym A Massage' });

    gymB = await createTestGym('PS Tenant Gym B');
    await createTestMembership(gymB, 'admin');
  });

  it('returns 403 when the user has no membership in the requested gym', async () => {
    const noMembershipGym = await createTestGym('PS No Membership Gym');
    const res = await request
      .get('/professional-services')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', noMembershipGym);
    expect(res.status).toBe(403);
  });

  it('does not include gymA custom services in gymB list', async () => {
    const res = await request
      .get('/professional-services')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: number }>).map((s) => s.id)).not.toContain(customInGymA);
  });

  it('returns 404 on GET /:id for a custom service belonging to another gym', async () => {
    const res = await request
      .get(`/professional-services/${customInGymA}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });

  it('returns 404 on PUT /:id for a custom service belonging to another gym', async () => {
    const res = await request
      .put(`/professional-services/${customInGymA}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ name: 'Hijacked Name' });
    expect(res.status).toBe(404);
  });

  it('returns 404 on DELETE /:id for a custom service belonging to another gym', async () => {
    const res = await request
      .delete(`/professional-services/${customInGymA}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });

  it('returns 404 on POST /:id/activate for a custom service belonging to another gym', async () => {
    const res = await request
      .post(`/professional-services/${customInGymA}/activate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });

  it('returns 404 on POST /:id/duplicate for a custom service belonging to another gym', async () => {
    const res = await request
      .post(`/professional-services/${customInGymA}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });
});

// ─── Module access and role guard ──────────────────────────────────────────────

describe('Module access and role guard', () => {
  let noAccessGym: string;
  let readOnlyGym: string;
  let readOnlyServiceId: number;

  beforeAll(async () => {
    // ORGANIZATION permission matrix: accountant = NONE, front_desk = R (see
    // api/src/infra/permissions.ts PERMISSION_MATRIX.ORGANIZATION).
    noAccessGym = await createTestGym('PS No Access Gym');
    await createTestMembership(noAccessGym, 'accountant');

    readOnlyGym = await createTestGym('PS Read Only Gym');
    await createTestMembership(readOnlyGym, 'front_desk');
    readOnlyServiceId = await createCustomService(readOnlyGym, { name: 'Read Only Fixture' });
  });

  it('returns 403 on GET / for a role with no ORGANIZATION access', async () => {
    const res = await request
      .get('/professional-services')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', noAccessGym);
    expect(res.status).toBe(403);
  });

  it('allows a read-only role to GET the list', async () => {
    const res = await request
      .get('/professional-services')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', readOnlyGym);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('allows a read-only role to GET a single service', async () => {
    const res = await request
      .get(`/professional-services/${readOnlyServiceId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', readOnlyGym);
    expect(res.status).toBe(200);
  });

  it('returns 403 when a read-only role attempts POST /', async () => {
    const res = await request
      .post('/professional-services')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', readOnlyGym)
      .send({ name: 'Forbidden Service' });
    expect(res.status).toBe(403);
  });

  it('returns 403 when a read-only role attempts PUT /:id', async () => {
    const res = await request
      .put(`/professional-services/${readOnlyServiceId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', readOnlyGym)
      .send({ name: 'Should Fail' });
    expect(res.status).toBe(403);
  });

  it('returns 403 when a read-only role attempts POST /:id/activate', async () => {
    const res = await request
      .post(`/professional-services/${readOnlyServiceId}/activate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', readOnlyGym);
    expect(res.status).toBe(403);
  });

  it('returns 403 when a read-only role attempts POST /:id/deactivate', async () => {
    const res = await request
      .post(`/professional-services/${readOnlyServiceId}/deactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', readOnlyGym);
    expect(res.status).toBe(403);
  });

  it('returns 403 when a read-only role attempts POST /:id/duplicate', async () => {
    const res = await request
      .post(`/professional-services/${readOnlyServiceId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', readOnlyGym);
    expect(res.status).toBe(403);
  });

  it('returns 403 when a read-only role attempts DELETE /:id', async () => {
    const res = await request
      .delete(`/professional-services/${readOnlyServiceId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', readOnlyGym);
    expect(res.status).toBe(403);
  });
});

// ─── GET / and GET /:id ─────────────────────────────────────────────────────────

describe('GET /professional-services and GET /professional-services/:id', () => {
  let gymId: string;
  let customId: number;
  let inactiveCustomId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PS Get Gym');
    await createTestMembership(gymId, 'admin');
    await seedSystemServicesForGym(gymId);
    customId = await createCustomService(gymId, { name: 'Aqua Aerobics', description: 'Pool based class' });
    inactiveCustomId = await createCustomService(gymId, { name: 'Zumba Nights', status: 'inactive' });
  });

  it('returns the 5 seeded system services plus custom services, combined', async () => {
    const res = await request
      .get('/professional-services')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const rows = res.body as Array<{ id: number; is_system: number; system_key: string | null }>;
    expect(rows).toHaveLength(7); // 5 system + 2 custom, scoped to this fresh gym

    const systemKeys = rows.filter((r) => r.is_system).map((r) => r.system_key).sort();
    expect(systemKeys).toEqual(
      [
        'personal_training_individual',
        'personal_training_duo',
        'group_class',
        'nutrition_coaching',
        'physiotherapy',
      ].sort(),
    );
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([customId, inactiveCustomId]));
  });

  it('orders system services before custom services', async () => {
    const res = await request
      .get('/professional-services')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const rows = res.body as Array<{ is_system: number }>;
    const firstCustomIndex = rows.findIndex((r) => !r.is_system);
    const lastSystemIndex = rows.map((r) => r.is_system).lastIndexOf(1);
    expect(lastSystemIndex).toBeLessThan(firstCustomIndex);
  });

  it('returns a single system service by id', async () => {
    const groupClassId = await systemServiceId('group_class');
    const res = await request
      .get(`/professional-services/${groupClassId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Group Class');
    expect(res.body.is_system).toBe(1);
    expect(res.body.gym_id).toBeNull();
    expect(res.body.status).toBe('active');
  });

  it('returns a single custom service by id', async () => {
    const res = await request
      .get(`/professional-services/${customId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Aqua Aerobics');
    expect(res.body.description).toBe('Pool based class');
    expect(res.body.is_system).toBe(0);
    expect(res.body.gym_id).toBe(gymId);
  });

  it('returns 404 for a non-existent id', async () => {
    const res = await request
      .get('/professional-services/9999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 400 for an invalid status filter', async () => {
    const res = await request
      .get('/professional-services?status=bogus')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('filters by ?status=inactive', async () => {
    const res = await request
      .get('/professional-services?status=inactive')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ id: number; status: string }>;
    expect(rows.every((r) => r.status === 'inactive')).toBe(true);
    expect(rows.map((r) => r.id)).toContain(inactiveCustomId);
  });

  it('filters by ?search= matching the name', async () => {
    const res = await request
      .get('/professional-services?search=Aqua')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ id: number }>;
    expect(rows.map((r) => r.id)).toEqual([customId]);
  });
});

// ─── POST / — create a custom Professional Service ─────────────────────────────

describe('POST /professional-services', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('PS Create Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('creates a custom service with gym_id set, is_system = 0, and an active gym_professional_services row', async () => {
    const res = await request
      .post('/professional-services')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Sports Massage', description: 'Deep tissue massage for athletes' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Sports Massage');
    expect(res.body.description).toBe('Deep tissue massage for athletes');
    expect(res.body.gym_id).toBe(gymId);
    expect(res.body.is_system).toBe(0);
    expect(res.body.system_key).toBeNull();
    expect(res.body.status).toBe('active');

    const { rows } = await db.query(
      'SELECT status FROM gym_professional_services WHERE gym_id = ? AND professional_service_id = ?',
      [gymId, res.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
  });

  it('defaults description to null when omitted', async () => {
    const res = await request
      .post('/professional-services')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'No Description Service' });
    expect(res.status).toBe(201);
    expect(res.body.description).toBeNull();
  });

  it('trims the name', async () => {
    const res = await request
      .post('/professional-services')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: '  Padded Name  ' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Padded Name');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request
      .post('/professional-services')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ description: 'No name here' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is blank', async () => {
    const res = await request
      .post('/professional-services')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
  });
});

// ─── PUT /:id — edit a custom Professional Service ─────────────────────────────

describe('PUT /professional-services/:id', () => {
  let gymId: string;
  let customId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PS Update Gym');
    await createTestMembership(gymId, 'admin');
    customId = await createCustomService(gymId, { name: 'Update Me Service', description: 'Old description' });
  });

  it('updates the name and description of a custom service', async () => {
    const res = await request
      .put(`/professional-services/${customId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Updated Service Name', description: 'New description' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Service Name');
    expect(res.body.description).toBe('New description');
  });

  it('leaves the description unchanged when only name is sent', async () => {
    const res = await request
      .put(`/professional-services/${customId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Renamed Again' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Again');
    expect(res.body.description).toBe('New description');
  });

  it('returns 400 when name is sent blank', async () => {
    const res = await request
      .put(`/professional-services/${customId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent id', async () => {
    const res = await request
      .put('/professional-services/9999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Ghost Service' });
    expect(res.status).toBe(404);
  });

  it('returns 403 when attempting to edit a system service, and leaves it untouched', async () => {
    const groupClassId = await systemServiceId('group_class');
    const res = await request
      .put(`/professional-services/${groupClassId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Hijacked System Service' });
    expect(res.status).toBe(403);

    const { rows } = await db.query(
      'SELECT name, is_system, deleted_at FROM professional_services WHERE id = ?',
      [groupClassId],
    );
    expect(rows[0].name).toBe('Group Class');
    expect(rows[0].is_system).toBe(1);
    expect(rows[0].deleted_at).toBeNull();
  });
});

// ─── POST /:id/activate and /:id/deactivate ────────────────────────────────────

describe('POST /professional-services/:id/activate and /deactivate', () => {
  let gymA: string;
  let gymB: string;
  let customIdInGymA: number;
  let groupClassId: number;

  beforeAll(async () => {
    gymA = await createTestGym('PS Activate Gym A');
    await createTestMembership(gymA, 'admin');
    await seedSystemServicesForGym(gymA);

    gymB = await createTestGym('PS Activate Gym B');
    await createTestMembership(gymB, 'admin');
    await seedSystemServicesForGym(gymB);

    customIdInGymA = await createCustomService(gymA, { name: 'Toggle Custom Service' });
    groupClassId = await systemServiceId('group_class');
  });

  it('deactivates a custom service', async () => {
    const res = await request
      .post(`/professional-services/${customIdInGymA}/deactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('inactive');
  });

  it('reactivates a custom service', async () => {
    const res = await request
      .post(`/professional-services/${customIdInGymA}/activate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  it('deactivates a system service for one gym without affecting another gym', async () => {
    const resDeactivate = await request
      .post(`/professional-services/${groupClassId}/deactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(resDeactivate.status).toBe(200);
    expect(resDeactivate.body.status).toBe('inactive');
    expect(resDeactivate.body.is_system).toBe(1);

    const gymBView = await request
      .get(`/professional-services/${groupClassId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(gymBView.status).toBe(200);
    expect(gymBView.body.status).toBe('active');
  });

  it('reactivates the system service in gymA without disturbing gymB', async () => {
    const res = await request
      .post(`/professional-services/${groupClassId}/activate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');

    const gymBView = await request
      .get(`/professional-services/${groupClassId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(gymBView.body.status).toBe('active');
  });

  it('returns 404 on activate for a non-existent id', async () => {
    const res = await request
      .post('/professional-services/9999999/activate')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(404);
  });

  it('returns 404 on deactivate for a non-existent id', async () => {
    const res = await request
      .post('/professional-services/9999999/deactivate')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(404);
  });

  it('returns 404 on activate when this gym has no gym_professional_services row for the service', async () => {
    // This gym never had seedSystemServicesForGym() run, so it has no
    // gym_professional_services row for the system service at all — the
    // router's UPDATE ... JOIN matches zero rows.
    const unseededGym = await createTestGym('PS Activate Gym Unseeded');
    await createTestMembership(unseededGym, 'admin');
    const res = await request
      .post(`/professional-services/${groupClassId}/activate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', unseededGym);
    expect(res.status).toBe(404);
  });
});

// ─── POST /:id/duplicate ────────────────────────────────────────────────────────

describe('POST /professional-services/:id/duplicate', () => {
  let gymId: string;
  let customId: number;
  let groupClassId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PS Duplicate Gym');
    await createTestMembership(gymId, 'admin');
    customId = await createCustomService(gymId, { name: 'Original Custom Service', description: 'Copy me' });
    groupClassId = await systemServiceId('group_class');
  });

  it('duplicates a system service into a new custom, active, gym-owned copy', async () => {
    const res = await request
      .post(`/professional-services/${groupClassId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Group Class - Copy');
    expect(res.body.gym_id).toBe(gymId);
    expect(res.body.is_system).toBe(0);
    expect(res.body.system_key).toBeNull();
    expect(res.body.status).toBe('active');
    expect(res.body.id).not.toBe(groupClassId);
  });

  it('duplicates a custom service, copying its description', async () => {
    const res = await request
      .post(`/professional-services/${customId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Original Custom Service - Copy');
    expect(res.body.description).toBe('Copy me');
    expect(res.body.gym_id).toBe(gymId);
    expect(res.body.is_system).toBe(0);
    expect(res.body.status).toBe('active');
  });

  it('returns 404 when duplicating a non-existent id', async () => {
    const res = await request
      .post('/professional-services/9999999/duplicate')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── DELETE /:id — soft-delete custom Professional Services only ──────────────

describe('DELETE /professional-services/:id', () => {
  let gymId: string;
  let customId: number;
  let systemId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PS Delete Gym');
    await createTestMembership(gymId, 'admin');
    customId = await createCustomService(gymId, { name: 'Deletable Service' });
    systemId = await systemServiceId('nutrition_coaching');
  });

  it('returns 403 when attempting to delete a system service, and leaves it untouched', async () => {
    const res = await request
      .delete(`/professional-services/${systemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);

    const { rows } = await db.query(
      'SELECT deleted_at, is_system FROM professional_services WHERE id = ?',
      [systemId],
    );
    expect(rows[0].deleted_at).toBeNull();
    expect(rows[0].is_system).toBe(1);
  });

  it('soft-deletes a custom service and returns 204', async () => {
    const res = await request
      .delete(`/professional-services/${customId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('hides the soft-deleted service from GET /', async () => {
    const res = await request
      .get('/professional-services')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: number }>).map((s) => s.id)).not.toContain(customId);
  });

  it('returns 404 on GET /:id for the soft-deleted service', async () => {
    const res = await request
      .get(`/professional-services/${customId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 on a second delete attempt (already soft-deleted)', async () => {
    const res = await request
      .delete(`/professional-services/${customId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 when deleting a non-existent id', async () => {
    const res = await request
      .delete('/professional-services/9999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
