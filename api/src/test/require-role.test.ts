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
    await createTestMembership(gymId, 'front_desk');
  });

  it('returns 401 when no Authorization header is sent', async () => {
    const res = await request
      .post('/staff')
      .set('x-gym-id', gymId)
      .send({});

    expect(res.status).toBe(401);
  });

  it('returns 403 when a staff member hits an admin-only route (PATCH /staff/:id/deactivate)', async () => {
    const res = await request
      .patch('/staff/1/deactivate')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(403);
  });

  it('returns 403 when a staff member tries to POST /staff (admin-only write)', async () => {
    const res = await request
      .post('/staff')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ first_name: 'New', last_name: 'Hire', email: 'new@example.com', profile: 'Front Desk', hire_date: '2026-01-01' });

    expect(res.status).toBe(403);
  });
});
