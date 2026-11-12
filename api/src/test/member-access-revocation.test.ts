// #2681: a Member whose stored Access Rights are `revoked` cannot use the
// Members App API; granting access back restores the same account.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const staffUser = 'access-revocation-admin';

describe('Members App access when Access Rights are revoked', () => {
  let gymId: string;
  let gymName: string;
  let memberId: number;
  // TEST_USER_ID is the member; the staff admin is a second Clerk user.
  const asMember = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });

  beforeAll(async () => {
    gymName = `Revocation Gym ${Date.now()}`;
    gymId = await createTestGym(gymName);
    await createTestMembership(gymId, 'member');
    await createTestMembership(gymId, 'admin', staffUser);
    const { insertId } = await db.query(
      `INSERT INTO members (gym_id, name, email, clerk_user_id, preferred_locale) VALUES (?, 'Revoked Member', ?, 'test-user-id', 'ca')`,
      [gymId, `revoked-${Date.now()}@test.com`],
    );
    memberId = insertId as number;
  });

  async function setAccess(value: 'granted' | 'revoked') {
    await db.query('UPDATE members SET access_rights = ? WHERE id = ?', [value, memberId]);
  }

  it('a granted member uses the app normally', async () => {
    const res = await request.get('/me/profile').set(asMember());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(memberId);
  });

  it('a revoked member is refused on every Members App route, with the gym name and their language', async () => {
    await setAccess('revoked');
    for (const path of ['/me/profile', '/me/bookings', '/me/membership', '/me/notifications/count', '/me/personal-goals']) {
      const res = await request.get(path).set(asMember());
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe('member_access_revoked');
      expect(res.body.gym_name, path).toBe(gymName);
      expect(res.body.preferred_locale, path).toBe('ca');
    }
    const write = await request.patch('/me/profile').set(asMember()).send({ phone: '600000000' });
    expect(write.status).toBe(403);
  });

  it('a revocation applies to the very next request of a session already open', async () => {
    await setAccess('granted');
    expect((await request.get('/me/profile').set(asMember())).status).toBe(200);
    await setAccess('revoked');
    expect((await request.get('/me/profile').set(asMember())).status).toBe(403);
  });

  it('removing the device push token is still allowed, so sign-out can clean up', async () => {
    await setAccess('revoked');
    const res = await request.delete('/me/devices/some-token').set(asMember());
    expect(res.status).not.toBe(403);
  });

  it('an unsupported stored language is reported as no preference', async () => {
    await setAccess('revoked');
    await db.query("UPDATE members SET preferred_locale = 'xx' WHERE id = ?", [memberId]);
    const res = await request.get('/me/profile').set(asMember());
    expect(res.status).toBe(403);
    expect(res.body.preferred_locale).toBeNull();
    await db.query("UPDATE members SET preferred_locale = 'ca' WHERE id = ?", [memberId]);
  });

  it('staff are not affected and revoking leaves the member data intact', async () => {
    await setAccess('revoked');
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: staffUser } as any);
    const res = await request.get(`/members/${memberId}`).set(asMember());
    expect(res.status).toBe(200);
    expect(res.body.access_rights).toBe('revoked');
    const { rows } = await db.query('SELECT clerk_user_id, deleted_at FROM members WHERE id = ?', [memberId]);
    expect(rows[0].clerk_user_id).toBe('test-user-id');
    expect(rows[0].deleted_at).toBeNull();
  });

  it('granting access back restores the existing account', async () => {
    await setAccess('revoked');
    expect((await request.get('/me/profile').set(asMember())).status).toBe(403);
    await setAccess('granted');
    const res = await request.get('/me/profile').set(asMember());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(memberId);
  });

  it('to_be_reviewed (a payment problem on a granted member) does not block', async () => {
    await setAccess('granted');
    await db.query(
      `INSERT INTO payment_requests (gym_id, member_id, amount, status, source) VALUES (?, ?, 10.00, 'failed', 'staff')`,
      [gymId, memberId],
    ).catch(() => undefined);
    const res = await request.get('/me/profile').set(asMember());
    expect(res.status).toBe(200);
  });
});
