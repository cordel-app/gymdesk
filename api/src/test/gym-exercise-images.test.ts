// #719 part 1 — images on a **Gym Exercise**: the upload and remove routes
// (`POST`/`DELETE /exercises/:id/image`), the references the API exposes, and
// the ownership rules that decide which R2 objects a gym operation may delete.
//
// Separate from exercises.test.ts for the same reason base-nutrition-images.
// test.ts is separate from platform-nutrition-library.test.ts: this file mocks
// @aws-sdk/client-s3 and moves the CLOUDFLARE_R2_* env around.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const GYM_NAME = 'GymExerciseImages';
const OTHER_GYM_NAME = 'GymExerciseImagesOther';
const EXERCISE_NAME = 'Test Image Barbell Press';
const SECOND_EXERCISE_NAME = 'Test Image Overhead Press';

let gymId: string;
let gymPrefix: string;
let otherGymId: string;
let otherGymPrefix: string;
let exerciseId: number;
let secondExerciseId: number;
let baseExerciseId: number;
let otherGymExerciseId: number;

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

function upload(id: number | string, body: unknown, gym = gymId) {
  return request
    .post(`/exercises/${id}/image`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gym)
    .send(body as any);
}

function remove(id: number | string, gym = gymId) {
  return request
    .delete(`/exercises/${id}/image`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gym);
}

beforeAll(async () => {
  gymId = await createTestGym(GYM_NAME);
  await createTestMembership(gymId, 'admin');
  gymPrefix = `gyms/${gymId}-${GYM_NAME}`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);

  otherGymId = await createTestGym(OTHER_GYM_NAME);
  otherGymPrefix = `gyms/${otherGymId}-${OTHER_GYM_NAME}`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [otherGymPrefix, otherGymId]);

  exerciseId = await createExercise(gymId, EXERCISE_NAME);
  secondExerciseId = await createExercise(gymId, SECOND_EXERCISE_NAME);
  baseExerciseId = await createExercise(null, 'Test Image Base Exercise');
  otherGymExerciseId = await createExercise(otherGymId, 'Test Image Other Gym Exercise');
});

afterAll(async () => {
  await db.query("DELETE FROM exercises WHERE name LIKE 'Test Image %'");
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
  await db.query(
    "UPDATE exercises SET image_url = NULL, image_thumbnail_url = NULL, name = ?, status = 'active' WHERE id = ?",
    [EXERCISE_NAME, exerciseId],
  );
  await setMedia(secondExerciseId, null, null);
  await setMedia(baseExerciseId, null, null);
  await setMedia(otherGymExerciseId, null, null);
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── Auth and tenancy (#719 §20) ──────────────────────────────────────────────

describe('POST /exercises/:id/image — auth and tenancy', () => {
  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/exercises/${exerciseId}/image`)
      .set('x-gym-id', gymId)
      .send({ image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for a role without TRAINING write', async () => {
    const readOnlyGym = await createTestGym('GymExerciseImagesReadOnly');
    await createTestMembership(readOnlyGym, 'accountant');
    const res = await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL }, readOnlyGym);
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 404 for an exercise belonging to another gym', async () => {
    const res = await upload(otherGymExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
    expect(await mediaOf(otherGymExerciseId)).toMatchObject({ image_url: null });
  });

  it('refuses a base exercise — its media is the platform’s', async () => {
    const res = await upload(baseExerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });
});

// ─── Happy path (#719 §4, §5, §18) ────────────────────────────────────────────

describe('POST /exercises/:id/image', () => {
  it('stores master and thumbnail under the gym prefix and persists both references', async () => {
    const res = await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);

    const imageKey = `${gymPrefix}/Exercises/Images/${exerciseId}-Test-Image-Barbell-Press.png`;
    const thumbKey = `${gymPrefix}/Exercises/Images/${exerciseId}-Test-Image-Barbell-Press-thumbnail.png`;
    expect(putKeys()).toEqual([imageKey, thumbKey]);
    for (const command of sentCommands('put')) {
      expect(command.input).toMatchObject({ Bucket: R2_BUCKET });
    }

    expect(res.body.image_url).toBe(url(imageKey));
    expect(res.body.image_thumbnail_url).toBe(url(thumbKey));
    expect(await mediaOf(exerciseId)).toEqual({ image_url: url(imageKey), image_thumbnail_url: url(thumbKey) });
  });

  it('never writes into the platform folder (§18)', async () => {
    await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    for (const key of putKeys()) {
      expect(key.startsWith(`${gymPrefix}/`)).toBe(true);
      expect(key.startsWith('cordel/')).toBe(false);
    }
  });

  it('does not change the exercise’s source (§11)', async () => {
    await db.query('UPDATE exercises SET cloned_from_id = ? WHERE id = ?', [baseExerciseId, exerciseId]);
    const res = await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(Number(res.body.cloned_from_id)).toBe(baseExerciseId);
    await db.query('UPDATE exercises SET cloned_from_id = NULL WHERE id = ?', [exerciseId]);
  });

  it('accepts a body far past express.json()’s 100 kB default', async () => {
    // A real 2048×2048 exercise photo is hundreds of kB, and base64 adds a
    // third on top. The route's own parser runs before the global one for
    // exactly this reason — without it the pair would fail as a bare 413.
    const noisy = Buffer.alloc(EXERCISE_IMAGE_MASTER_SIZE * EXERCISE_IMAGE_MASTER_SIZE * 4);
    // Deterministic noise (xorshift32) over a slice of the image: a flat fill
    // deflates to a few kB and would test nothing, while noise everywhere
    // produces a 20 MB file that the *file* limit rejects for its own reasons.
    // This lands where a real photo does — comfortably past 100 kB, well inside
    // the 8 MB master limit.
    let seed = 0x1234_5678;
    for (let i = 0; i < noisy.length / 64; i += 1) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      noisy[i] = seed & 0xff;
    }
    const big = encodePngRgba(EXERCISE_IMAGE_MASTER_SIZE, EXERCISE_IMAGE_MASTER_SIZE, noisy).toString('base64');
    expect(big.length).toBeGreaterThan(100 * 1024);
    expect(big.length).toBeLessThan(8 * 1024 * 1024);

    const res = await upload(exerciseId, { image: big, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(putKeys()).toHaveLength(2);
  });

  it('accepts a data: URL body as well as bare base64', async () => {
    const res = await upload(exerciseId, {
      image: `data:image/png;base64,${MASTER}`,
      thumbnail: `data:image/png;base64,${THUMBNAIL}`,
    });
    expect(res.status).toBe(200);
    expect(putKeys()).toHaveLength(2);
  });
});

// ─── Validation (#719 §5, §8, §21) ────────────────────────────────────────────

describe('POST /exercises/:id/image — validation', () => {
  it('requires both files', async () => {
    const res = await upload(exerciseId, { image: MASTER });
    expect(res.status).toBe(400);
    expect(putKeys()).toHaveLength(0);
  });

  it('rejects a master that is not 2048×2048', async () => {
    const res = await upload(exerciseId, { image: png(1024).toString('base64'), thumbnail: THUMBNAIL });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason: 'wrong_size', file: 'image' });
    expect(putKeys()).toHaveLength(0);
  });

  it('rejects a thumbnail that is not 512×512 — and uploads neither file (#719 Q2)', async () => {
    const res = await upload(exerciseId, { image: MASTER, thumbnail: png(256).toString('base64') });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason: 'wrong_size', file: 'thumbnail' });
    expect(putKeys()).toHaveLength(0);
  });

  it('rejects a file that is not a PNG, whatever the request claimed', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]).toString('base64');
    const res = await upload(exerciseId, { image: jpeg, thumbnail: THUMBNAIL });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('not_a_png');
  });

  it('rejects an opaque PNG', async () => {
    const res = await upload(exerciseId, {
      image: opaquePng(EXERCISE_IMAGE_MASTER_SIZE).toString('base64'),
      thumbnail: THUMBNAIL,
    });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('not_transparent');
  });

  it('leaves the existing image untouched when the upload is refused (§8)', async () => {
    const existing = url(`${gymPrefix}/Exercises/Images/${exerciseId}-Old.png`);
    await setMedia(exerciseId, existing, null);
    const res = await upload(exerciseId, { image: png(1024).toString('base64'), thumbnail: THUMBNAIL });
    expect(res.status).toBe(400);
    expect(deletedKeys()).toHaveLength(0);
    expect(await mediaOf(exerciseId)).toMatchObject({ image_url: existing });
  });

  it('keeps the existing image when R2 rejects the upload (§8)', async () => {
    const existing = url(`${gymPrefix}/Exercises/Images/${exerciseId}-Old.png`);
    await setMedia(exerciseId, existing, null);
    sendMock.mockRejectedValue(Object.assign(new Error('boom'), { name: 'NoSuchBucket' }));
    const res = await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(502);
    expect(deletedKeys()).toHaveLength(0);
    expect(await mediaOf(exerciseId)).toMatchObject({ image_url: existing });
  });

  it('returns 503 when the deployment has no R2 configured', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    const res = await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(503);
    expect(res.body.missingConfig).toContain('CLOUDFLARE_R2_BUCKET');
  });

  it('returns 409 when the gym’s bucket was never initialized', async () => {
    await db.query('UPDATE gyms SET storage_folder_prefix = NULL WHERE id = ?', [gymId]);
    try {
      const res = await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
      expect(res.status).toBe(409);
      expect(putKeys()).toHaveLength(0);
    } finally {
      await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);
    }
  });
});

// ─── Replacement and ownership (#719 §8, §19) ─────────────────────────────────

describe('POST /exercises/:id/image — replacement', () => {
  it('deletes the gym-owned object it replaced, after the row points at the new one', async () => {
    const stale = url(`${gymPrefix}/Exercises/Images/legacy-uuid.png`);
    await setMedia(exerciseId, stale, null);
    const res = await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toEqual([`${gymPrefix}/Exercises/Images/legacy-uuid.png`]);
  });

  it('never deletes a System object the exercise was imported with (§19)', async () => {
    const systemUrl = url('cordel/Exercises/Images/77-Barbell-Press.png');
    await setMedia(exerciseId, systemUrl, null);
    const res = await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('never deletes an external URL’s object', async () => {
    await setMedia(exerciseId, 'https://example.com/press.png', null);
    await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(deletedKeys()).toHaveLength(0);
  });

  it('keeps an object another exercise still references', async () => {
    const shared = url(`${gymPrefix}/Exercises/Images/shared.png`);
    await setMedia(exerciseId, shared, null);
    await setMedia(secondExerciseId, shared, null);
    const res = await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
    expect(await mediaOf(secondExerciseId)).toMatchObject({ image_url: shared });
  });

  it('re-uploading the same exercise overwrites its own key and deletes nothing', async () => {
    await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    sendMock.mockClear();
    const res = await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('cleans up the previous pair when the exercise was renamed since its last upload', async () => {
    await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    const before = await mediaOf(exerciseId);
    await db.query('UPDATE exercises SET name = ? WHERE id = ?', ['Test Image Barbell Press Renamed', exerciseId]);
    sendMock.mockClear();
    const res = await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(res.body.image_url).toContain('Barbell-Press-Renamed.png');
    expect(deletedKeys().sort()).toEqual([
      `${gymPrefix}/Exercises/Images/${exerciseId}-Test-Image-Barbell-Press-thumbnail.png`,
      `${gymPrefix}/Exercises/Images/${exerciseId}-Test-Image-Barbell-Press.png`,
    ]);
    expect(before.image_url).not.toBe(res.body.image_url);
  });

  it('a failed cleanup still leaves the exercise pointing at the new image', async () => {
    await setMedia(exerciseId, url(`${gymPrefix}/Exercises/Images/legacy-uuid.png`), null);
    sendMock.mockImplementation((command: any) => (
      command?.__type === 'delete' ? Promise.reject(new Error('delete failed')) : Promise.resolve({})
    ));
    const res = await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    expect(res.status).toBe(200);
    expect(res.body.image_url).toContain(`${exerciseId}-Test-Image-Barbell-Press.png`);
  });
});

// ─── Removal (#719 §10, §12) ──────────────────────────────────────────────────

describe('DELETE /exercises/:id/image', () => {
  it('clears both references and deletes the gym’s own objects', async () => {
    await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    sendMock.mockClear();
    const res = await remove(exerciseId);
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBeNull();
    expect(res.body.image_thumbnail_url).toBeNull();
    expect(await mediaOf(exerciseId)).toEqual({ image_url: null, image_thumbnail_url: null });
    expect(deletedKeys().sort()).toEqual([
      `${gymPrefix}/Exercises/Images/${exerciseId}-Test-Image-Barbell-Press-thumbnail.png`,
      `${gymPrefix}/Exercises/Images/${exerciseId}-Test-Image-Barbell-Press.png`,
    ]);
  });

  it('clears a System reference without deleting the System object (§10, §19)', async () => {
    const systemUrl = url('cordel/Exercises/Images/77-Barbell-Press.png');
    await setMedia(exerciseId, systemUrl, null);
    const res = await remove(exerciseId);
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBeNull();
    expect(deletedKeys()).toHaveLength(0);
  });

  it('does not fall back to the Base Exercise’s image afterwards (§10)', async () => {
    await setMedia(baseExerciseId, url('cordel/Exercises/Images/77-Base.png'), null);
    await db.query('UPDATE exercises SET cloned_from_id = ? WHERE id = ?', [baseExerciseId, exerciseId]);
    await setMedia(exerciseId, url('cordel/Exercises/Images/77-Base.png'), null);
    await remove(exerciseId);
    const listed = await request.get('/exercises').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const row = listed.body.find((e: any) => Number(e.id) === exerciseId);
    expect(row.image_url).toBeNull();
    expect(row.image_thumbnail_url).toBeNull();
    await db.query('UPDATE exercises SET cloned_from_id = NULL WHERE id = ?', [exerciseId]);
  });

  it('refuses a base exercise and another gym’s exercise', async () => {
    expect((await remove(baseExerciseId)).status).toBe(403);
    expect((await remove(otherGymExerciseId)).status).toBe(404);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('returns 401 without auth', async () => {
    const res = await request.delete(`/exercises/${exerciseId}/image`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});

// ─── References the API exposes (#719 §13) ────────────────────────────────────

describe('exercise media references', () => {
  it('list and detail both return the current references, with no Base fallback', async () => {
    await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    const media = await mediaOf(exerciseId);

    const detail = await request.get(`/exercises/${exerciseId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(detail.body).toMatchObject(media);

    const list = await request.get('/exercises').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const row = list.body.find((e: any) => Number(e.id) === exerciseId);
    expect(row).toMatchObject(media);
  });

  it('reports null for an exercise with no image', async () => {
    const detail = await request.get(`/exercises/${secondExerciseId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(detail.body.image_url).toBeNull();
    expect(detail.body.image_thumbnail_url).toBeNull();
  });

  it('PUT that sets image_url clears the thumbnail, which belonged to the old master', async () => {
    await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    const res = await request
      .put(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ image_url: 'https://example.com/press.png' });
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBe('https://example.com/press.png');
    expect(res.body.image_thumbnail_url).toBeNull();
  });

  it('PUT that does not mention image_url leaves both references alone', async () => {
    await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    const before = await mediaOf(exerciseId);
    const res = await request
      .put(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ description: 'unchanged media' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(before);
  });
});

// ─── Copying references (#719 §2, §3) ─────────────────────────────────────────

describe('copies carry the media references, not the objects', () => {
  it('import copies the Base Exercise’s references and uploads nothing', async () => {
    const imageUrl = url('cordel/Exercises/Images/88-Base-Import.png');
    const thumbUrl = url('cordel/Exercises/Images/88-Base-Import-thumbnail.png');
    const baseId = await createExercise(null, 'Test Image Base Import Source');
    await setMedia(baseId, imageUrl, thumbUrl);

    const res = await request
      .post('/exercises/import')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ baseExerciseIds: [baseId] });
    expect(res.status).toBe(201);
    expect(res.body.imported[0]).toMatchObject({ image_url: imageUrl, image_thumbnail_url: thumbUrl });
    expect(Number(res.body.imported[0].cloned_from_id)).toBe(baseId);
    // References only — no System object is copied into the gym's folder (§2).
    expect(putKeys()).toHaveLength(0);
  });

  it('duplicate copies both references', async () => {
    await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    const media = await mediaOf(exerciseId);
    const res = await request
      .post(`/exercises/${exerciseId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject(media);
    await db.query('DELETE FROM exercises WHERE id = ?', [res.body.id]);
  });

  it('removing the original’s image keeps the object a copy still points at', async () => {
    await upload(exerciseId, { image: MASTER, thumbnail: THUMBNAIL });
    const copy = await request
      .post(`/exercises/${exerciseId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    sendMock.mockClear();
    const res = await remove(exerciseId);
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
    expect((await mediaOf(copy.body.id)).image_url).not.toBeNull();
    await db.query('DELETE FROM exercises WHERE id = ?', [copy.body.id]);
  });
});
