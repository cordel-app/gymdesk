// #1375 — the Member's own profile image: `POST`/`DELETE /me/profile/image`.
//
// The staff pair (#1374, member-images.test.ts) made self-service. What this
// file pins is what is the member path's own: the caller is never named by the
// request, the guard is the Profile page's, the answer is `GET /me/profile`'s
// shape, and the photo lands on the very key the staff path writes.
//
// Mocks @aws-sdk/client-s3 and moves the CLOUDFLARE_R2_* env around, so it is
// separate from me.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { encodePngRgba } from '../domain/pngImage';
import { MEMBER_IMAGE_SIZE } from '../domain/memberImages';
import { invalidateFeatureFlagsCache } from '../infra/featureFlags';

const sendMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'put', input })),
  GetObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'get', input })),
  DeleteObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'delete', input })),
  CopyObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'copy', input })),
}));

const R2_ENV_KEYS = ['CLOUDFLARE_R2_ENDPOINT', 'CLOUDFLARE_R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_R2_BUCKET'] as const;
const R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
const R2_BUCKET = 'test-bucket';
const originalEnv: Record<string, string | undefined> = {};
for (const key of R2_ENV_KEYS) originalEnv[key] = process.env[key];

function setStorageConfigured() {
  process.env.CLOUDFLARE_R2_ENDPOINT = R2_ENDPOINT;
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUDFLARE_R2_BUCKET = R2_BUCKET;
}

function validPng(): Buffer {
  return encodePngRgba(MEMBER_IMAGE_SIZE, MEMBER_IMAGE_SIZE, Buffer.alloc(MEMBER_IMAGE_SIZE * MEMBER_IMAGE_SIZE * 4, 0x40));
}
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

function sentCommands(type: 'put' | 'delete') {
  return sendMock.mock.calls.map(([command]) => command).filter((c: any) => c?.__type === type);
}
const putKeys = () => sentCommands('put').map((c: any) => c.input.Key as string).filter((k) => !k.endsWith('/'));
const deletedKeys = () => sentCommands('delete').map((c: any) => c.input.Key as string);
const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

const ROOT = '/me/profile/image';
const MEMBER_NAME = 'Me Image Ana Pérez';
const SANITIZED = 'Me-Image-Ana-Perez';
const PREFIX_SUFFIX = 'MeProfileImageGym';

let gymId: string;
let gymPrefix: string;
let memberId: number;
let otherMemberId: number;

function upload(body: Buffer, contentType = 'image/png', gid = gymId) {
  return request.post(ROOT).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid).set('Content-Type', contentType).send(body);
}
function remove(gid = gymId) {
  return request.delete(ROOT).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid).send();
}
async function imageUrlOf(id: number): Promise<string | null> {
  const { rows } = await db.query<{ image_url: string | null }>('SELECT image_url FROM members WHERE id = ?', [id]);
  return rows[0]?.image_url ?? null;
}

beforeAll(async () => {
  gymId = await createTestGym(PREFIX_SUFFIX);
  await createTestMembership(gymId, 'member');
  gymPrefix = `gyms/${gymId}-${PREFIX_SUFFIX}`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);

  // The caller's own row: `clerk_user_id` is unique across the table, so the
  // test user's one row is re-pointed at this gym (the me-personal-goals shape).
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), name = VALUES(name), email = VALUES(email), deleted_at = NULL`,
    [gymId, MEMBER_NAME, `me-image-${Date.now()}@test.local`, TEST_USER_ID],
  );
  const { rows } = await db.query<{ id: number }>('SELECT id FROM members WHERE clerk_user_id = ?', [TEST_USER_ID]);
  memberId = rows[0].id;

  // Another member of the same gym, to be named in a payload and never written.
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Me Image Somebody Else', `me-image-other-${Date.now()}@test.local`],
  );
  otherMemberId = insertId as number;
});

afterAll(async () => {
  await cleanupTestGyms();
  for (const key of R2_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await db.end();
});

beforeEach(async () => {
  setStorageConfigured();
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
  await db.query('UPDATE members SET image_url = NULL WHERE id IN (?, ?)', [memberId, otherMemberId]);
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

describe('auth and gating', () => {
  it('returns 401 without auth and uploads nothing', async () => {
    const res = await request.post(ROOT).set('x-gym-id', gymId).set('Content-Type', 'image/png').send(validPng());
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for a non-member gym role', async () => {
    const roleGymId = await createTestGym('MeImageRoleGuard');
    await createTestMembership(roleGymId, 'admin', 'me-image-admin-user');
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'me-image-admin-user' } as any);
    const res = await upload(validPng(), 'image/png', roleGymId);
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 while the Profile page is switched off (member_web.profile)', async () => {
    // The middleware reads a 30 s cache of the table, so the toggle clears it
    // both ways (feature-flag-coverage.test.ts' device).
    await db.query("UPDATE feature_flags SET enabled = 0 WHERE feature_key = 'member_web.profile'");
    invalidateFeatureFlagsCache();
    try {
      const res = await upload(validPng());
      expect(res.status).toBe(403);
      expect(putKeys()).toHaveLength(0);
    } finally {
      await db.query("UPDATE feature_flags SET enabled = 1 WHERE feature_key = 'member_web.profile'");
      invalidateFeatureFlagsCache();
    }
  });

  it('answers 404 for a caller with no member profile in the gym', async () => {
    const clerkId = `me-image-noprofile-${Date.now()}`;
    const otherGym = await createTestGym('MeImageNoProfile');
    await createTestMembership(otherGym, 'member', clerkId);
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerkId } as any);
    const res = await upload(validPng(), 'image/png', otherGym);
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });
});

describe('POST /me/profile/image', () => {
  it("stores the photo on the caller's own key — the one the staff path writes — and answers the profile", async () => {
    const res = await upload(validPng());
    expect(res.status).toBe(200);
    const key = `${gymPrefix}/members/${memberId}-${SANITIZED}.png`;
    expect(putKeys()).toEqual([key]);
    expect(await imageUrlOf(memberId)).toBe(url(key));
    // The answer is GET /me/profile's shape, not the staff row.
    expect(res.body.image_url).toBe(url(key));
    expect(res.body).toHaveProperty('preferred_locale');
    expect(res.body).toHaveProperty('fare_name');
    expect(res.body).not.toHaveProperty('is_new_member');
  });

  it('never writes the member a request names', async () => {
    const res = await request.post(`${ROOT}?member_id=${otherMemberId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .set('Content-Type', 'image/png').send(validPng());
    expect(res.status).toBe(200);
    expect(putKeys()).toEqual([`${gymPrefix}/members/${memberId}-${SANITIZED}.png`]);
    expect(await imageUrlOf(otherMemberId)).toBeNull();
  });

  it('is reported by GET /me/profile and by the staff read of the same row', async () => {
    await upload(validPng());
    const key = url(`${gymPrefix}/members/${memberId}-${SANITIZED}.png`);
    const me = await request.get('/me/profile').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(me.body.image_url).toBe(key);
    expect(me.body).toHaveProperty('modified_at');
  });

  it('refuses what the staff path refuses, from the bytes, and leaves an existing photo alone', async () => {
    const existing = url(`${gymPrefix}/members/${memberId}-${SANITIZED}.png`);
    await db.query('UPDATE members SET image_url = ? WHERE id = ?', [existing, memberId]);
    expect((await upload(validPng(), 'image/jpeg')).status).toBe(415);
    const res = await upload(JPEG_BYTES);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('not_a_png');
    expect(putKeys()).toHaveLength(0);
    expect(await imageUrlOf(memberId)).toBe(existing);
  });

  it('returns 409 for a gym whose bucket was never initialized and 503 with no R2 configuration', async () => {
    await db.query('UPDATE gyms SET storage_folder_prefix = NULL WHERE id = ?', [gymId]);
    try {
      expect((await upload(validPng())).status).toBe(409);
    } finally {
      await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);
    }
    for (const key of R2_ENV_KEYS) delete process.env[key];
    expect((await upload(validPng())).status).toBe(503);
    expect(putKeys()).toHaveLength(0);
  });

  it('overwrites its own object on a replace and answers 502 with the row untouched when R2 fails', async () => {
    const key = `${gymPrefix}/members/${memberId}-${SANITIZED}.png`;
    await db.query('UPDATE members SET image_url = ? WHERE id = ?', [url(key), memberId]);
    expect((await upload(validPng())).status).toBe(200);
    expect(putKeys()).toEqual([key]);
    expect(deletedKeys()).toHaveLength(0);

    sendMock.mockRejectedValue(new Error('R2 is down'));
    expect((await upload(validPng())).status).toBe(502);
    expect(await imageUrlOf(memberId)).toBe(url(key));
  });
});

describe('DELETE /me/profile/image', () => {
  it("clears the caller's own reference and deletes only the gym-owned object", async () => {
    const key = `${gymPrefix}/members/${memberId}-${SANITIZED}.png`;
    await db.query('UPDATE members SET image_url = ? WHERE id = ?', [url(key), memberId]);
    await db.query('UPDATE members SET image_url = ? WHERE id = ?', [url(`${gymPrefix}/members/${otherMemberId}-x.png`), otherMemberId]);
    const res = await remove();
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBeNull();
    expect(await imageUrlOf(memberId)).toBeNull();
    expect(deletedKeys()).toEqual([key]);
    expect(await imageUrlOf(otherMemberId)).not.toBeNull();
  });

  it('leaves an object that is not the gym\'s own, and is a 200 with nothing to remove', async () => {
    await db.query('UPDATE members SET image_url = ? WHERE id = ?', ['https://example.org/x.png', memberId]);
    expect((await remove()).status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
    expect(await imageUrlOf(memberId)).toBeNull();
    expect((await remove()).status).toBe(200);
  });
});
