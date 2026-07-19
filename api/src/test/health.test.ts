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

describe('GET /health', () => {
  it('returns 200 without auth', async () => {
    const res = await request.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('requireAuth middleware', () => {
  it('returns 401 when no Authorization header is sent', async () => {
    const res = await request.get('/members');
    expect(res.status).toBe(401);
  });
});

describe('tenantContext middleware', () => {
  it('returns 401 when x-gym-id header is missing', async () => {
    const res = await request.get('/members').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(401);
  });

  it('returns 403 when the user has no membership in the requested gym', async () => {
    const gymId = await createTestGym('Other Gym');
    // Deliberately do NOT insert a gym_memberships row
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
  });
});

describe('GET /members', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym();
    await createTestMembership(gymId, 'admin');
  });

  it('returns 200 and an array for an authenticated admin', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
