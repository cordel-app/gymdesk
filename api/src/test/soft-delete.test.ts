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

async function createCenter(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO centers (gym_id, name) VALUES (?, ?)`,
    [gymId, `Center-${Date.now()}`],
  );
  return insertId;
}

describe('Soft-delete: Members', () => {
  let gymId: string;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Soft Delete Gym');
    await createTestMembership(gymId, 'admin');
    const centerId = await createCenter(gymId);

    const { insertId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Delete Me', 'deleteme@test.com')`,
      [gymId],
    );
    memberId = insertId;
    await db.query(
      `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at) VALUES (?, ?, ?, 1, UTC_TIMESTAMP())`,
      [gymId, memberId, centerId],
    );
  });

  it('returns the member in list before deletion', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).toContain(memberId);
  });

  it('soft-deletes a member (204)', async () => {
    const res = await request
      .delete(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(204);
  });

  it('hides the deleted member from GET /members', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).not.toContain(memberId);
  });

  it('returns 404 when getting the deleted member by id', async () => {
    const res = await request
      .get(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(404);
  });

  it('shows the deleted member in GET /members/deleted', async () => {
    const res = await request
      .get('/members/deleted')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).toContain(memberId);
  });

  it('restores the soft-deleted member', async () => {
    const res = await request
      .post(`/members/${memberId}/restore`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    expect(res.body.deleted_at).toBeNull();
  });

  it('returns the restored member in GET /members', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).toContain(memberId);
  });
});
