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

describe('requireRole', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Role Test Gym');
    await createTestMembership(gymId, 'staff');
  });

  it('returns 401 when no Authorization header is sent', async () => {
    const res = await request
      .get('/gym-users')
      .set('x-gym-id', gymId);

    expect(res.status).toBe(401);
  });

  it('returns 403 when a staff member hits an admin-only route (GET /gym-users)', async () => {
    const res = await request
      .get('/gym-users')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(403);
  });

  it('returns 403 when a staff member tries to POST /gym-users (admin-only write)', async () => {
    const res = await request
      .post('/gym-users')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ email: 'new@example.com', role: 'staff' });

    expect(res.status).toBe(403);
  });
});
