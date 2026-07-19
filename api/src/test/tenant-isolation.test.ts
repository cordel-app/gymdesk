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

describe('Tenant isolation', () => {
  let gymA: string;
  let gymB: string;
  let memberIdInA: number;

  beforeAll(async () => {
    gymA = await createTestGym('Gym A');
    gymB = await createTestGym('Gym B');
    await createTestMembership(gymA, 'admin');
    await createTestMembership(gymB, 'admin');

    // Insert a center for gymA (needed by POST /members)
    const { insertId: centerId } = await db.query(
      `INSERT INTO centers (gym_id, name) VALUES (?, 'Main')`,
      [gymA],
    );

    const { insertId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Alice', 'alice@gymA.test')`,
      [gymA],
    );
    memberIdInA = insertId;
    await db.query(
      `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at)
       VALUES (?, ?, ?, 1, UTC_TIMESTAMP())`,
      [gymA, memberIdInA, centerId],
    );
  });

  it('returns 404 when reading a gym-A member with gym-B credentials', async () => {
    const res = await request
      .get(`/members/${memberIdInA}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);

    expect(res.status).toBe(404);
  });

  it('returns 404 when updating a gym-A member with gym-B credentials', async () => {
    const res = await request
      .put(`/members/${memberIdInA}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ name: 'Hacked' });

    expect(res.status).toBe(404);
  });

  it('returns 404 when deleting a gym-A member with gym-B credentials', async () => {
    const res = await request
      .delete(`/members/${memberIdInA}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);

    expect(res.status).toBe(404);
  });

  it('list only returns members belonging to the requesting gym', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);

    expect(res.status).toBe(200);
    const ids: number[] = res.body.map((m: any) => m.id);
    expect(ids).not.toContain(memberIdInA);
  });
});
