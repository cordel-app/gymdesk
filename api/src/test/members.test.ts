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

describe('Members — search (#326)', () => {
  let gymId: string;
  let otherGymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Search Test Gym');
    await createTestMembership(gymId, 'admin');

    // Insert members with distinct names/emails for search
    await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES
       (?, 'Alice Wonderland', 'alice@example.com'),
       (?, 'Bob Builder', 'bob@example.com'),
       (?, 'Charlie Brown', 'charlie@example.com')`,
      [gymId, gymId, gymId],
    );

    // A second gym for tenant isolation check
    otherGymId = await createTestGym('Other Gym');
    await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Alice Other', 'alice-other@example.com')`,
      [otherGymId],
    );
  });

  it('returns all members when q is absent', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
  });

  it('filters by name with q param (case-insensitive)', async () => {
    const res = await request
      .get('/members?q=alice')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Alice Wonderland');
  });

  it('filters by email with q param', async () => {
    const res = await request
      .get('/members?q=bob%40example')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.every((m: any) => m.name === 'Bob Builder')).toBe(true);
  });

  it('returns max 20 results when q is present', async () => {
    // Insert 25 members named "Searchable X"
    const values = Array.from({ length: 25 }, (_, i) =>
      `(?, 'Searchable ${i}', 'searchable${i}-${Date.now()}@example.com')`,
    ).join(',');
    await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES ${values}`,
      Array.from({ length: 25 }, () => gymId),
    );
    const res = await request
      .get('/members?q=Searchable')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(20);
  });

  it('tenant isolation — q search does not return other gym members', async () => {
    const res = await request
      .get('/members?q=alice')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.every((m: any) => m.gym_id === gymId)).toBe(true);
    expect(res.body.some((m: any) => m.email === 'alice-other@example.com')).toBe(false);
  });

  it('returns empty array when no match', async () => {
    const res = await request
      .get('/members?q=zzznomatch999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('unauthenticated request returns 401', async () => {
    const res = await request
      .get('/members?q=alice')
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});
