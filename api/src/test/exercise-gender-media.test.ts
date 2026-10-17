// #1420 stages 1–2 — gender-specific exercise media: `POST`/`DELETE
// /exercises/:id/(image|video)/:gender` for a Gym Exercise and the
// `/platform/exercises` mirror for a Base Exercise. This file mocks
// @aws-sdk/client-s3 and moves the CLOUDFLARE_R2_* env around, so it is separate
// from exercises.test.ts. Since stage 2 the server makes the WebP files from the
// picture a client sends, so the tests send real pictures and read the uploaded
// bytes back with sharp.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import sharp from 'sharp';
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

/** A real picture of the given size and colour, in the given format. */
async function picture(width: number, height: number, format: 'png' | 'jpeg' | 'webp' = 'png', alpha = false): Promise<Buffer> {
  const base = sharp({
    create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 200, g: 80, b: 40, alpha: 1 } : { r: 200, g: 80, b: 40 } },
  });
  return base[format]().toBuffer();
}

let IMAGE_BODY: { image: string };
let VIDEO_BODY: { video: string; frame: string };
const VIDEO = buildMp4({ mdatBytes: 4096 }).toString('base64');

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

/** The body of the PutObject call that wrote `key`. */
function uploadedBody(key: string): Buffer {
  const command: any = sentCommands('put').find((c: any) => c.input.Key === key);
  return command.input.Body as Buffer;
}

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
    'SELECT image_male_url, image_female_url, video_male_url, video_female_url FROM exercises WHERE id = ?',
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
  IMAGE_BODY = { image: (await picture(1600, 900, 'jpeg')).toString('base64') };
  VIDEO_BODY = { video: VIDEO, frame: (await picture(1280, 720)).toString('base64') };
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
            name = ?, status = 'active' WHERE id = ?`,
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
    expect(await mediaOf(exerciseId)).toMatchObject({ image_male_url: url(master), image_female_url: null });
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

  it('centre-crops a non-square picture to a 1080 master and a 256 thumbnail, with no transparent band (#1527)', async () => {
    // 1600x900 JPEG, fully opaque: cropped to its middle 900x900, then 1080x1080 —
    // every row is picture, so My Training shows no band between photo and card.
    const res = await gymPost('image/male', IMAGE_BODY);
    expect(res.status).toBe(200);
    const master = `${gymPrefix}/exercises/images/${exerciseId}-Test-Gender-Media-Press-male.webp`;
    const thumb = master.replace('.webp', '-thumbnail.webp');

    const m = await sharp(uploadedBody(master)).metadata();
    expect(m).toMatchObject({ format: 'webp', width: 1080, height: 1080 });
    const t = await sharp(uploadedBody(thumb)).metadata();
    expect(t).toMatchObject({ format: 'webp', width: 256, height: 256 });

    const { data, info } = await sharp(uploadedBody(master)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (y: number) => data[(y * info.width + 540) * info.channels + 3];
    for (const y of [0, 10, 540, 1070, 1079]) expect(alphaAt(y)).toBe(255);
  });

  it('converts PNG and WebP uploads too', async () => {
    for (const format of ['png', 'webp'] as const) {
      sendMock.mockClear();
      const body = { image: (await picture(300, 300, format)).toString('base64') };
      const res = await gymPost('image/male', body);
      expect(res.status).toBe(200);
      expect(await sharp(uploadedBody(putKeys()[0])).metadata()).toMatchObject({ format: 'webp', width: 1080, height: 1080 });
    }
  });

  it('refuses an unknown gender, a missing, unreadable or unsupported picture without uploading', async () => {
    expect((await gymPost('image/other', IMAGE_BODY)).status).toBe(400);
    expect((await gymPost('image/male', {})).status).toBe(400);
    const garbage = await gymPost('image/male', { image: Buffer.from('not a picture at all').toString('base64') });
    expect(garbage.status).toBe(400);
    expect(garbage.body.reason).toBe('unreadable');
    const tiff = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#123456' } }).tiff().toBuffer();
    const unsupported = await gymPost('image/male', { image: tiff.toString('base64') });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.reason).toBe('unsupported_format');
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
    mockAsNonSuperadmin();
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

  it('makes the preview and its thumbnail from the frame', async () => {
    const res = await gymPost('video/male', VIDEO_BODY);
    expect(res.status).toBe(200);
    const video = `${gymPrefix}/exercises/videos/${exerciseId}-Test-Gender-Media-Press-male.mp4`;
    expect(await sharp(uploadedBody(video.replace('.mp4', '.webp'))).metadata()).toMatchObject({
      format: 'webp', width: 1080, height: 1080, hasAlpha: false,
    });
    expect(await sharp(uploadedBody(video.replace('.mp4', '-thumbnail.webp'))).metadata()).toMatchObject({
      format: 'webp', width: 256, height: 256,
    });
    expect(uploadedBody(video).length).toBeGreaterThan(0);
  });

  it('does not overwrite a separately uploaded image with the video preview', async () => {
    await gymPost('image/male', IMAGE_BODY);
    const before = (await mediaOf(exerciseId)).image_male_url;
    await gymPost('video/male', VIDEO_BODY);
    expect((await mediaOf(exerciseId)).image_male_url).toBe(before);
  });

  it('refuses a file that is not an MP4, a missing frame and an unreadable frame without uploading', async () => {
    const bad = await gymPost('video/male', { ...VIDEO_BODY, video: Buffer.alloc(64).toString('base64') });
    expect(bad.status).toBe(400);
    expect(bad.body.file).toBe('video');
    const missing = await gymPost('video/male', { video: VIDEO });
    expect(missing.status).toBe(400);
    const unreadable = await gymPost('video/male', { ...VIDEO_BODY, frame: Buffer.from('nope').toString('base64') });
    expect(unreadable.status).toBe(400);
    expect(unreadable.body.file).toBe('frame');
    expect(putKeys()).toHaveLength(0);
    expect(await mediaOf(exerciseId)).toMatchObject({ video_male_url: null });
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
