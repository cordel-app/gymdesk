// #1420 stage 1 — gender-specific exercise media: `POST`/`DELETE
// /exercises/:id/(image|video)/:gender` for a Gym Exercise and the
// `/platform/exercises` mirror for a Base Exercise. This file mocks
// @aws-sdk/client-s3 and moves the CLOUDFLARE_R2_* env around, so it is separate
// from exercises.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { buildMp4 } from './mp4-fixtures';

const sendMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'put', input })),
  GetObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'get', input })),
  DeleteObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'delete', input })),
  CopyObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'copy', input })),
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

/** A RIFF/WEBP container with a VP8X header of the given size. */
function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

const MASTER = webp(1080, 1080).toString('base64');
const THUMBNAIL = webp(256, 256).toString('base64');
const IMAGE_BODY = { image: MASTER, thumbnail: THUMBNAIL };
const VIDEO = buildMp4({ mdatBytes: 4096 }).toString('base64');
const VIDEO_BODY = { video: VIDEO, preview: MASTER, preview_thumbnail: THUMBNAIL };

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

// The folder markers `ensureStorageFolders()` writes end in `/`; the files do not.
const putKeys = () => sentCommands('put').map((c: any) => c.input.Key).filter((k: string) => !k.endsWith('/'));
const deletedKeys = () => sentCommands('delete').map((c: any) => c.input.Key);
const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

const GYM_NAME = 'GenderMediaGym';
const EXERCISE_NAME = 'Test Gender Media Press';

let gymId: string;
let otherGymId: string;
let gymPrefix: string;
let exerciseId: number;
let otherGymExerciseId: number;
let baseExerciseId: number;

async function createExercise(gym: string | null, name: string): Promise<number> {
  const { insertId } = await db.query("INSERT INTO exercises (gym_id, name, status) VALUES (?, ?, 'active')", [gym, name]);
  return insertId as number;
}

async function mediaOf(id: number) {
  const { rows } = await db.query<Record<string, string | null>>(
    'SELECT image_male_url, image_female_url, video_male_url, video_female_url, image_url, video_url FROM exercises WHERE id = ?',
    [id],
  );
  return rows[0];
}

const gymPost = (path: string, body: unknown, gym = gymId) =>
  request.post(`/exercises/${exerciseId}/${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send(body as any);
const gymDelete = (path: string, id = exerciseId, gym = gymId) =>
  request.delete(`/exercises/${id}/${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const basePost = (path: string, body: unknown) =>
  request.post(`/platform/exercises/${baseExerciseId}/${path}`).set('Authorization', TEST_AUTH_HEADER).send(body as any);
const baseDelete = (path: string) =>
  request.delete(`/platform/exercises/${baseExerciseId}/${path}`).set('Authorization', TEST_AUTH_HEADER);

beforeAll(async () => {
  gymId = await createTestGym(GYM_NAME);
  await createTestMembership(gymId, 'admin');
  gymPrefix = `gyms/${gymId}-${GYM_NAME}`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);
  otherGymId = await createTestGym('GenderMediaGymOther');

  exerciseId = await createExercise(gymId, EXERCISE_NAME);
  otherGymExerciseId = await createExercise(otherGymId, 'Test Gender Media Other');
  baseExerciseId = await createExercise(null, 'Test Gender Media Base');
});

afterAll(async () => {
  await db.query("DELETE FROM exercises WHERE name LIKE 'Test Gender Media %'");
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
    `UPDATE exercises SET image_male_url = NULL, image_female_url = NULL, video_male_url = NULL, video_female_url = NULL,
            image_url = NULL, video_url = NULL, name = ?, status = 'active' WHERE id = ?`,
    [EXERCISE_NAME, exerciseId],
  );
  await db.query(
    `UPDATE exercises SET image_male_url = NULL, image_female_url = NULL, video_male_url = NULL, video_female_url = NULL
      WHERE id IN (?, ?)`,
    [otherGymExerciseId, baseExerciseId],
  );
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

describe('Gym Exercise gender images', () => {
  it('stores master and thumbnail under the gym prefix and the male column only', async () => {
    const res = await gymPost('image/male', IMAGE_BODY);
    expect(res.status).toBe(200);

    const master = `${gymPrefix}/exercises/images/${exerciseId}-Test-Gender-Media-Press-male.webp`;
    expect(putKeys()).toEqual([master, master.replace('.webp', '-thumbnail.webp')]);
    expect(res.body.image_male_url).toBe(url(master));
    expect(res.body.image_male_thumbnail_url).toBe(url(master.replace('.webp', '-thumbnail.webp')));
    expect(await mediaOf(exerciseId)).toMatchObject({ image_male_url: url(master), image_female_url: null, image_url: null });
  });

  it('keeps the female image independent of the male one', async () => {
    await gymPost('image/male', IMAGE_BODY);
    sendMock.mockClear();
    const res = await gymPost('image/female', IMAGE_BODY);
    expect(res.status).toBe(200);
    expect(putKeys()[0]).toMatch(/-female\.webp$/);
    const media = await mediaOf(exerciseId);
    expect(media.image_male_url).toMatch(/-male\.webp$/);
    expect(media.image_female_url).toMatch(/-female\.webp$/);
  });

  it('refuses an unknown gender, a wrong size and a missing thumbnail without uploading', async () => {
    expect((await gymPost('image/other', IMAGE_BODY)).status).toBe(400);
    const wrong = await gymPost('image/male', { image: webp(1000, 1080).toString('base64'), thumbnail: THUMBNAIL });
    expect(wrong.status).toBe(400);
    expect(wrong.body.reason).toBe('wrong_size');
    expect((await gymPost('image/male', { image: MASTER })).status).toBe(400);
    expect(putKeys()).toHaveLength(0);
    expect(await mediaOf(exerciseId)).toMatchObject({ image_male_url: null });
  });

  it('is gym-scoped: another gym’s exercise is 404 and a base exercise is 403', async () => {
    expect((await gymDelete('image/male', otherGymExerciseId)).status).toBe(404);
    const base = await request
      .post(`/exercises/${baseExerciseId}/image/male`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(IMAGE_BODY);
    expect(base.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });

  it('requires auth and TRAINING write', async () => {
    const anon = await request.post(`/exercises/${exerciseId}/image/male`).set('x-gym-id', gymId).send(IMAGE_BODY);
    expect(anon.status).toBe(401);
    const readOnlyGym = await createTestGym('GenderMediaGymReadOnly');
    await createTestMembership(readOnlyGym, 'accountant');
    expect((await gymPost('image/male', IMAGE_BODY, readOnlyGym)).status).toBe(403);
  });

  it('answers 502 and writes nothing when the upload fails', async () => {
    sendMock.mockRejectedValue(new Error('boom'));
    const res = await gymPost('image/male', IMAGE_BODY);
    expect(res.status).toBe(502);
    expect(await mediaOf(exerciseId)).toMatchObject({ image_male_url: null });
  });

  it('removes the reference and the gym’s own objects, and a shared object stays', async () => {
    await gymPost('image/male', IMAGE_BODY);
    const master = (await mediaOf(exerciseId)).image_male_url as string;
    sendMock.mockClear();

    // A duplicate pointing at the same object must keep it alive.
    const { insertId } = await db.query(
      "INSERT INTO exercises (gym_id, name, status, image_male_url) VALUES (?, 'Test Gender Media Copy', 'active', ?)",
      [gymId, master],
    );
    expect((await gymDelete('image/male')).status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);

    await db.query('UPDATE exercises SET image_male_url = NULL WHERE id = ?', [insertId]);
    await gymPost('image/male', IMAGE_BODY);
    sendMock.mockClear();
    expect((await gymDelete('image/male')).status).toBe(200);
    expect(deletedKeys()).toHaveLength(2);
    expect(await mediaOf(exerciseId)).toMatchObject({ image_male_url: null });
  });
});

describe('Gym Exercise gender videos', () => {
  it('stores the MP4 and its preview pair under videos/, never touching the image columns', async () => {
    const res = await gymPost('video/female', VIDEO_BODY);
    expect(res.status).toBe(200);

    const video = `${gymPrefix}/exercises/videos/${exerciseId}-Test-Gender-Media-Press-female.mp4`;
    expect(putKeys()).toEqual([
      video,
      video.replace('.mp4', '.webp'),
      video.replace('.mp4', '-thumbnail.webp'),
    ]);
    expect(res.body.video_female_url).toBe(url(video));
    expect(res.body.video_female_preview_url).toBe(url(video.replace('.mp4', '.webp')));
    expect(await mediaOf(exerciseId)).toMatchObject({
      video_female_url: url(video),
      video_male_url: null,
      image_male_url: null,
      image_female_url: null,
    });
  });

  it('refuses a file that is not an MP4 and a preview of the wrong size without uploading', async () => {
    const bad = await gymPost('video/male', { ...VIDEO_BODY, video: Buffer.alloc(64).toString('base64') });
    expect(bad.status).toBe(400);
    expect(bad.body.file).toBe('video');
    const small = await gymPost('video/male', { ...VIDEO_BODY, preview: THUMBNAIL });
    expect(small.status).toBe(400);
    expect(small.body.file).toBe('preview');
    expect(putKeys()).toHaveLength(0);
  });

  it('removes the video and its preview objects', async () => {
    await gymPost('video/male', VIDEO_BODY);
    sendMock.mockClear();
    expect((await gymDelete('video/male')).status).toBe(200);
    expect(deletedKeys()).toHaveLength(3);
    expect(await mediaOf(exerciseId)).toMatchObject({ video_male_url: null });
  });
});

describe('Base Exercise gender media (/platform/exercises)', () => {
  it('returns 401 without auth and 403 for a non-superadmin', async () => {
    expect((await request.post(`/platform/exercises/${baseExerciseId}/image/male`).send(IMAGE_BODY)).status).toBe(401);
    mockAsNonSuperadmin();
    expect((await basePost('image/male', IMAGE_BODY)).status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });

  it('stores an image under cordel/exercises/images', async () => {
    const res = await basePost('image/female', IMAGE_BODY);
    expect(res.status).toBe(200);
    const master = `cordel/exercises/images/${baseExerciseId}-Test-Gender-Media-Base-female.webp`;
    expect(putKeys()).toEqual([master, master.replace('.webp', '-thumbnail.webp')]);
    expect(res.body.image_female_url).toBe(url(master));
  });

  it('stores a video and previews under cordel/exercises/videos', async () => {
    const res = await basePost('video/male', VIDEO_BODY);
    expect(res.status).toBe(200);
    const video = `cordel/exercises/videos/${baseExerciseId}-Test-Gender-Media-Base-male.mp4`;
    expect(putKeys()).toEqual([video, video.replace('.mp4', '.webp'), video.replace('.mp4', '-thumbnail.webp')]);
  });

  it('is 404 for a gym-owned exercise', async () => {
    const res = await request
      .post(`/platform/exercises/${exerciseId}/image/male`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send(IMAGE_BODY);
    expect(res.status).toBe(404);
  });

  it('removes the reference and the platform’s objects', async () => {
    await basePost('image/male', IMAGE_BODY);
    sendMock.mockClear();
    expect((await baseDelete('image/male')).status).toBe(200);
    expect(deletedKeys()).toHaveLength(2);
    expect(await mediaOf(baseExerciseId)).toMatchObject({ image_male_url: null });
  });
});
