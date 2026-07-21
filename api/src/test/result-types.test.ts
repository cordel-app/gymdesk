// Tests for result-types.ts router
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym();
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /result-types', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/result-types');
    expect(res.status).toBe(401);
  });

  it('returns 400 or 401 when x-gym-id header is missing', async () => {
    const res = await request.get('/result-types').set('Authorization', TEST_AUTH_HEADER);
    expect([400, 401]).toContain(res.status);
  });

  it('returns 200 with all 9 result types', async () => {
    const res = await request
      .get('/result-types')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(9);

    const slugs: string[] = res.body.map((r: { slug: string }) => r.slug);
    const expectedSlugs = ['repetitions', 'weight', 'distance', 'duration', 'pace', 'speed', 'calories', 'rpe', 'rest_time'];
    for (const slug of expectedSlugs) {
      expect(slugs).toContain(slug);
    }
  });

  it('returns objects with id, name, slug fields', async () => {
    const res = await request
      .get('/result-types')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    const first = res.body[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('slug');
  });

  it('returns result types ordered by id ASC', async () => {
    const res = await request
      .get('/result-types')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    const ids: number[] = res.body.map((r: { id: number }) => r.id);
    const sorted = [...ids].sort((a, b) => a - b);
    expect(ids).toEqual(sorted);
  });
});
