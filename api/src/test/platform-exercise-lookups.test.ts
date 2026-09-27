// #806 — `GET /platform/exercises/lookups`.
//
// The shared Exercise editor renders Muscles and Allowed Result Types on both
// screens, so the platform **Base Exercises** page needs the same two catalogues
// the gym-facing page reads from `/muscles` and `/result-types`. Those two sit
// behind `tenantContext` + `requireModuleAccess('TRAINING')` +
// `requireFeatureEnabled('training.exercises')`, which is right for a gym screen
// and wrong for a platform one: a base exercise belongs to no gym, and the page
// must not stop working because the superadmin's currently selected gym has the
// exercises feature switched off.
//
// Neither catalogue is gym-scoped — `MUSCLE_KEYS` is a fixed list and
// `result_types` is migration 073's seeded, gym-less table — so this route is the
// same data behind this router's own `requireSuperadmin`.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, request } from './helpers';
import { MUSCLE_KEYS } from '../domain/muscles';

const superadminUser = { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Test Admin' };
const regularUser = { publicMetadata: {}, fullName: 'Test User' };

function mockUser(user: unknown) {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue(user as any);
}

beforeEach(() => { mockUser(superadminUser); });

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /platform/exercises/lookups', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/platform/exercises/lookups');
    expect(res.status).toBe(401);
  });

  it('returns 403 for an authenticated non-superadmin', async () => {
    mockUser(regularUser);
    const res = await request.get('/platform/exercises/lookups').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(403);
  });

  it('answers with both catalogues', async () => {
    const res = await request.get('/platform/exercises/lookups').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.muscles.map((m: { key: string }) => m.key)).toEqual([...MUSCLE_KEYS]);
    expect(Array.isArray(res.body.result_types)).toBe(true);
    expect(res.body.result_types.length).toBeGreaterThan(0);
    for (const rt of res.body.result_types) {
      expect(Object.keys(rt).sort()).toEqual(['id', 'name', 'slug']);
    }
  });

  it('needs no gym — the route takes no x-gym-id and is not tenant-scoped', async () => {
    const res = await request.get('/platform/exercises/lookups').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    // The same answer, whatever the caller's selected gym is.
    const gymId = await createTestGym('Lookups Gym');
    const withGym = await request
      .get('/platform/exercises/lookups')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(withGym.status).toBe(200);
    expect(withGym.body).toEqual(res.body);
  });

  it('is not shadowed by the get-one route', async () => {
    // `/:id` is registered after `/lookups`; if it were not, Express would match
    // `lookups` as an exercise id and answer 404.
    const res = await request.get('/platform/exercises/lookups').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).not.toBe(404);
  });
});
