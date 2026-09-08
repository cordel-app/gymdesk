// Tests for storage.ts router (POST /storage/uploads/exercise-image, #417 stage 2;
// POST /storage/uploads/nutrition-image, #417 stage 3)

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// The real @aws-sdk/client-s3 must never hit the network in tests — mock the
// whole module the same way infra/storage.test.ts (unit tests) does.
const sendMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

const R2_ENV_KEYS = [
  'CLOUDFLARE_R2_ENDPOINT',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_BUCKET',
] as const;

const R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
const R2_BUCKET = 'test-bucket';

// Snapshot whatever was in the environment before this file ran so it can be
// restored exactly — this file must not leak R2 env state into other tests.
const originalEnv: Record<string, string | undefined> = {};
for (const key of R2_ENV_KEYS) originalEnv[key] = process.env[key];

function setStorageConfigured() {
  process.env.CLOUDFLARE_R2_ENDPOINT = R2_ENDPOINT;
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUDFLARE_R2_BUCKET = R2_BUCKET;
}

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Storage Uploads Gym');
  await createTestMembership(gymId, 'admin');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`${gymId}-StorageUploadsGym`, gymId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  for (const key of R2_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await db.end();
});

beforeEach(() => {
  setStorageConfigured();
  sendMock.mockClear();
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

function uploadTo(id: string) {
  return request
    .post('/storage/uploads/exercise-image')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', id);
}

// ─── Auth guard ─────────────────────────────────────────────────────────────

describe('Auth guard', () => {
  it('returns 401 without auth', async () => {
    setStorageConfigured();
    const res = await request
      .post('/storage/uploads/exercise-image')
      .set('x-gym-id', gymId)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-png-bytes'));
    expect(res.status).toBe(401);
  });
});

// ─── Tenant isolation ───────────────────────────────────────────────────────

describe('Tenant isolation', () => {
  it('returns 403 when the caller has no membership in this gym', async () => {
    setStorageConfigured();
    const otherId = await createTestGym('Storage Uploads Other Gym');
    const res = await uploadTo(otherId)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-png-bytes'));
    expect(res.status).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

// ─── Role guard ─────────────────────────────────────────────────────────────

describe('Role guard', () => {
  it('returns 403 for front_desk role (TRAINING module is read-only, requireModuleWrite blocks)', async () => {
    setStorageConfigured();
    const frontDeskGym = await createTestGym('Storage Uploads FrontDesk Gym');
    await createTestMembership(frontDeskGym, 'front_desk');

    const res = await uploadTo(frontDeskGym)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-png-bytes'));
    expect(res.status).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

// ─── Request validation ─────────────────────────────────────────────────────

describe('Request validation', () => {
  it('returns 415 for an unsupported content type', async () => {
    const res = await uploadTo(gymId)
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('not-an-image'));
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/Unsupported image type/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the request body is empty', async () => {
    const res = await uploadTo(gymId)
      .set('Content-Type', 'image/png')
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Request body is empty' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns 413 when the body exceeds the 5MB limit', async () => {
    const oversized = Buffer.alloc(IMAGE_MAX_BYTES + 1024, 1);
    const res = await uploadTo(gymId)
      .set('Content-Type', 'image/png')
      .send(oversized);
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/5MB limit/);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

// ─── Storage not configured ─────────────────────────────────────────────────

describe('Storage not configured', () => {
  it('returns 503 when Cloudflare R2 env vars are not fully set', async () => {
    delete process.env.CLOUDFLARE_R2_BUCKET; // isStorageConfigured() -> false
    const res = await uploadTo(gymId)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-png-bytes'));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Cloudflare storage has not been configured for this deployment' });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

// ─── Storage not initialized for this gym ───────────────────────────────────

describe('Storage not initialized for this gym', () => {
  it('returns 409 when the gym has no storage_folder_prefix', async () => {
    const uninitGym = await createTestGym('Storage Uploads Uninitialized Gym');
    await createTestMembership(uninitGym, 'admin');
    // storage_folder_prefix is left null (never ran the stage-1 initialize endpoint).

    const res = await uploadTo(uninitGym)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-png-bytes'));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Cloudflare storage has not been initialized for this gym, therefore images cannot be uploaded.',
    });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

// ─── S3 upload failure ───────────────────────────────────────────────────────

describe('Upload failure', () => {
  it('returns 502 when the S3 PutObject call throws', async () => {
    sendMock.mockRejectedValueOnce(new Error('R2 network timeout'));
    const res = await uploadTo(gymId)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-png-bytes'));
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Failed to upload image/);
    expect(res.body.error).toMatch(/R2 network timeout/);
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('Happy path', () => {
  it('returns 201 with the uploaded image URL, scoped to the calling gym\'s folder prefix', async () => {
    const res = await uploadTo(gymId)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-png-bytes'));
    expect(res.status).toBe(201);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const expectedPrefix = `${gymId}-StorageUploadsGym`;
    const expectedBase = `${R2_ENDPOINT}/${R2_BUCKET}/${expectedPrefix}/Exercises/Images/`;
    expect(res.body.url.startsWith(expectedBase)).toBe(true);
    expect(res.body.url.slice(expectedBase.length)).toMatch(/^[0-9a-f-]{36}\.png$/);

    const sentInput = sendMock.mock.calls[0][0].input;
    expect(sentInput.Bucket).toBe(R2_BUCKET);
    expect(sentInput.ContentType).toBe('image/png');
    expect(sentInput.Key).toBe(res.body.url.slice(`${R2_ENDPOINT}/${R2_BUCKET}/`.length));
  });

  it('maps other allowed mime types to the expected extension', async () => {
    const res = await uploadTo(gymId)
      .set('Content-Type', 'image/webp')
      .send(Buffer.from('fake-webp-bytes'));
    expect(res.status).toBe(201);
    expect(res.body.url.endsWith('.webp')).toBe(true);
  });

  it('scopes the uploaded URL to gym B\'s own folder prefix, never gym A\'s (cross-gym isolation)', async () => {
    const gymB = await createTestGym('Storage Uploads GymB');
    await createTestMembership(gymB, 'admin');
    const gymBPrefix = `${gymB}-StorageUploadsGymB`;
    await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymBPrefix, gymB]);

    const resA = await uploadTo(gymId)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-png-bytes-a'));
    expect(resA.status).toBe(201);
    expect(resA.body.url).toContain(`/${gymId}-StorageUploadsGym/`);
    expect(resA.body.url).not.toContain(gymBPrefix);

    const resB = await uploadTo(gymB)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-png-bytes-b'));
    expect(resB.status).toBe(201);
    expect(resB.body.url).toContain(`/${gymBPrefix}/`);
    expect(resB.body.url).not.toContain(`${gymId}-StorageUploadsGym/`);
  });
});

// ─── #417 stage 3: POST /storage/uploads/nutrition-image ────────────────────
// Shares handleImageUpload() with exercise-image (validation/503/409/502 all
// already covered above) — this route only needs its own guard + folder path.

function uploadNutritionImageTo(id: string) {
  return request
    .post('/storage/uploads/nutrition-image')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', id);
}

describe('POST /storage/uploads/nutrition-image', () => {
  it('returns 401 without auth', async () => {
    setStorageConfigured();
    const res = await request
      .post('/storage/uploads/nutrition-image')
      .set('x-gym-id', gymId)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-png-bytes'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for accountant role (NUTRITION module is NONE for accountant)', async () => {
    setStorageConfigured();
    const accountantGym = await createTestGym('Storage Uploads Accountant Gym');
    await createTestMembership(accountantGym, 'accountant');

    const res = await uploadNutritionImageTo(accountantGym)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-png-bytes'));
    expect(res.status).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns 403 for front_desk role (NUTRITION module is read-only, requireModuleWrite blocks)', async () => {
    setStorageConfigured();
    const frontDeskGym = await createTestGym('Storage Uploads Nutrition FrontDesk Gym');
    await createTestMembership(frontDeskGym, 'front_desk');

    const res = await uploadNutritionImageTo(frontDeskGym)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-png-bytes'));
    expect(res.status).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns 201 with the uploaded image URL under the Nutrition/Images folder', async () => {
    const res = await uploadNutritionImageTo(gymId)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-png-bytes'));
    expect(res.status).toBe(201);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const expectedBase = `${R2_ENDPOINT}/${R2_BUCKET}/${gymId}-StorageUploadsGym/Nutrition/Images/`;
    expect(res.body.url.startsWith(expectedBase)).toBe(true);
    expect(res.body.url.slice(expectedBase.length)).toMatch(/^[0-9a-f-]{36}\.png$/);
  });
});
