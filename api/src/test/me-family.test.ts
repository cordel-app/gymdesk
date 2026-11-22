// #3156: the Members App avatar menu lists the caller's Family. `GET /me/family`
// answers every member of the caller's family (the caller included), owner first,
// with each one's photo pair and an owner flag; nobody outside it, never another
// gym's members, and never a member named by the request.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestFamily, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let otherGymId: string;
const stamp = Date.now();
const OWNER = `me-family-owner-${stamp}`;
const CHILD = `me-family-child-${stamp}`;
const STRANGER = `me-family-stranger-${stamp}`;
const STAFF = `me-family-staff-${stamp}`;
let owner: number;
let child: number;
let sibling: number;

function as(clerk: string, gym = () => gymId) {
  vi.mocked(verifyToken).mockResolvedValue({ sub: clerk } as any);
  return request.get('/me/family').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym());
}

async function member(gym: string, name: string, clerk: string | null, image: string | null = null): Promise<number> {
  if (clerk) await createTestMembership(gym, 'member', clerk);
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id, image_url, image_thumbnail_url) VALUES (?, ?, ?, ?, ?, ?)',
    [gym, name, `${clerk ?? name}-${stamp}@test.com`, clerk, image, image ? image.replace('.webp', '-thumbnail.webp') : null]);
  return insertId as number;
}

beforeAll(async () => {
  gymId = await createTestGym('Me Family Gym');
  otherGymId = await createTestGym('Me Family Other Gym');
  owner = await member(gymId, 'Zoe Owner', OWNER, 'https://cdn.test/members/zoe.webp');
  child = await member(gymId, 'Bruno Child', CHILD);
  sibling = await member(gymId, 'Anna Sibling', null);
  await member(gymId, 'Stranger', STRANGER);
  await createTestFamily(gymId, owner, [child, sibling]);
  await createTestMembership(gymId, 'admin', STAFF);
});

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('GET /me/family (#3156)', () => {
  it('lists the family, owner first then alphabetically, with photos and the owner flag', async () => {
    const res = await as(CHILD);
    expect(res.status).toBe(200);
    expect(res.body.member_id).toBe(child);
    expect(res.body.members.map((m: any) => m.member_id)).toEqual([owner, sibling, child]);
    const [first, second] = res.body.members;
    expect(first).toMatchObject({
      name: 'Zoe Owner', is_owner: true,
      image_url: 'https://cdn.test/members/zoe.webp',
      image_thumbnail_url: 'https://cdn.test/members/zoe-thumbnail.webp',
    });
    expect(second).toMatchObject({ name: 'Anna Sibling', is_owner: false, image_url: null, image_thumbnail_url: null });
  });

  it('answers the owner the same family', async () => {
    const res = await as(OWNER);
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: any) => m.member_id)).toEqual([owner, sibling, child]);
  });

  it('leaves out a soft-deleted family member', async () => {
    await db.query('UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [sibling]);
    try {
      const res = await as(CHILD);
      expect(res.body.members.map((m: any) => m.member_id)).toEqual([owner, child]);
    } finally {
      await db.query('UPDATE members SET deleted_at = NULL WHERE id = ?', [sibling]);
    }
  });

  it('never lists a member outside the caller\'s family', async () => {
    const res = await as(STRANGER);
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: any) => m.member_id)).not.toContain(owner);
  });

  it('is the member\'s own read: staff are refused', async () => {
    const res = await as(STAFF);
    expect(res.status).toBe(403);
  });

  it('is tenant-scoped: the member has no access in another gym', async () => {
    const res = await as(CHILD, () => otherGymId);
    expect([403, 404]).toContain(res.status);
  });

  it('requires authentication', async () => {
    const res = await request.get('/me/family').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});
