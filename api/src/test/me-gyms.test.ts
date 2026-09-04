// Tests for GET /me/gyms (#341)

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

describe('GET /me/gyms', () => {
  let gymA: string;
  let gymB: string;
  let gymC: string;

  beforeAll(async () => {
    // Names chosen for a clear alphabetical order: Athens < Madrid < Zaragoza
    gymA = await createTestGym('Zaragoza Gym');
    gymB = await createTestGym('Athens Gym');
    gymC = await createTestGym('Madrid Gym');

    // TEST_USER_ID belongs to gymA and gymC but NOT gymB
    await createTestMembership(gymA, 'member');
    await createTestMembership(gymC, 'member');
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request.get('/me/gyms');
    expect(res.status).toBe(401);
  });

  it('returns only the gyms the member belongs to', async () => {
    const res = await request
      .get('/me/gyms')
      .set('Authorization', TEST_AUTH_HEADER);

    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((g) => g.id);
    expect(ids).toContain(gymA);
    expect(ids).toContain(gymC);
    expect(ids).not.toContain(gymB);
  });

  it('returns gyms sorted alphabetically by name', async () => {
    const res = await request
      .get('/me/gyms')
      .set('Authorization', TEST_AUTH_HEADER);

    expect(res.status).toBe(200);
    const names = (res.body as { name: string }[]).map((g) => g.name);
    const relevant = names.filter((n) => ['Zaragoza Gym', 'Athens Gym', 'Madrid Gym'].includes(n));
    // Athens < Madrid < Zaragoza — only gymA (Zaragoza) and gymC (Madrid) are in the result
    const expected = ['Athens Gym', 'Madrid Gym', 'Zaragoza Gym'].filter((n) => relevant.includes(n));
    expect(relevant).toEqual(expected);
  });

  it('returns gym shape with id, name, and theme fields', async () => {
    const res = await request
      .get('/me/gyms')
      .set('Authorization', TEST_AUTH_HEADER);

    expect(res.status).toBe(200);
    const gym = (res.body as any[]).find((g) => g.id === gymA);
    expect(gym).toBeDefined();
    expect(gym).toHaveProperty('id');
    expect(gym).toHaveProperty('name');
    expect(gym).toHaveProperty('theme'); // may be null if no theme assigned
  });

  it('tenant isolation — member cannot use an unauthorized x-gym-id on a scoped route', async () => {
    // TEST_USER_ID is NOT in gymB; tenantContext must reject the request
    const res = await request
      .get('/me/profile')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);

    expect(res.status).toBe(403);
  });
});
