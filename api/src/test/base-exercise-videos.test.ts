// #717 — videos on a **Base Exercise**: the superadmin upload and remove routes
// (`POST`/`DELETE /platform/exercises/:id/video`), the references the API
// exposes, and the ownership rules that decide which R2 objects a platform
// operation may delete.
//
// Separate from platform-exercises.test.ts for the same reason
// base-exercise-images.test.ts is: this file mocks @aws-sdk/client-s3 and moves
// the CLOUDFLARE_R2_* env around.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
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

const BASE_NAME = 'Test Base Video Barbell Back Squat';
const SECOND_BASE_NAME = 'Test Base Video Cable Row, Seated';
const GYM_EXERCISE_NAME = 'Test Base Video Gym Owned Exercise';

const BASE_SLUG = 'Test-Base-Video-Barbell-Back-Squat';
const SECOND_BASE_SLUG = 'Test-Base-Video-Cable-Row-Seated';

const videoKey = (id: number, name: string) => `cordel/Exercises/Videos/${id}-${name}.mp4`;
const posterKey = (id: number, name: string) => `cordel/Exercises/Videos/${id}-${name}-thumbnail.png`;

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

async function setVideo(id: number, video: string | null, poster: string | null) {
  await db.query('UPDATE exercises SET video_url = ?, video_thumbnail_url = ? WHERE id = ?', [video, poster, id]);
}

async function setImage(id: number, image: string | null, thumbnail: string | null) {
  await db.query('UPDATE exercises SET image_url = ?, image_thumbnail_url = ? WHERE id = ?', [image, thumbnail, id]);
}

function upload(id: number | string, body: unknown) {
  return request
    .post(`/platform/exercises/${id}/video`)
    .set('Authorization', TEST_AUTH_HEADER)
    .send(body as any);
}

function remove(id: number | string) {
  return request
    .delete(`/platform/exercises/${id}/video`)
    .set('Authorization', TEST_AUTH_HEADER);
}

beforeAll(async () => {
  gymId = await createTestGym('BaseExerciseVideosGym');
  await createTestMembership(gymId, 'admin');
  const { rows } = await db.query<{ storage_folder_prefix: string | null }>(
    'SELECT storage_folder_prefix FROM gyms WHERE id = ?',
    [gymId],
  );
  gymPrefix = rows[0]?.storage_folder_prefix ?? `gyms/${gymId}-BaseExerciseVideosGym`;

  baseExerciseId = await createExercise(null, BASE_NAME);
  secondBaseExerciseId = await createExercise(null, SECOND_BASE_NAME);
  gymExerciseId = await createExercise(gymId, GYM_EXERCISE_NAME);
});

afterAll(async () => {
  await db.query("DELETE FROM exercises WHERE name LIKE 'Test Base Video %'");
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
    `UPDATE exercises SET video_url = NULL, video_thumbnail_url = NULL, image_url = NULL,
       image_thumbnail_url = NULL, name = ?, status = 'active' WHERE id = ?`,
    [BASE_NAME, baseExerciseId],
  );
  await db.query(
    `UPDATE exercises SET video_url = NULL, video_thumbnail_url = NULL, image_url = NULL,
       image_thumbnail_url = NULL, status = 'active' WHERE id IN (?, ?)`,
    [secondBaseExerciseId, gymExerciseId],
  );
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── Auth and scope ───────────────────────────────────────────────────────────

describe('POST /platform/exercises/:id/video — auth', () => {
  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/platform/exercises/${baseExerciseId}/video`)
      .send({ video: VIDEO, poster: POSTER });
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for an authenticated non-superadmin', async () => {
    mockAsNonSuperadmin();
    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });

  it("returns 404 for a gym's own exercise — its media is the gym's router's business", async () => {
    const res = await upload(gymExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
    expect(await mediaOf(gymExerciseId)).toMatchObject({ video_url: null, video_thumbnail_url: null });
  });

  it('returns 404 for an unknown exercise', async () => {
    const res = await upload(99999999, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 404 for a deleted base exercise', async () => {
    await db.query("UPDATE exercises SET status = 'deleted' WHERE id = ?", [baseExerciseId]);
    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 401 without auth on DELETE, and 403 for a non-superadmin', async () => {
    const anonymous = await request.delete(`/platform/exercises/${baseExerciseId}/video`);
    expect(anonymous.status).toBe(401);
    mockAsNonSuperadmin();
    const forbidden = await remove(baseExerciseId);
    expect(forbidden.status).toBe(403);
  });
});

// ─── Happy path (§1, §5) ──────────────────────────────────────────────────────

describe('POST /platform/exercises/:id/video', () => {
  it('stores both files under cordel/Exercises/Videos/ and persists both URLs', async () => {
    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);

    const video = videoKey(baseExerciseId, BASE_SLUG);
    const poster = posterKey(baseExerciseId, BASE_SLUG);
    expect(putKeys()).toEqual([video, poster]);
    for (const key of putKeys()) {
      expect(key.startsWith('cordel/')).toBe(true);
      expect(key).not.toContain('gyms/');
    }
    // The MP4 and its poster carry their own types — never the request's claim.
    expect(putCommands().map((c: any) => c.input.ContentType)).toEqual(['video/mp4', 'image/png']);
    expect(putCommands().every((c: any) => c.input.Bucket === R2_BUCKET)).toBe(true);

    expect(res.body.video_url).toBe(url(video));
    expect(res.body.video_thumbnail_url).toBe(url(poster));
    expect(await mediaOf(baseExerciseId)).toMatchObject({
      video_url: url(video),
      video_thumbnail_url: url(poster),
    });
  });

  it('writes the platform folder markers, never a gym tree', async () => {
    await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    const markers = sentCommands('put').map((c: any) => c.input.Key).filter((k: string) => k.endsWith('/'));
    expect(markers).toEqual(['cordel/', 'cordel/Exercises/', 'cordel/Exercises/Videos/']);
  });

  it('sanitizes the exercise name in both keys', async () => {
    const res = await upload(secondBaseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(putKeys()).toEqual([
      videoKey(secondBaseExerciseId, SECOND_BASE_SLUG),
      posterKey(secondBaseExerciseId, SECOND_BASE_SLUG),
    ]);
  });

  it('takes the key from the row, never from the uploaded file name', async () => {
    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER, filename: '../../evil.mp4' });
    expect(res.status).toBe(200);
    expect(putKeys()).toEqual([
      videoKey(baseExerciseId, BASE_SLUG),
      posterKey(baseExerciseId, BASE_SLUG),
    ]);
  });

  it('leaves the image pair untouched — the two kinds of media are independent', async () => {
    const image = url(`cordel/Exercises/Images/${baseExerciseId}-${BASE_SLUG}.png`);
    const thumbnail = url(`cordel/Exercises/Images/${baseExerciseId}-${BASE_SLUG}-thumbnail.png`);
    await setImage(baseExerciseId, image, thumbnail);

    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBe(image);
    expect(res.body.image_thumbnail_url).toBe(thumbnail);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('keeps the exercise otherwise untouched, and returns it in the list shape', async () => {
    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.body).toMatchObject({ id: baseExerciseId, name: BASE_NAME, status: 'active' });
    expect(res.body).toHaveProperty('muscles');
    expect(res.body).toHaveProperty('allowed_result_types');
  });

  it('replaces an external link with the uploaded object (Q5)', async () => {
    await setVideo(baseExerciseId, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', null);
    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(res.body.video_url).toBe(url(videoKey(baseExerciseId, BASE_SLUG)));
    expect(res.body.video_thumbnail_url).toBe(url(posterKey(baseExerciseId, BASE_SLUG)));
    // There was no object of ours behind the link, so nothing is deleted.
    expect(deletedKeys()).toHaveLength(0);
  });
});

// ─── Validation (§3, §6) ──────────────────────────────────────────────────────

describe('POST /platform/exercises/:id/video — validation', () => {
  beforeEach(async () => {
    // A video already there is what every rejection must leave alone (§6).
    await setVideo(
      baseExerciseId,
      url(videoKey(baseExerciseId, BASE_SLUG)),
      url(posterKey(baseExerciseId, BASE_SLUG)),
    );
  });

  async function expectRefused(body: unknown, status: number, reason?: string) {
    const before = await mediaOf(baseExerciseId);
    const res = await upload(baseExerciseId, body);
    expect(res.status).toBe(status);
    if (reason) expect(res.body.reason).toBe(reason);
    // Nothing uploaded, nothing deleted, nothing written (§6).
    expect(putKeys()).toHaveLength(0);
    expect(deletedKeys()).toHaveLength(0);
    expect(await mediaOf(baseExerciseId)).toEqual(before);
    return res;
  }

  it('refuses a request carrying only the video', async () => {
    await expectRefused({ video: VIDEO }, 400);
  });

  it('refuses a request carrying only the poster', async () => {
    await expectRefused({ poster: POSTER }, 400);
  });

  it('refuses a file that is not an MP4, whatever the request claimed', async () => {
    const notVideo = png(EXERCISE_VIDEO_POSTER_SIZE).toString('base64');
    const res = await expectRefused({ video: notVideo, poster: POSTER }, 400);
    expect(res.body).toMatchObject({ reason: 'not_an_mp4', file: 'video' });
  });

  it('refuses a QuickTime file renamed to .mp4', async () => {
    const mov = buildMp4({ majorBrand: 'qt  ', compatibleBrands: ['qt  '] }).toString('base64');
    await expectRefused({ video: mov, poster: POSTER }, 400, 'not_an_mp4');
  });

  it('refuses an audio-only MP4', async () => {
    const audio = buildMp4({ codecs: ['mp4a'] }).toString('base64');
    await expectRefused({ video: audio, poster: POSTER }, 400, 'no_video_track');
  });

  it('refuses a poster that is not 512×512, naming the poster', async () => {
    const res = await expectRefused({ video: VIDEO, poster: png(256).toString('base64') }, 400);
    expect(res.body).toMatchObject({ reason: 'wrong_size', file: 'poster' });
  });

  it('refuses a poster that is not a PNG', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]).toString('base64');
    await expectRefused({ video: VIDEO, poster: jpeg }, 400, 'not_a_png');
  });

  it('refuses a video over the configured ceiling with 413', async () => {
    const originalMax = process.env.EXERCISE_VIDEO_MAX_MB;
    process.env.EXERCISE_VIDEO_MAX_MB = '0.5';
    try {
      const big = buildMp4({ mdatBytes: 1024 * 1024 }).toString('base64');
      await expectRefused({ video: big, poster: POSTER }, 413, 'too_large');
    } finally {
      if (originalMax === undefined) delete process.env.EXERCISE_VIDEO_MAX_MB;
      else process.env.EXERCISE_VIDEO_MAX_MB = originalMax;
    }
  });

  it('refuses a non-string payload rather than treating it as bytes', async () => {
    await expectRefused({ video: { length: 10 }, poster: POSTER }, 400);
  });

  it('accepts a data: URL payload, taking the bytes after the comma', async () => {
    await setVideo(baseExerciseId, null, null);
    const res = await upload(baseExerciseId, {
      video: `data:video/mp4;base64,${VIDEO}`,
      poster: `data:image/png;base64,${POSTER}`,
    });
    expect(res.status).toBe(200);
    expect(putKeys()).toHaveLength(2);
  });

  it('answers 503 when the deployment has no Cloudflare configuration', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    const res = await expectRefused({ video: VIDEO, poster: POSTER }, 503);
    expect(res.body.missingConfig.length).toBeGreaterThan(0);
  });

  it('answers 502 and writes nothing when R2 refuses the upload', async () => {
    sendMock.mockRejectedValue(new Error('network down'));
    const before = await mediaOf(baseExerciseId);
    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(502);
    expect(await mediaOf(baseExerciseId)).toEqual(before);
  });
});

// ─── Replacement (§6) ─────────────────────────────────────────────────────────

describe('POST /platform/exercises/:id/video — replacement', () => {
  it('overwrites the same deterministic keys and deletes nothing', async () => {
    await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    sendMock.mockClear();
    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(putKeys()).toEqual([videoKey(baseExerciseId, BASE_SLUG), posterKey(baseExerciseId, BASE_SLUG)]);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('sweeps the objects at the old keys when the exercise was renamed since its last upload', async () => {
    await setVideo(baseExerciseId, url(videoKey(baseExerciseId, 'Old-Name')), url(posterKey(baseExerciseId, 'Old-Name')));

    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(deletedKeys().sort()).toEqual([
      videoKey(baseExerciseId, 'Old-Name'),
      posterKey(baseExerciseId, 'Old-Name'),
    ].sort());
    expect(await mediaOf(baseExerciseId)).toMatchObject({
      video_url: url(videoKey(baseExerciseId, BASE_SLUG)),
      video_thumbnail_url: url(posterKey(baseExerciseId, BASE_SLUG)),
    });
  });

  it("never deletes a gym's object, whatever the row points at", async () => {
    await setVideo(baseExerciseId, url(`${gymPrefix}/Exercises/Videos/${baseExerciseId}-Old-Name.mp4`), null);
    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('never deletes an object the exercise still uses as its image', async () => {
    // The two kinds of media can share an object — a duplicate, a clone or an
    // import copies *references* — so the image pair is kept while the video
    // pair is swept.
    const shared = url(`cordel/Exercises/Images/${baseExerciseId}-${BASE_SLUG}.png`);
    await setVideo(baseExerciseId, url(videoKey(baseExerciseId, 'Old-Name')), shared);
    await setImage(baseExerciseId, shared, null);

    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toEqual([videoKey(baseExerciseId, 'Old-Name')]);
    expect((await mediaOf(baseExerciseId)).image_url).toBe(shared);
  });

  it("leaves a stale object alone while a gym's imported exercise still references it", async () => {
    const shared = url(videoKey(baseExerciseId, 'Old-Name'));
    await setVideo(baseExerciseId, shared, null);
    // `POST /exercises/import` copies media *references*, so a gym's copy points
    // at the platform's own object (#719 §2).
    await setVideo(gymExerciseId, shared, null);

    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
    expect((await mediaOf(gymExerciseId)).video_url).toBe(shared);
  });

  it("leaves a stale poster alone while another row references it as its image thumbnail", async () => {
    // All four columns are read before an object is swept, because a duplicate,
    // a clone or an import shares references across the two kinds of media.
    const shared = url(posterKey(baseExerciseId, 'Old-Name'));
    await setVideo(baseExerciseId, url(videoKey(baseExerciseId, 'Old-Name')), shared);
    await setImage(secondBaseExerciseId, null, shared);

    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    expect(res.status).toBe(200);
    expect(deletedKeys()).toEqual([videoKey(baseExerciseId, 'Old-Name')]);
  });
});

// ─── Removal (§7) ─────────────────────────────────────────────────────────────

describe('DELETE /platform/exercises/:id/video', () => {
  beforeEach(async () => {
    await setVideo(
      baseExerciseId,
      url(videoKey(baseExerciseId, BASE_SLUG)),
      url(posterKey(baseExerciseId, BASE_SLUG)),
    );
  });

  it('clears both references and deletes both objects', async () => {
    const res = await remove(baseExerciseId);
    expect(res.status).toBe(200);
    expect(res.body.video_url).toBeNull();
    expect(res.body.video_thumbnail_url).toBeNull();
    expect(await mediaOf(baseExerciseId)).toMatchObject({ video_url: null, video_thumbnail_url: null });
    expect(deletedKeys().sort()).toEqual([
      videoKey(baseExerciseId, BASE_SLUG),
      posterKey(baseExerciseId, BASE_SLUG),
    ].sort());
  });

  it('leaves the exercise otherwise unchanged, image included (§7)', async () => {
    const image = url(`cordel/Exercises/Images/${baseExerciseId}-${BASE_SLUG}.png`);
    await setImage(baseExerciseId, image, null);
    const res = await remove(baseExerciseId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: baseExerciseId, name: BASE_NAME, status: 'active', image_url: image });
    expect(deletedKeys()).not.toContain(`cordel/Exercises/Images/${baseExerciseId}-${BASE_SLUG}.png`);
  });

  it('leaves the objects alone while a gym exercise still references them', async () => {
    await setVideo(gymExerciseId, url(videoKey(baseExerciseId, BASE_SLUG)), url(posterKey(baseExerciseId, BASE_SLUG)));
    const res = await remove(baseExerciseId);
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
    expect(await mediaOf(baseExerciseId)).toMatchObject({ video_url: null, video_thumbnail_url: null });
  });

  it('is a no-op on an exercise that has no video', async () => {
    await setVideo(baseExerciseId, null, null);
    const res = await remove(baseExerciseId);
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('clears an external link without deleting anything', async () => {
    await setVideo(baseExerciseId, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', null);
    const res = await remove(baseExerciseId);
    expect(res.status).toBe(200);
    expect(res.body.video_url).toBeNull();
    expect(deletedKeys()).toHaveLength(0);
  });

  it("returns 404 for a gym's own exercise and leaves its media in place", async () => {
    await setVideo(gymExerciseId, url(`${gymPrefix}/Exercises/Videos/${gymExerciseId}-Gym.mp4`), null);
    const res = await remove(gymExerciseId);
    expect(res.status).toBe(404);
    expect(deletedKeys()).toHaveLength(0);
    expect((await mediaOf(gymExerciseId)).video_url).not.toBeNull();
  });

  it('does not fall back to any other video afterwards (#719 §12)', async () => {
    await remove(baseExerciseId);
    const res = await request
      .get(`/platform/exercises/${baseExerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.video_url).toBeNull();
    expect(res.body.video_thumbnail_url).toBeNull();
  });
});

// ─── The references the API exposes (§10, §11) ────────────────────────────────

describe('GET /platform/exercises — video references', () => {
  it('returns both references on the list and the single-exercise shapes', async () => {
    await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    const list = await request
      .get('/platform/exercises?q=Test Base Video Barbell')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(list.status).toBe(200);
    const row = list.body.find((e: any) => e.id === baseExerciseId);
    expect(row.video_url).toBe(url(videoKey(baseExerciseId, BASE_SLUG)));
    expect(row.video_thumbnail_url).toBe(url(posterKey(baseExerciseId, BASE_SLUG)));
  });

  it('returns nulls for an exercise with no video, rather than omitting the fields', async () => {
    const res = await request
      .get(`/platform/exercises/${baseExerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.video_url).toBeNull();
    expect(res.body.video_thumbnail_url).toBeNull();
  });

  it('exposes the URL rather than proxying the bytes (§10)', async () => {
    const res = await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    // The whole object URL, compared exactly rather than by prefix: a
    // `startsWith(endpoint)` test passes for any host that merely begins with
    // this one (CodeQL `js/incomplete-url-substring-sanitization`), and the
    // point here is that the response carries the R2 URL the browser will
    // stream from — while the response itself is JSON, not the MP4's bytes.
    expect(res.body.video_url).toBe(url(videoKey(baseExerciseId, BASE_SLUG)));
    expect(res.headers['content-type']).toContain('application/json');
  });
});

// ─── A PUT that repoints video_url drops the poster it no longer belongs to ───

describe('PUT /platform/exercises/:id — video_url', () => {
  it('clears the poster when the video reference is repointed at a link', async () => {
    await upload(baseExerciseId, { video: VIDEO, poster: POSTER });
    const res = await request
      .put(`/platform/exercises/${baseExerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(res.status).toBe(200);
    expect(res.body.video_url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(res.body.video_thumbnail_url).toBeNull();
  });
});
