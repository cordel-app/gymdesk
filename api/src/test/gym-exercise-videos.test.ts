// #719 part 2 — videos on a **Gym Exercise**: the upload and remove routes
// (`POST`/`DELETE /exercises/:id/video`), the references the API exposes, and
// the ownership rules that decide which R2 objects a gym operation may delete.
//
// Separate from exercises.test.ts for the same reason gym-exercise-images.test.
// ts is: this file mocks @aws-sdk/client-s3 and moves the CLOUDFLARE_R2_* env
// around.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { encodePngRgba } from '../domain/pngImage';
import { EXERCISE_VIDEO_POSTER_SIZE } from '../domain/exerciseVideos';
import { buildMp4 } from './mp4-fixtures';

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
const originalMaxMb = process.env.EXERCISE_VIDEO_MAX_MB;

function setStorageConfigured() {
  process.env.CLOUDFLARE_R2_ENDPOINT = R2_ENDPOINT;
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUDFLARE_R2_BUCKET = R2_BUCKET;
}

function png(size: number): Buffer {
  return encodePngRgba(size, size, Buffer.alloc(size * size * 4, 0x40));
}

const VIDEO = buildMp4({ mdatBytes: 4096 }).toString('base64');
const POSTER = png(EXERCISE_VIDEO_POSTER_SIZE).toString('base64');

function sentCommands(type: 'put' | 'delete') {
  return sendMock.mock.calls.map(([command]) => command).filter((c: any) => c?.__type === type);
}

function putCommands() {
  // The folder markers `ensureStorageFolders()` writes end in `/`; the files do not.
  return sentCommands('put').filter((c: any) => !c.input.Key.endsWith('/'));
}

function putKeys(): string[] {
  return putCommands().map((c: any) => c.input.Key);
}

function deletedKeys(): string[] {
  return sentCommands('delete').map((c: any) => c.input.Key);
}

const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

const GYM_NAME = 'GymExerciseVideos';
const OTHER_GYM_NAME = 'GymExerciseVideosOther';
const EXERCISE_NAME = 'Test Video Barbell Press';
const SECOND_EXERCISE_NAME = 'Test Video Overhead Press';

let gymId: string;
let gymPrefix: string;
let otherGymId: string;
let otherGymPrefix: string;
let exerciseId: number;
let secondExerciseId: number;
let baseExerciseId: number;
let otherGymExerciseId: number;
let videoKey: string;
let posterKey: string;

async function createExercise(gym: string | null, name: string): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO exercises (gym_id, name, status) VALUES (?, ?, 'active')",
    [gym, name],
  );
  return insertId as number;
}

interface MediaRow {
  image_url: string | null;
  image_thumbnail_url: string | null;
  video_url: string | null;
  video_thumbnail_url: string | null;
}

async function mediaOf(id: number): Promise<MediaRow> {
  const { rows } = await db.query<MediaRow>(
    'SELECT image_url, image_thumbnail_url, video_url, video_thumbnail_url FROM exercises WHERE id = ?',
    [id],
  );
  return rows[0];
}

async function setVideo(id: number, videoUrl: string | null, posterUrl: string | null) {
  await db.query('UPDATE exercises SET video_url = ?, video_thumbnail_url = ? WHERE id = ?', [videoUrl, posterUrl, id]);
}

async function setImage(id: number, imageUrl: string | null, thumbnailUrl: string | null) {
  await db.query('UPDATE exercises SET image_url = ?, image_thumbnail_url = ? WHERE id = ?', [imageUrl, thumbnailUrl, id]);
}

function upload(id: number | string, body: unknown, gym = gymId) {
  return request
    .post(`/exercises/${id}/video`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gym)
    .send(body as any);
}

function remove(id: number | string, gym = gymId) {
  return request
    .delete(`/exercises/${id}/video`)
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
  baseExerciseId = await createExercise(null, 'Test Video Base Exercise');
  otherGymExerciseId = await createExercise(otherGymId, 'Test Video Other Gym Exercise');

  videoKey = `${gymPrefix}/Exercises/Videos/${exerciseId}-Test-Video-Barbell-Press.mp4`;
  posterKey = `${gymPrefix}/Exercises/Videos/${exerciseId}-Test-Video-Barbell-Press-thumbnail.png`;
});

afterAll(async () => {
  await db.query("DELETE FROM exercises WHERE name LIKE 'Test Video %'");
  await cleanupTestGyms();
  for (const key of R2_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await db.end();
});

beforeEach(async () => {
  setStorageConfigured();
  if (originalMaxMb === undefined) delete process.env.EXERCISE_VIDEO_MAX_MB;
  else process.env.EXERCISE_VIDEO_MAX_MB = originalMaxMb;
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
  await db.query(
    `UPDATE exercises SET video_url = NULL, video_thumbnail_url = NULL, image_url = NULL, image_thumbnail_url = NULL,
       name = ?, status = 'active' WHERE id = ?`,
    [EXERCISE_NAME, exerciseId],
  );
  for (const id of [secondExerciseId, baseExerciseId, otherGymExerciseId]) {
    await setVideo(id, null, null);
    await setImage(id, null, null);
  }
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── Auth and tenancy (#719 §20) ──────────────────────────────────────────────

describe('POST /exercises/:id/video — auth and tenancy', () => {
  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/exercises/${exerciseId}/video`)
      .set('x-gym-id', gymId)
      .send({ video: VIDEO, poster: POSTER });
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for a role without TRAINING write', async () => {
    const readOnlyGym = await createTestGym('GymExerciseVideosReadOnly');
    await createTestMembership(readOnlyGym, 'accountant');
    const res = await upload(exerciseId, { video: VIDEO, poster: POSTER }, readOnlyGym);
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 404 for an exercise belonging to another gym', async () => {
    const res = await upload(otherGymExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
    expect(await mediaOf(otherGymExerciseId)).toMatchObject({ video_url: null });
  });

  it('refuses a base exercise — its media is the platform’s', async () => {
    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });

  it('refuses to remove a base exercise’s video too', async () => {
    const res = await remove(baseExerciseId);
    expect(res.status).toBe(403);
  });
});

// ─── Happy path (#719 §6, §7, §18) ────────────────────────────────────────────

describe('POST /exercises/:id/video', () => {
  it('stores the video and its poster under the gym prefix and persists both references', async () => {
    const res = await upload(exerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);

    expect(putKeys()).toEqual([videoKey, posterKey]);
    expect(putCommands().map((c: any) => c.input.ContentType)).toEqual(['video/mp4', 'image/png']);
    for (const command of sentCommands('put')) {
      expect(command.input).toMatchObject({ Bucket: R2_BUCKET });
    }

    expect(res.body.video_url).toBe(url(videoKey));
    expect(res.body.video_thumbnail_url).toBe(url(posterKey));
    expect(await mediaOf(exerciseId)).toMatchObject({
      video_url: url(videoKey),
      video_thumbnail_url: url(posterKey),
    });
  });

  it('never writes into the platform folder (§18)', async () => {
    await upload(exerciseId, { video: VIDEO, poster: POSTER });
    for (const key of putKeys()) {
      expect(key.startsWith(`${gymPrefix}/`)).toBe(true);
      expect(key.startsWith('cordel/')).toBe(false);
    }
  });

  it('does not change the exercise’s source (§11)', async () => {
    await db.query('UPDATE exercises SET cloned_from_id = ? WHERE id = ?', [baseExerciseId, exerciseId]);
    const res = await upload(exerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(Number(res.body.cloned_from_id)).toBe(baseExerciseId);
    await db.query('UPDATE exercises SET cloned_from_id = NULL WHERE id = ?', [exerciseId]);
  });

  it('leaves the image pair alone (§10: the two are removed independently)', async () => {
    const imageUrl = url(`${gymPrefix}/Exercises/Images/${exerciseId}-Press.png`);
    await setImage(exerciseId, imageUrl, null);
    const res = await upload(exerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(await mediaOf(exerciseId)).toMatchObject({ image_url: imageUrl });
    expect(deletedKeys()).toHaveLength(0);
  });

  it('accepts a body far past express.json()’s 100 kB default', async () => {
    const big = buildMp4({ mdatBytes: 1024 * 1024 }).toString('base64');
    expect(big.length).toBeGreaterThan(100 * 1024);
    const res = await upload(exerciseId, { video: big, poster: POSTER });
    expect(res.status).toBe(200);
    expect(putKeys()).toEqual([videoKey, posterKey]);
  });

  it('accepts a data: URL body as well as bare base64', async () => {
    const res = await upload(exerciseId, {
      video: `data:video/mp4;base64,${VIDEO}`,
      poster: `data:image/png;base64,${POSTER}`,
    });
    expect(res.status).toBe(200);
    expect(putKeys()).toHaveLength(2);
  });
});

// ─── Validation (#719 §7, §9, §21) ────────────────────────────────────────────

describe('POST /exercises/:id/video — validation', () => {
  it('requires both files', async () => {
    const res = await upload(exerciseId, { video: VIDEO });
    expect(res.status).toBe(400);
    expect(putKeys()).toHaveLength(0);
  });

  it('rejects a file that is not an MP4, whatever the request claimed', async () => {
    const res = await upload(exerciseId, { video: png(64).toString('base64'), poster: POSTER });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason: 'not_an_mp4', file: 'video' });
    expect(putKeys()).toHaveLength(0);
  });

  it('rejects a QuickTime file renamed to .mp4', async () => {
    const mov = buildMp4({ majorBrand: 'qt  ', compatibleBrands: ['qt  '] }).toString('base64');
    const res = await upload(exerciseId, { video: mov, poster: POSTER });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('not_an_mp4');
  });

  it('rejects an audio-only MP4', async () => {
    const audio = buildMp4({ codecs: ['mp4a'] }).toString('base64');
    const res = await upload(exerciseId, { video: audio, poster: POSTER });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('no_video_track');
  });

  it('rejects a poster that is not 512×512 — and uploads neither file (#719 Q2)', async () => {
    const res = await upload(exerciseId, { video: VIDEO, poster: png(256).toString('base64') });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason: 'wrong_size', file: 'poster' });
    expect(putKeys()).toHaveLength(0);
  });

  it('rejects a video past the configured ceiling with 413', async () => {
    process.env.EXERCISE_VIDEO_MAX_MB = '1';
    const big = buildMp4({ mdatBytes: 2 * 1024 * 1024 }).toString('base64');
    const res = await upload(exerciseId, { video: big, poster: POSTER });
    expect(res.status).toBe(413);
    expect(res.body.reason).toBe('too_large');
    expect(putKeys()).toHaveLength(0);
  });

  it('leaves the existing video untouched when the upload is refused (§9)', async () => {
    const existing = url(`${gymPrefix}/Exercises/Videos/${exerciseId}-Old.mp4`);
    const existingPoster = url(`${gymPrefix}/Exercises/Videos/${exerciseId}-Old-thumbnail.png`);
    await setVideo(exerciseId, existing, existingPoster);
    const res = await upload(exerciseId, { video: png(64).toString('base64'), poster: POSTER });
    expect(res.status).toBe(400);
    expect(deletedKeys()).toHaveLength(0);
    expect(await mediaOf(exerciseId)).toMatchObject({ video_url: existing, video_thumbnail_url: existingPoster });
  });

  it('keeps the existing video when R2 rejects the upload (§9)', async () => {
    const existing = url(`${gymPrefix}/Exercises/Videos/${exerciseId}-Old.mp4`);
    await setVideo(exerciseId, existing, null);
    sendMock.mockRejectedValue(Object.assign(new Error('boom'), { name: 'NoSuchBucket' }));
    const res = await upload(exerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(502);
    expect(deletedKeys()).toHaveLength(0);
    expect(await mediaOf(exerciseId)).toMatchObject({ video_url: existing });
  });

  it('returns 503 when the deployment has no R2 configured', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    const res = await upload(exerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(503);
    expect(res.body.missingConfig).toContain('CLOUDFLARE_R2_BUCKET');
  });

  it('returns 409 when the gym’s bucket was never initialized', async () => {
    await db.query('UPDATE gyms SET storage_folder_prefix = NULL WHERE id = ?', [gymId]);
    try {
      const res = await upload(exerciseId, { video: VIDEO, poster: POSTER });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('videos');
      expect(putKeys()).toHaveLength(0);
    } finally {
      await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);
    }
  });
});

// ─── Replacement and ownership (#719 §9, §19) ─────────────────────────────────

describe('POST /exercises/:id/video — replacement', () => {
  it('deletes the gym-owned objects it replaced, after the row points at the new ones', async () => {
    const stale = url(`${gymPrefix}/Exercises/Videos/legacy.mp4`);
    const stalePoster = url(`${gymPrefix}/Exercises/Videos/legacy-thumbnail.png`);
    await setVideo(exerciseId, stale, stalePoster);
    const res = await upload(exerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toEqual([
      `${gymPrefix}/Exercises/Videos/legacy.mp4`,
      `${gymPrefix}/Exercises/Videos/legacy-thumbnail.png`,
    ]);
    expect(await mediaOf(exerciseId)).toMatchObject({
      video_url: url(videoKey),
      video_thumbnail_url: url(posterKey),
    });
  });

  it('never deletes a System object the exercise was imported with (§19)', async () => {
    await setVideo(exerciseId, url('cordel/Exercises/Videos/77-Barbell-Press.mp4'), url('cordel/Exercises/Videos/77-Barbell-Press-thumbnail.png'));
    const res = await upload(exerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('never deletes another gym’s object', async () => {
    await setVideo(exerciseId, url(`${otherGymPrefix}/Exercises/Videos/9-Press.mp4`), null);
    await upload(exerciseId, { video: VIDEO, poster: POSTER });
    expect(deletedKeys()).toHaveLength(0);
  });

  it('never deletes an external URL’s object', async () => {
    await setVideo(exerciseId, 'https://youtu.be/dQw4w9WgXcQ', null);
    await upload(exerciseId, { video: VIDEO, poster: POSTER });
    expect(deletedKeys()).toHaveLength(0);
  });

  it('keeps an object another exercise still references', async () => {
    const shared = url(`${gymPrefix}/Exercises/Videos/shared.mp4`);
    await setVideo(exerciseId, shared, null);
    await setVideo(secondExerciseId, shared, null);
    const res = await upload(exerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
    expect(await mediaOf(secondExerciseId)).toMatchObject({ video_url: shared });
  });

  it('keeps an object the exercise’s own image still references', async () => {
    const shared = url(`${gymPrefix}/Exercises/Videos/shared-thumbnail.png`);
    await setVideo(exerciseId, url(`${gymPrefix}/Exercises/Videos/old.mp4`), shared);
    await setImage(exerciseId, shared, null);
    const res = await upload(exerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toEqual([`${gymPrefix}/Exercises/Videos/old.mp4`]);
  });

  it('re-uploading the same exercise overwrites its own keys and deletes nothing', async () => {
    await upload(exerciseId, { video: VIDEO, poster: POSTER });
    sendMock.mockClear();
    const res = await upload(exerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(putKeys()).toEqual([videoKey, posterKey]);
    expect(deletedKeys()).toHaveLength(0);
  });
});

// ─── Removal (#719 §10) ───────────────────────────────────────────────────────

describe('DELETE /exercises/:id/video', () => {
  it('clears both references and deletes the gym’s own objects', async () => {
    await upload(exerciseId, { video: VIDEO, poster: POSTER });
    sendMock.mockClear();
    const res = await remove(exerciseId);
    expect(res.status).toBe(200);
    expect(res.body.video_url).toBeNull();
    expect(res.body.video_thumbnail_url).toBeNull();
    expect(await mediaOf(exerciseId)).toMatchObject({ video_url: null, video_thumbnail_url: null });
    expect(deletedKeys()).toEqual([videoKey, posterKey]);
  });

  it('does not fall back to the Base Exercise’s video (§10, §12)', async () => {
    await setVideo(baseExerciseId, url('cordel/Exercises/Videos/5-Base.mp4'), null);
    await db.query('UPDATE exercises SET cloned_from_id = ? WHERE id = ?', [baseExerciseId, exerciseId]);
    await upload(exerciseId, { video: VIDEO, poster: POSTER });
    const res = await remove(exerciseId);
    expect(res.status).toBe(200);
    expect(res.body.video_url).toBeNull();
    // Still System sourced — media never changes the source (§11).
    expect(Number(res.body.cloned_from_id)).toBe(baseExerciseId);
    await db.query('UPDATE exercises SET cloned_from_id = NULL WHERE id = ?', [exerciseId]);
  });

  it('clears a System reference without deleting the System object (§19)', async () => {
    const systemUrl = url('cordel/Exercises/Videos/77-Barbell-Press.mp4');
    await setVideo(exerciseId, systemUrl, null);
    const res = await remove(exerciseId);
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
    expect(await mediaOf(exerciseId)).toMatchObject({ video_url: null });
  });

  it('leaves the image pair alone (§10)', async () => {
    const imageUrl = url(`${gymPrefix}/Exercises/Images/${exerciseId}-Press.png`);
    await setImage(exerciseId, imageUrl, null);
    await upload(exerciseId, { video: VIDEO, poster: POSTER });
    sendMock.mockClear();
    const res = await remove(exerciseId);
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBe(imageUrl);
    expect(deletedKeys()).not.toContain(`${gymPrefix}/Exercises/Images/${exerciseId}-Press.png`);
  });

  it('works when the gym’s bucket was never initialized — the references are still the gym’s', async () => {
    await setVideo(exerciseId, 'https://youtu.be/dQw4w9WgXcQ', null);
    await db.query('UPDATE gyms SET storage_folder_prefix = NULL WHERE id = ?', [gymId]);
    try {
      const res = await remove(exerciseId);
      expect(res.status).toBe(200);
      expect(await mediaOf(exerciseId)).toMatchObject({ video_url: null });
      expect(deletedKeys()).toHaveLength(0);
    } finally {
      await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);
    }
  });

  it('returns 404 for another gym’s exercise', async () => {
    await setVideo(otherGymExerciseId, url(`${otherGymPrefix}/Exercises/Videos/1-X.mp4`), null);
    const res = await remove(otherGymExerciseId);
    expect(res.status).toBe(404);
    expect(deletedKeys()).toHaveLength(0);
  });
});

// ─── References the API exposes (#719 §13) ────────────────────────────────────

describe('exercise media references', () => {
  it('returns the gym’s own video after an override, not the library’s', async () => {
    await setVideo(baseExerciseId, url('cordel/Exercises/Videos/5-Base.mp4'), null);
    await db.query('UPDATE exercises SET cloned_from_id = ? WHERE id = ?', [baseExerciseId, exerciseId]);
    await upload(exerciseId, { video: VIDEO, poster: POSTER });

    const res = await request
      .get(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.video_url).toBe(url(videoKey));
    expect(res.body.video_thumbnail_url).toBe(url(posterKey));
    await db.query('UPDATE exercises SET cloned_from_id = NULL WHERE id = ?', [exerciseId]);
  });

  it('drops the poster when a PUT repoints video_url at an external link', async () => {
    await upload(exerciseId, { video: VIDEO, poster: POSTER });
    const res = await request
      .put(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ video_url: 'https://youtu.be/dQw4w9WgXcQ' });
    expect(res.status).toBe(200);
    expect(res.body.video_url).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(res.body.video_thumbnail_url).toBeNull();
  });

  it('keeps the poster when a PUT does not mention the video', async () => {
    await upload(exerciseId, { video: VIDEO, poster: POSTER });
    const res = await request
      .put(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ description: 'Unchanged media' });
    expect(res.status).toBe(200);
    expect(res.body.video_thumbnail_url).toBe(url(posterKey));
  });

  it('copies both references when an exercise is duplicated, without copying the objects (§2)', async () => {
    await upload(exerciseId, { video: VIDEO, poster: POSTER });
    sendMock.mockClear();
    const res = await request
      .post(`/exercises/${exerciseId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.video_url).toBe(url(videoKey));
    expect(res.body.video_thumbnail_url).toBe(url(posterKey));
    expect(putKeys()).toHaveLength(0);

    // And the shared objects survive the original removing its video.
    sendMock.mockClear();
    const removed = await remove(exerciseId);
    expect(removed.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
    await db.query('DELETE FROM exercises WHERE id = ?', [res.body.id]);
  });
});
