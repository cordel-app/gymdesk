// Tests for the member-centers router (mounted at /members/:memberId/centers).
//
// #797 added the read side's sole-active-center fallback: the read-only PROFILE
// section of the expanded Member row and the Edit form both read this route, so
// "which centers is this Member in" is answered here once rather than in either
// caller. An empty `member_centers` list is not the same statement as "no
// center" when the gym has exactly one active center.

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

async function createMember(gymId: string, name = 'Center Member'): Promise<number> {
  const email = `member-centers-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, email],
  );
  return insertId as number;
}

async function createCenter(gymId: string, name: string, status: 'active' | 'inactive' = 'active'): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)',
    [gymId, name, status],
  );
  return insertId as number;
}

async function assignCenter(gymId: string, memberId: number, centerId: number, isDefault: boolean) {
  await db.query(
    `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at)
     VALUES (?, ?, ?, ?, UTC_TIMESTAMP())`,
    [gymId, memberId, centerId, isDefault],
  );
}

describe('GET /members/:memberId/centers', () => {
  let singleCenterGymId: string;
  let multiCenterGymId: string;
  let otherGymId: string;
  let soleCenterId: number;
  let mainCenterId: number;
  let secondCenterId: number;

  beforeAll(async () => {
    singleCenterGymId = await createTestGym('Member Centers Gym — one center');
    multiCenterGymId = await createTestGym('Member Centers Gym — two centers');
    otherGymId = await createTestGym('Member Centers Gym — other tenant');
    await createTestMembership(singleCenterGymId);
    await createTestMembership(multiCenterGymId);
    await createTestMembership(otherGymId);

    soleCenterId = await createCenter(singleCenterGymId, 'Q Sport Centro');
    // An inactive center must not defeat the fallback: soleActiveCenterId()
    // counts active centers only, as POST /members already does.
    await createCenter(singleCenterGymId, 'Closed Center', 'inactive');

    mainCenterId = await createCenter(multiCenterGymId, 'Q Sport Centro');
    secondCenterId = await createCenter(multiCenterGymId, 'QSport Parc Vallès');
  });

  it('returns the assigned centers, the default one first', async () => {
    const memberId = await createMember(multiCenterGymId);
    await assignCenter(multiCenterGymId, memberId, mainCenterId, false);
    await assignCenter(multiCenterGymId, memberId, secondCenterId, true);

    const res = await request
      .get(`/members/${memberId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', multiCenterGymId);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ center_id: secondCenterId, name: 'QSport Parc Vallès', is_default: 1 });
    expect(res.body[1]).toMatchObject({ center_id: mainCenterId, is_default: 0 });
  });

  it('ignores a soft-deleted assignment', async () => {
    const memberId = await createMember(multiCenterGymId);
    await assignCenter(multiCenterGymId, memberId, mainCenterId, true);
    await assignCenter(multiCenterGymId, memberId, secondCenterId, false);
    await db.query(
      'UPDATE member_centers SET deleted_at = UTC_TIMESTAMP() WHERE member_id = ? AND center_id = ?',
      [memberId, secondCenterId],
    );

    const res = await request
      .get(`/members/${memberId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', multiCenterGymId);

    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.center_id)).toEqual([mainCenterId]);
  });

  it('falls back to the gym\'s sole active center when nothing is assigned (#797)', async () => {
    const memberId = await createMember(singleCenterGymId);

    const res = await request
      .get(`/members/${memberId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', singleCenterGymId);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      center_id: soleCenterId,
      name: 'Q Sport Centro',
      is_default: 1,
      // Nothing was ever assigned, so there is no assignment date to report.
      assigned_at: null,
    });
  });

  it('does not invent a center for a gym with several active centers (#797)', async () => {
    const memberId = await createMember(multiCenterGymId);

    const res = await request
      .get(`/members/${memberId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', multiCenterGymId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns the real assignment rather than the fallback in a single-center gym', async () => {
    const memberId = await createMember(singleCenterGymId);
    await assignCenter(singleCenterGymId, memberId, soleCenterId, true);

    const res = await request
      .get(`/members/${memberId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', singleCenterGymId);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].center_id).toBe(soleCenterId);
    expect(res.body[0].assigned_at).not.toBeNull();
  });

  it('404s for another gym\'s member instead of reading back the caller\'s sole center', async () => {
    const memberId = await createMember(otherGymId);

    const res = await request
      .get(`/members/${memberId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', singleCenterGymId);

    expect(res.status).toBe(404);
  });

  it('404s for a soft-deleted member', async () => {
    const memberId = await createMember(singleCenterGymId);
    await db.query('UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [memberId]);

    const res = await request
      .get(`/members/${memberId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', singleCenterGymId);

    expect(res.status).toBe(404);
  });

  it('401s without authentication', async () => {
    const memberId = await createMember(singleCenterGymId);

    const res = await request.get(`/members/${memberId}/centers`).set('x-gym-id', singleCenterGymId);

    expect(res.status).toBe(401);
  });

  it('is readable by a read-only role — viewing a Member is not a write (#797)', async () => {
    const memberId = await createMember(singleCenterGymId);
    const readOnlyUserId = `read-only-${Date.now()}`;
    await createTestMembership(singleCenterGymId, 'accountant', readOnlyUserId);

    const res = await request
      .get(`/members/${memberId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', singleCenterGymId);

    expect(res.status).toBe(200);
  });
});
