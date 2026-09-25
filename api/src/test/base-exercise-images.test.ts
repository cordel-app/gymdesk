// #716 — images on a **Base Exercise**: the superadmin upload and remove routes
// (`POST`/`DELETE /platform/exercises/:id/image`), the references the API
// exposes, and the ownership rules that decide which R2 objects a platform
// operation may delete.
//
// Separate from platform-exercises.test.ts for the same reason
// base-nutrition-images.test.ts is separate from platform-nutrition-library.
// test.ts: this file mocks @aws-sdk/client-s3 and moves the CLOUDFLARE_R2_* env
// around.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { encodePngRgba } from '../domain/pngImage';
import {
  EXERCISE_IMAGE_MASTER_SIZE,
  EXERCISE_IMAGE_THUMBNAIL_SIZE,
} from '../domain/exerciseImages';

const sendMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'put', input })),
  GetObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'get', input })),
  DeleteObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'delete', input })),
}));

const R2_ENV_KEYS = [
  'CLOUDFLARE_R2_ENDPOINT',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_BUCKET',
] as const;

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

function png(size: number): Buffer {
  return encodePngRgba(size, size, Buffer.alloc(size * size * 4, 0x40));
}

/** A PNG whose IHDR claims `size` but declares no alpha channel. */
function opaquePng(size: number): Buffer {
  const bytes = Buffer.from(png(1));
  bytes.writeUInt32BE(size, 16);
  bytes.writeUInt32BE(size, 20);
  bytes[25] = 2;
  return bytes;
}

const MASTER = png(EXERCISE_IMAGE_MASTER_SIZE).toString('base64');
const THUMBNAIL = png(EXERCISE_IMAGE_THUMBNAIL_SIZE).toString('base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]).toString('base64');

const superadminUser = { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Test Admin' };
const regularUser = { publicMetadata: {}, fullName: 'Test User' };

function mockAsSuperadmin() {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue(superadminUser as any);
}

function mockAsNonSuperadmin() {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue(regularUser as any);
}

function sentCommands(type: 'put' | 'delete') {
  return sendMock.mock.calls.map(([command]) => command).filter((c: any) => c?.__type === type);
}

function putKeys(): string[] {
  // The folder markers `ensureStorageFolders()` writes end in `/`; the files do not.
  return sentCommands('put').map((c: any) => c.input.Key).filter((key: string) => !key.endsWith('/'));
}

function deletedKeys(): string[] {
  return sentCommands('delete').map((c: any) => c.input.Key);
}

const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

const BASE_NAME = 'Test Base Image Barbell Back Squat';
const SECOND_BASE_NAME = 'Test Base Image Cable Row, Seated';
const GYM_EXERCISE_NAME = 'Test Base Image Gym Owned Exercise';

let gymId: string;
let gymPrefix: string;
let baseExerciseId: number;
let secondBaseExerciseId: number;
let gymExerciseId: number;

async function createExercise(gym: string | null, name: string): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO exercises (gym_id, name, status) VALUES (?, ?, 'active')",
    [gym, name],
  );
  return insertId as number;
}

async function mediaOf(id: number): Promise<{ image_url: string | null; image_thumbnail_url: string | null }> {
  const { rows } = await db.query<{ image_url: string | null; image_thumbnail_url: string | null }>(
    'SELECT image_url, image_thumbnail_url FROM exercises WHERE id = ?',
    [id],
  );
  return rows[0];
}

async function setMedia(id: number, imageUrl: string | null, thumbnailUrl: string | null) {
  await db.query('UPDATE exercises SET image_url = ?, image_thumbnail_url = ? WHERE id = ?', [imageUrl, thumbnailUrl, id]);
}

function upload(id: number | string, body: unknown) {
  return request
    .post(`/platform/exercises/${id}/image`)
    .set('Authorization', TEST_AUTH_HEADER)
    .send(body as any);
}

function remove(id: number | string) {
  return request
    .delete(`/platform/exercises/${id}/image`)
    .set('Authorization', TEST_AUTH_HEADER);
}

const masterKey = (id: number, name: string) => `cordel/Exercises/Images/${id}-${name}.png`;
const thumbnailKey = (id: number, name: string) => `cordel/Exercises/Images/${id}-${name}-thumbnail.png`;

const BASE_SLUG = 'Test-Base-Image-Barbell-Back-Squat';
const SECOND_BASE_SLUG = 'Test-Base-Image-Cable-Row-Seated';

beforeAll(async () => {
  gymId = await createTestGym('BaseExerciseImagesGym');
  await createTestMembership(gymId, 'admin');
  const { rows } = await db.query<{ storage_folder_prefix: string | null }>(
    'SELECT storage_folder_prefix FROM gyms WHERE id = ?',
    [gymId],
  );
  gymPrefix = rows[0]?.storage_folder_prefix ?? `gyms/${gymId}-BaseExerciseImagesGym`;

  baseExerciseId = await createExercise(null, BASE_NAME);
  secondBaseExerciseId = await createExercise(null, SECOND_BASE_NAME);
  gymExerciseId = await createExercise(gymId, GYM_EXERCISE_NAME);
});

afterAll(async () => {
  await db.query("DELETE FROM exercises WHERE name LIKE 'Test Base Image %'");
  await cleanupTestGyms();
  for (const key of R2_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await db.end();
});

beforeEach(async () => {
  setStorageConfigured();
  mockAsSuperadmin();
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
  await db.query(
    "UPDATE exercises SET image_url = NULL, image_thumbnail_url = NULL, name = ?, status = 'active' WHERE id = ?",
    [BASE_NAME, baseExerciseId],
  );
  await db.query(
    "UPDATE exercises SET image_url = NULL, image_thumbnail_url = NULL, status = 'active' WHERE id IN (?, ?)",
    [secondBaseExerciseId, gymExerciseId],
  );
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── Auth and scope ───────────────────────────────────────────────────────────

describe('POST /platform/exercises/:id/image — auth', () => {
  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/platform/exercises/${baseExerciseId}/image`)
      .send({ image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for an authenticated non-superadmin', async () => {
    mockAsNonSuperadmin();
    const res = await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });

  it("returns 404 for a gym's own exercise — its media is the gym's router's business (§15)", async () => {
    const res = await upload(gymExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
    expect(await mediaOf(gymExerciseId)).toEqual({ image_url: null, image_thumbnail_url: null });
  });

  it('returns 404 for an unknown exercise', async () => {
    const res = await upload(99999999, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 404 for a deleted base exercise', async () => {
    await db.query("UPDATE exercises SET status = 'deleted' WHERE id = ?", [baseExerciseId]);
    const res = await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 401 without auth on DELETE, and 403 for a non-superadmin', async () => {
    const anonymous = await request.delete(`/platform/exercises/${baseExerciseId}/image`);
    expect(anonymous.status).toBe(401);
    mockAsNonSuperadmin();
    const forbidden = await remove(baseExerciseId);
    expect(forbidden.status).toBe(403);
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('POST /platform/exercises/:id/image', () => {
  it('stores both files under cordel/Exercises/Images/ and persists both URLs', async () => {
    const res = await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);

    const master = masterKey(baseExerciseId, BASE_SLUG);
    const thumb = thumbnailKey(baseExerciseId, BASE_SLUG);
    expect(putKeys()).toEqual([master, thumb]);
    for (const key of putKeys()) {
      expect(key.startsWith('cordel/')).toBe(true);
      expect(key).not.toContain('gyms/');
    }
    for (const command of sentCommands('put')) {
      if (!(command as any).input.Key.endsWith('/')) {
        expect((command as any).input).toMatchObject({ Bucket: R2_BUCKET, ContentType: 'image/png' });
      }
    }

    expect(res.body.image_url).toBe(url(master));
    expect(res.body.image_thumbnail_url).toBe(url(thumb));
    expect(await mediaOf(baseExerciseId)).toEqual({ image_url: url(master), image_thumbnail_url: url(thumb) });
  });

  it('writes the platform folder markers, never a gym tree', async () => {
    await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    const markers = sentCommands('put').map((c: any) => c.input.Key).filter((k: string) => k.endsWith('/'));
    expect(markers).toEqual(['cordel/', 'cordel/Exercises/', 'cordel/Exercises/Images/']);
  });

  it('sanitizes the exercise name in both keys (§14)', async () => {
    const res = await upload(secondBaseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(putKeys()).toEqual([
      masterKey(secondBaseExerciseId, SECOND_BASE_SLUG),
      thumbnailKey(secondBaseExerciseId, SECOND_BASE_SLUG),
    ]);
  });

  it('keeps the exercise otherwise untouched, and returns it in the list shape', async () => {
    const res = await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.body).toMatchObject({ id: baseExerciseId, name: BASE_NAME, status: 'active' });
    expect(res.body).toHaveProperty('muscles');
    expect(res.body).toHaveProperty('allowed_result_types');
  });
});

// ─── Validation (§11, §12) ────────────────────────────────────────────────────

describe('POST /platform/exercises/:id/image — validation', () => {
  beforeEach(async () => {
    // An image already there is what every rejection must leave alone.
    await setMedia(
      baseExerciseId,
      url(masterKey(baseExerciseId, BASE_SLUG)),
      url(thumbnailKey(baseExerciseId, BASE_SLUG)),
    );
  });

  async function expectRefused(body: unknown, status: number, reason?: string) {
    const before = await mediaOf(baseExerciseId);
    const res = await upload(baseExerciseId, body);
    expect(res.status).toBe(status);
    if (reason) expect(res.body.reason).toBe(reason);
    // Nothing uploaded, nothing deleted, nothing written (§11).
    expect(putKeys()).toHaveLength(0);
    expect(deletedKeys()).toHaveLength(0);
    expect(await mediaOf(baseExerciseId)).toEqual(before);
    return res;
  }

  it('refuses a request carrying only the master', async () => {
    await expectRefused({ image: MASTER }, 400);
  });

  it('refuses a request carrying only the thumbnail', async () => {
    await expectRefused({ thumbnail: THUMBNAIL }, 400);
  });

  it('refuses a non-PNG master, naming the file', async () => {
    const res = await expectRefused({ image: JPEG, thumbnail: THUMBNAIL }, 400, 'not_a_png');
    expect(res.body.file).toBe('image');
  });

  it('refuses a master that is not 2048×2048', async () => {
    const res = await expectRefused({ image: THUMBNAIL, thumbnail: THUMBNAIL }, 400, 'wrong_size');
    expect(res.body.file).toBe('image');
  });

  it('refuses a thumbnail that is not 512×512, naming the thumbnail', async () => {
    const res = await expectRefused({ image: MASTER, thumbnail: MASTER }, 400, 'wrong_size');
    expect(res.body.file).toBe('thumbnail');
  });

  it('refuses an opaque master — a transparent background is required (§2)', async () => {
    const res = await expectRefused(
      { image: opaquePng(EXERCISE_IMAGE_MASTER_SIZE).toString('base64'), thumbnail: THUMBNAIL },
      400,
      'not_transparent',
    );
    expect(res.body.file).toBe('image');
  });

  it('refuses an opaque thumbnail', async () => {
    await expectRefused(
      { image: MASTER, thumbnail: opaquePng(EXERCISE_IMAGE_THUMBNAIL_SIZE).toString('base64') },
      400,
      'not_transparent',
    );
  });

  it('refuses a master over the size ceiling with 413', async () => {
    const huge = Buffer.alloc(9 * 1024 * 1024, 0x21);
    png(1).copy(huge, 0);
    await expectRefused({ image: huge.toString('base64'), thumbnail: THUMBNAIL }, 413, 'too_large');
  });

  it('refuses a non-string payload rather than treating it as bytes', async () => {
    await expectRefused({ image: [1, 2, 3], thumbnail: THUMBNAIL }, 400);
  });

  it('answers 503 when the deployment has no Cloudflare configuration', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    const before = await mediaOf(baseExerciseId);
    const res = await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(503);
    expect(res.body.missingConfig.length).toBeGreaterThan(0);
    expect(await mediaOf(baseExerciseId)).toEqual(before);
  });

  it('answers 502 and writes nothing when R2 refuses the upload', async () => {
    const before = await mediaOf(baseExerciseId);
    sendMock.mockRejectedValue(new Error('R2 is down'));
    const res = await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(502);
    expect(await mediaOf(baseExerciseId)).toEqual(before);
  });
});

// ─── Replacement and ownership (§13) ──────────────────────────────────────────

describe('POST /platform/exercises/:id/image — replacement', () => {
  it('overwrites the same deterministic keys and deletes nothing', async () => {
    await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    sendMock.mockClear();
    const res = await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(putKeys()).toEqual([masterKey(baseExerciseId, BASE_SLUG), thumbnailKey(baseExerciseId, BASE_SLUG)]);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('sweeps the objects at the old keys when the exercise was renamed since its last upload', async () => {
    const staleMaster = url(masterKey(baseExerciseId, 'Old-Name'));
    const staleThumb = url(thumbnailKey(baseExerciseId, 'Old-Name'));
    await setMedia(baseExerciseId, staleMaster, staleThumb);

    const res = await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(deletedKeys().sort()).toEqual([
      masterKey(baseExerciseId, 'Old-Name'),
      thumbnailKey(baseExerciseId, 'Old-Name'),
    ].sort());
    expect(await mediaOf(baseExerciseId)).toEqual({
      image_url: url(masterKey(baseExerciseId, BASE_SLUG)),
      image_thumbnail_url: url(thumbnailKey(baseExerciseId, BASE_SLUG)),
    });
  });

  it("never deletes a gym's object, whatever the row points at", async () => {
    const gymObject = url(`${gymPrefix}/Exercises/Images/${baseExerciseId}-Old-Name.png`);
    await setMedia(baseExerciseId, gymObject, null);
    const res = await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('never deletes an external URL', async () => {
    await setMedia(baseExerciseId, 'https://example.com/squat.png', null);
    const res = await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });

  it("leaves a stale object alone while a gym's imported exercise still references it", async () => {
    const shared = url(masterKey(baseExerciseId, 'Old-Name'));
    await setMedia(baseExerciseId, shared, null);
    // `POST /exercises/import` copies media *references*, so a gym's copy points
    // at the platform's own object (#719 §2).
    await setMedia(gymExerciseId, shared, null);

    const res = await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
    expect((await mediaOf(gymExerciseId)).image_url).toBe(shared);
  });

  it('leaves a stale object alone while another base exercise still references it', async () => {
    const shared = url(masterKey(baseExerciseId, 'Old-Name'));
    await setMedia(baseExerciseId, shared, null);
    await setMedia(secondBaseExerciseId, shared, null);

    const res = await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });
});

// ─── Removal ──────────────────────────────────────────────────────────────────

describe('DELETE /platform/exercises/:id/image', () => {
  beforeEach(async () => {
    await setMedia(
      baseExerciseId,
      url(masterKey(baseExerciseId, BASE_SLUG)),
      url(thumbnailKey(baseExerciseId, BASE_SLUG)),
    );
  });

  it('clears both references and deletes both objects', async () => {
    const res = await remove(baseExerciseId);
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBeNull();
    expect(res.body.image_thumbnail_url).toBeNull();
    expect(await mediaOf(baseExerciseId)).toEqual({ image_url: null, image_thumbnail_url: null });
    expect(deletedKeys().sort()).toEqual([
      masterKey(baseExerciseId, BASE_SLUG),
      thumbnailKey(baseExerciseId, BASE_SLUG),
    ].sort());
  });

  it('leaves the objects alone while a gym exercise still references them', async () => {
    await setMedia(gymExerciseId, url(masterKey(baseExerciseId, BASE_SLUG)), url(thumbnailKey(baseExerciseId, BASE_SLUG)));
    const res = await remove(baseExerciseId);
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
    expect(await mediaOf(baseExerciseId)).toEqual({ image_url: null, image_thumbnail_url: null });
  });

  it('is a no-op on an exercise that has no image', async () => {
    await setMedia(baseExerciseId, null, null);
    const res = await remove(baseExerciseId);
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });

  it("returns 404 for a gym's own exercise and leaves its media in place", async () => {
    await setMedia(gymExerciseId, url(`${gymPrefix}/Exercises/Images/${gymExerciseId}-Gym.png`), null);
    const res = await remove(gymExerciseId);
    expect(res.status).toBe(404);
    expect(deletedKeys()).toHaveLength(0);
    expect((await mediaOf(gymExerciseId)).image_url).not.toBeNull();
  });

  it('does not fall back to any other image afterwards (#719 §12)', async () => {
    await remove(baseExerciseId);
    const res = await request
      .get(`/platform/exercises/${baseExerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBeNull();
    expect(res.body.image_thumbnail_url).toBeNull();
  });
});

// ─── The references the API exposes ───────────────────────────────────────────

describe('GET /platform/exercises — image references', () => {
  it('returns both references on the list and the single-exercise shapes', async () => {
    await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    const list = await request
      .get('/platform/exercises?q=Test Base Image Barbell')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(list.status).toBe(200);
    const row = list.body.find((e: any) => e.id === baseExerciseId);
    expect(row.image_url).toBe(url(masterKey(baseExerciseId, BASE_SLUG)));
    expect(row.image_thumbnail_url).toBe(url(thumbnailKey(baseExerciseId, BASE_SLUG)));
  });

  it('returns nulls for an exercise with no image, rather than omitting the fields', async () => {
    const res = await request
      .get(`/platform/exercises/${baseExerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBeNull();
    expect(res.body.image_thumbnail_url).toBeNull();
  });

  it('a PUT that repoints image_url drops the thumbnail it no longer belongs to', async () => {
    await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    const res = await request
      .put(`/platform/exercises/${baseExerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ image_url: 'https://example.com/other.png' });
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBe('https://example.com/other.png');
    expect(res.body.image_thumbnail_url).toBeNull();
  });
});
