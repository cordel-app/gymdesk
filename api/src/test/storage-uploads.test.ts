// Regression gate for #1714 stage 2: the generic `POST /storage/uploads/*` routes
// stored an uploaded image unprocessed (no WebP, no thumbnail, no ownership
// rules). `exercise-image` was retired once nothing called it (#719/#1420) and
// `nutrition-image` by #1035; every image upload now goes through its own
// per-row route and the shared WebP pipeline.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Storage Uploads Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('generic storage upload routes (retired)', () => {
  it.each(['exercise-image', 'nutrition-image'])('POST /storage/uploads/%s no longer exists', async (target) => {
    const res = await request
      .post(`/storage/uploads/${target}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-png-bytes'));
    expect(res.status).toBe(404);
  });
});
