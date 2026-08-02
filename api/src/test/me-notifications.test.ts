// Tests for me.ts router — notification endpoints (#194)
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
let memberId: number;

/**
 * Insert a member_notifications row and return its auto-increment id.
 * Pass readAt as a datetime string to pre-mark the notification as read,
 * or leave it null for an unread row.
 */
async function insertNotification(
  gid: string,
  mid: number,
  readAt: string | null = null,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO member_notifications (gym_id, member_id, type, entity_type, entity_id, payload, read_at)
     VALUES (?, ?, 'booking_confirmed', 'session', 1,
             '{"title":"Yoga","starts_at":"2026-09-01T10:00:00.000Z"}', ?)`,
    [gid, mid, readAt],
  );
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('Me Notifications Gym');

  // meRouter endpoints use requireRole('member') — an exact role check.
  // An 'admin' membership would hit a 403 on every route in this file.
  await createTestMembership(gymId, 'member');

  // requireMemberId() resolves members.id via clerk_user_id. clerk_user_id is
  // globally unique in members, so a stale row from a crashed previous run would
  // break the INSERT. Upsert into the current test gym to handle that case.
  const email = `me-notif-${Date.now()}@test.com`;
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id)
     VALUES (?, 'Test Member', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, email, TEST_USER_ID],
  );
  const { rows: mRows } = await db.query<{ id: number }>(
    'SELECT id FROM members WHERE clerk_user_id = ?',
    [TEST_USER_ID],
  );
  memberId = mRows[0].id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ---------------------------------------------------------------------------
// GET /me/notifications
// ---------------------------------------------------------------------------

describe('GET /me/notifications', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/me/notifications').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in this gym', async () => {
    const otherId = await createTestGym('Other Gym');
    const res = await request
      .get('/me/notifications')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherId);
    expect(res.status).toBe(403);
  });

  it('returns 403 when user has a non-member gym role', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'admin-user-test' } as any);
    const roleGymId = await createTestGym('Role Guard Gym');
    await createTestMembership(roleGymId, 'admin', 'admin-user-test');
    const res = await request
      .get('/me/notifications')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', roleGymId);
    expect(res.status).toBe(403);
  });

  it('returns 200 with { items, unread } shape', async () => {
    await insertNotification(gymId, memberId); // unread
    const res = await request
      .get('/me/notifications')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.unread).toBe('number');
    expect(res.body.unread).toBeGreaterThanOrEqual(1);

    // Each item must carry the fields the client needs for rendering
    const item = res.body.items[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('type');
    expect(item).toHaveProperty('entity_type');
    expect(item).toHaveProperty('read_at');
    expect(item).toHaveProperty('created_at');
  });

  it('returns notifications ordered newest first', async () => {
    await insertNotification(gymId, memberId);
    const res = await request
      .get('/me/notifications')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ created_at: string }>;
    for (let i = 1; i < items.length; i++) {
      const prev = new Date(items[i - 1].created_at).getTime();
      const curr = new Date(items[i].created_at).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /me/notifications/count
// ---------------------------------------------------------------------------

describe('GET /me/notifications/count', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/me/notifications/count').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 200 with { unread: N }', async () => {
    const res = await request
      .get('/me/notifications/count')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(typeof res.body.unread).toBe('number');
  });

  it('unread count matches the actual unread rows in the database', async () => {
    // One unread + one pre-read so both paths are exercised
    await insertNotification(gymId, memberId, null);
    await insertNotification(gymId, memberId, '2026-01-01 09:00:00');

    const res = await request
      .get('/me/notifications/count')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);

    const { rows } = await db.query(
      'SELECT COUNT(*) AS unread FROM member_notifications WHERE gym_id = ? AND member_id = ? AND read_at IS NULL',
      [gymId, memberId],
    );
    expect(res.body.unread).toBe(Number(rows[0].unread));
  });
});

// ---------------------------------------------------------------------------
// PUT /me/notifications/:id/read
// ---------------------------------------------------------------------------

describe('PUT /me/notifications/:id/read', () => {
  it('returns 401 without auth', async () => {
    const res = await request.put('/me/notifications/1/read').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 204 and marks the notification read', async () => {
    const notifId = await insertNotification(gymId, memberId, null);
    const res = await request
      .put(`/me/notifications/${notifId}/read`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);

    // Verify the row now has a non-null read_at
    const { rows } = await db.query(
      'SELECT read_at FROM member_notifications WHERE id = ?',
      [notifId],
    );
    expect(rows[0].read_at).not.toBeNull();
  });

  it('returns 404 when the notification is already read', async () => {
    const notifId = await insertNotification(gymId, memberId, '2026-01-01 09:00:00');
    const res = await request
      .put(`/me/notifications/${notifId}/read`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent notification id', async () => {
    const res = await request
      .put('/me/notifications/999999999/read')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT /me/notifications/read-all
// ---------------------------------------------------------------------------

describe('PUT /me/notifications/read-all', () => {
  it('returns 401 without auth', async () => {
    const res = await request.put('/me/notifications/read-all').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('marks all unread notifications read and returns { updated: N }', async () => {
    // Reset any leftover unread state from earlier tests, then add exactly two
    await db.query(
      'UPDATE member_notifications SET read_at = UTC_TIMESTAMP() WHERE gym_id = ? AND member_id = ? AND read_at IS NULL',
      [gymId, memberId],
    );
    await insertNotification(gymId, memberId, null);
    await insertNotification(gymId, memberId, null);

    const res = await request
      .put('/me/notifications/read-all')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    // Nothing should remain unread
    const { rows } = await db.query(
      'SELECT COUNT(*) AS unread FROM member_notifications WHERE gym_id = ? AND member_id = ? AND read_at IS NULL',
      [gymId, memberId],
    );
    expect(Number(rows[0].unread)).toBe(0);
  });

  it('returns { updated: 0 } when there are no unread notifications', async () => {
    // Guarantee everything is already read
    await db.query(
      'UPDATE member_notifications SET read_at = UTC_TIMESTAMP() WHERE gym_id = ? AND member_id = ? AND read_at IS NULL',
      [gymId, memberId],
    );

    const res = await request
      .put('/me/notifications/read-all')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
  });
});
