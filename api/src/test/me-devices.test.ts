// Tests for me.ts router — push device tokens (#1072, mobile app WP1)
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { DEFAULT_APP_ID } from '../domain/deviceTokens';
import { sendNotification } from '../infra/notifications';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  eventually,
  request,
} from './helpers';

let gymId: string;
let memberId: number;
let otherMemberId: number;

beforeAll(async () => {
  gymId = await createTestGym('Me Devices Gym');

  // Every route here is requireRole('member') — an exact role check, so an
  // 'admin' membership would 403 on all of them.
  await createTestMembership(gymId, 'member');

  // clerk_user_id is globally unique in members, so a stale row from a crashed
  // previous run would break the INSERT: upsert into the current test gym.
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id)
     VALUES (?, 'Device Member', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, `me-devices-${Date.now()}@test.com`, TEST_USER_ID],
  );
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM members WHERE clerk_user_id = ?',
    [TEST_USER_ID],
  );
  memberId = rows[0].id;

  // A second member of the same gym, for the cross-member rules below. No
  // Clerk user: nothing authenticates as them, which is the point.
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Other Member', ?)`,
    [gymId, `me-devices-other-${Date.now()}@test.com`],
  );
  otherMemberId = insertId;
});

afterEach(async () => {
  await db.query('DELETE FROM member_device_tokens WHERE gym_id = ?', [gymId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const post = (body: unknown) => request
  .post('/me/devices')
  .set('Authorization', TEST_AUTH_HEADER)
  .set('x-gym-id', gymId)
  .send(body as any);

// ---------------------------------------------------------------------------
// POST /me/devices
// ---------------------------------------------------------------------------

describe('POST /me/devices', () => {
  it('returns 401 without auth', async () => {
    const res = await request.post('/me/devices').set('x-gym-id', gymId)
      .send({ platform: 'ios', token: 'tok-unauth' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-member role', async () => {
    const adminGym = await createTestGym('Me Devices Admin Gym');
    await createTestMembership(adminGym, 'admin');
    const res = await request
      .post('/me/devices')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', adminGym)
      .send({ platform: 'ios', token: 'tok-admin' });
    expect(res.status).toBe(403);
  });

  it('registers a device', async () => {
    const res = await post({ platform: 'ios', token: 'tok-1' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ platform: 'ios', app_id: DEFAULT_APP_ID });
    expect(res.body.id).toBeGreaterThan(0);
    // The token is not echoed — the caller already has it.
    expect(res.body.token).toBeUndefined();

    const { rows } = await db.query<{ member_id: number; gym_id: string; token: string }>(
      'SELECT member_id, gym_id, token FROM member_device_tokens WHERE platform = ? AND token = ?',
      ['ios', 'tok-1'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ member_id: memberId, gym_id: gymId, token: 'tok-1' });
  });

  it('is idempotent: the same token stays one row and refreshes last_seen_at', async () => {
    const first = await post({ platform: 'android', token: 'tok-2' });
    expect(first.status).toBe(201);
    await db.query(
      `UPDATE member_device_tokens SET last_seen_at = '2020-01-01 00:00:00'
        WHERE platform = 'android' AND token = 'tok-2'`,
    );

    const second = await post({ platform: 'android', token: 'tok-2' });
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);

    const { rows } = await db.query<{ cnt: number; last_seen_at: Date }>(
      `SELECT COUNT(*) AS cnt, MAX(last_seen_at) AS last_seen_at
         FROM member_device_tokens WHERE platform = 'android' AND token = 'tok-2'`,
    );
    expect(Number(rows[0].cnt)).toBe(1);
    expect(new Date(rows[0].last_seen_at).getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('keeps the app id the request names, and separates platforms', async () => {
    const ios = await post({ platform: 'ios', token: 'tok-3', app_id: 'com.gym.alpha' });
    expect(ios.body.app_id).toBe('com.gym.alpha');
    // The unique key is (platform, token): the same string on the other
    // platform is a different device.
    const android = await post({ platform: 'android', token: 'tok-3' });
    expect(android.body.id).not.toBe(ios.body.id);

    const { rows } = await db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM member_device_tokens WHERE token = 'tok-3'`,
    );
    expect(Number(rows[0].cnt)).toBe(2);
  });

  it('takes a shared device over rather than duplicating it', async () => {
    // The token identifies an app installation, so the member who signed in
    // last owns it — otherwise the previous member keeps getting alerts on a
    // phone that is no longer theirs (migration 221).
    await db.query(
      `INSERT INTO member_device_tokens (gym_id, member_id, platform, token)
       VALUES (?, ?, 'ios', 'tok-shared')`,
      [gymId, otherMemberId],
    );
    const res = await post({ platform: 'ios', token: 'tok-shared' });
    expect(res.status).toBe(201);

    const { rows } = await db.query<{ member_id: number }>(
      `SELECT member_id FROM member_device_tokens WHERE platform = 'ios' AND token = 'tok-shared'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].member_id).toBe(memberId);
  });

  it('refuses an unknown platform, a missing token and a non-string app id', async () => {
    for (const body of [
      { platform: 'web', token: 'tok-bad' },
      { platform: 'ios' },
      { platform: 'ios', token: '   ' },
      { platform: 'ios', token: 'tok-bad', app_id: 5 },
      {},
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    }
    const { rows } = await db.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM member_device_tokens WHERE gym_id = ?',
      [gymId],
    );
    expect(Number(rows[0].cnt)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DELETE /me/devices/:token
// ---------------------------------------------------------------------------

describe('DELETE /me/devices/:token', () => {
  const del = (token: string, gym = gymId) => request
    .delete(`/me/devices/${token}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gym);

  it('returns 401 without auth', async () => {
    const res = await request.delete('/me/devices/tok-x').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('removes the member\'s own token', async () => {
    await post({ platform: 'ios', token: 'tok-del' });
    const res = await del('tok-del');
    expect(res.status).toBe(204);
    const { rows } = await db.query(
      `SELECT id FROM member_device_tokens WHERE token = 'tok-del'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('returns 404 for an unknown token', async () => {
    const res = await del('tok-nope');
    expect(res.status).toBe(404);
  });

  it('will not delete another member\'s token', async () => {
    await db.query(
      `INSERT INTO member_device_tokens (gym_id, member_id, platform, token)
       VALUES (?, ?, 'ios', 'tok-theirs')`,
      [gymId, otherMemberId],
    );
    const res = await del('tok-theirs');
    expect(res.status).toBe(404);
    const { rows } = await db.query(
      `SELECT id FROM member_device_tokens WHERE token = 'tok-theirs'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('will not delete a token of another gym', async () => {
    // Tenant isolation: the same authenticated user is a member of this gym
    // only, so a token registered here is invisible from another gym's context.
    await post({ platform: 'ios', token: 'tok-tenant' });
    const otherGym = await createTestGym('Me Devices Other Gym');
    await createTestMembership(otherGym, 'member');
    const res = await del('tok-tenant', otherGym);
    expect([403, 404]).toContain(res.status);
    const { rows } = await db.query(
      `SELECT id FROM member_device_tokens WHERE token = 'tok-tenant'`,
    );
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Delivery is a courtesy copy of the notification, never a condition of it
// ---------------------------------------------------------------------------

describe('a failing FCM call never breaks the notification', () => {
  const ORIGINAL = process.env.FCM_SERVICE_ACCOUNTS;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.FCM_SERVICE_ACCOUNTS;
    else process.env.FCM_SERVICE_ACCOUNTS = ORIGINAL;
  });

  it('writes the row and keeps the token when the send cannot even be signed', async () => {
    // Credentials that parse and whose private key the crypto layer refuses, so
    // the attempt fails before any network call: the point is the *row*, which
    // is the durable half of a notification.
    process.env.FCM_SERVICE_ACCOUNTS = JSON.stringify({
      [DEFAULT_APP_ID]: {
        project_id: 'cordel-test',
        client_email: 'push@cordel-test.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n',
      },
    });
    await post({ platform: 'ios', token: 'tok-push' });

    sendNotification(gymId, memberId, 'booking_confirmed', 'session', 1, { title: 'Yoga' });

    const rows = await eventually(
      async () => {
        const { rows } = await db.query<{ id: number }>(
          `SELECT id FROM member_notifications
            WHERE gym_id = ? AND member_id = ? AND type = 'booking_confirmed'`,
          [gymId, memberId],
        );
        return rows;
      },
      (r) => r.length > 0,
    );
    expect(rows.length).toBeGreaterThan(0);

    const { rows: tokens } = await db.query(
      `SELECT id FROM member_device_tokens WHERE token = 'tok-push'`,
    );
    expect(tokens).toHaveLength(1);

    await db.query('DELETE FROM member_notifications WHERE gym_id = ?', [gymId]);
  });
});
