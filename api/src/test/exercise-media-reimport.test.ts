// #719 part 3 — importing and **re-importing** a Base Exercise's media (§2, §3,
// §12, §19, §24).
//
// Separate from exercises.test.ts for the same reason gym-exercise-images.test.ts
// is: this file mocks @aws-sdk/client-s3 and moves the CLOUDFLARE_R2_* env
// around, so the ownership-aware cleanup a re-import performs can be observed.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

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

const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

function sentCommands(type: 'put' | 'delete') {
  return sendMock.mock.calls.map(([command]) => command).filter((c: any) => c?.__type === type);
}

/** The folder markers `ensureStorageFolders()` writes end in `/`; the files do not. */
function putKeys(): string[] {
  return sentCommands('put').map((c: any) => c.input.Key).filter((key: string) => !key.endsWith('/'));
}

function deletedKeys(): string[] {
  return sentCommands('delete').map((c: any) => c.input.Key);
}

const GYM_NAME = 'ExerciseReimportGym';
const OTHER_GYM_NAME = 'ExerciseReimportOtherGym';
const NAME_PREFIX = 'Zz719p3 ';

const SYSTEM_IMAGE = url('cordel/Exercises/Images/901-System-Press.png');
const SYSTEM_THUMB = url('cordel/Exercises/Images/901-System-Press-thumbnail.png');
const SYSTEM_VIDEO = url('cordel/Exercises/Videos/901-System-Press.mp4');
const SYSTEM_POSTER = url('cordel/Exercises/Videos/901-System-Press-thumbnail.png');

let gymId: string;
let gymPrefix: string;
let otherGymId: string;
const baseIds: number[] = [];

interface Media {
  image_url: string | null;
  image_thumbnail_url: string | null;
  video_url: string | null;
  video_thumbnail_url: string | null;
}

const NO_MEDIA: Media = { image_url: null, image_thumbnail_url: null, video_url: null, video_thumbnail_url: null };

async function createBaseExercise(name: string, media: Partial<Media> = {}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO exercises (gym_id, name, status, image_url, image_thumbnail_url, video_url, video_thumbnail_url)
     VALUES (NULL, ?, 'active', ?, ?, ?, ?)`,
    [name, media.image_url ?? null, media.image_thumbnail_url ?? null, media.video_url ?? null, media.video_thumbnail_url ?? null],
  );
  baseIds.push(insertId);
  return insertId;
}

async function setMedia(id: number, media: Partial<Media>) {
  await db.query(
    `UPDATE exercises SET image_url = ?, image_thumbnail_url = ?, video_url = ?, video_thumbnail_url = ? WHERE id = ?`,
    [media.image_url ?? null, media.image_thumbnail_url ?? null, media.video_url ?? null, media.video_thumbnail_url ?? null, id],
  );
}

async function mediaOf(id: number): Promise<Media> {
  const { rows } = await db.query<Media>(
    'SELECT image_url, image_thumbnail_url, video_url, video_thumbnail_url FROM exercises WHERE id = ?',
    [id],
  );
  return rows[0];
}

function importIds(ids: number[], gym = gymId) {
  return request
    .post('/exercises/import')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gym)
    .send({ baseExerciseIds: ids });
}

function listBase(gym = gymId) {
  return request.get('/exercises/base').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
}

/** The gym's own copy of a base exercise, as `POST /exercises/import` creates it. */
async function importOnce(baseId: number): Promise<number> {
  const res = await importIds([baseId]);
  expect(res.status).toBe(201);
  expect(res.body.imported).toHaveLength(1);
  return Number(res.body.imported[0].id);
}

const gymKey = (leaf: string) => `${gymPrefix}/Exercises/${leaf}`;

beforeAll(async () => {
  gymId = await createTestGym(GYM_NAME);
  await createTestMembership(gymId, 'admin');
  gymPrefix = `gyms/${gymId}-${GYM_NAME}`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);

  otherGymId = await createTestGym(OTHER_GYM_NAME);
  await createTestMembership(otherGymId, 'admin');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${otherGymId}-${OTHER_GYM_NAME}`, otherGymId]);
});

afterAll(async () => {
  if (baseIds.length > 0) {
    const marks = baseIds.map(() => '?').join(',');
    await db.query(`DELETE FROM exercise_muscles WHERE exercise_id IN (${marks})`, baseIds);
    await db.query(`DELETE FROM exercise_allowed_result_types WHERE exercise_id IN (${marks})`, baseIds);
    await db.query(`DELETE FROM exercises WHERE cloned_from_id IN (${marks})`, baseIds);
    await db.query(`DELETE FROM exercises WHERE id IN (${marks})`, baseIds);
  }
  await db.query(`DELETE FROM exercises WHERE name LIKE '${NAME_PREFIX}%'`);
  await cleanupTestGyms();
  for (const key of R2_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await db.end();
});

beforeEach(() => {
  setStorageConfigured();
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── Import copies references only (#719 §2, §3, §24) ─────────────────────────

describe('POST /exercises/import — media references', () => {
  it('copies the Base Exercise’s image and video references and uploads nothing', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Import Both`, {
      image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB,
      video_url: SYSTEM_VIDEO, video_thumbnail_url: SYSTEM_POSTER,
    });
    const res = await importIds([baseId]);
    expect(res.status).toBe(201);
    expect(res.body.imported[0]).toMatchObject({
      image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB,
      video_url: SYSTEM_VIDEO, video_thumbnail_url: SYSTEM_POSTER,
    });
    // §2: the System objects stay where they are — no copy into the gym's folder.
    expect(putKeys()).toHaveLength(0);
    expect(deletedKeys()).toHaveLength(0);
    // §11: media has nothing to do with provenance.
    expect(Number(res.body.imported[0].cloned_from_id)).toBe(baseId);
    expect(res.body.refreshed).toEqual([]);
  });

  it('imports an exercise with no media as an exercise with no media', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Import Bare`);
    const res = await importIds([baseId]);
    expect(res.body.imported[0]).toMatchObject(NO_MEDIA);
  });

  it('does not follow the Base Exercise’s later media edits (§3 snapshot)', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Snapshot`, { image_url: SYSTEM_IMAGE });
    const copyId = await importOnce(baseId);
    const newSystemImage = url('cordel/Exercises/Images/901-System-Press-v2.png');
    await setMedia(baseId, { image_url: newSystemImage });
    expect((await mediaOf(copyId)).image_url).toBe(SYSTEM_IMAGE);
  });
});

// ─── Re-import restores the current System media (#719 §12) ───────────────────

describe('POST /exercises/import — re-import restores System media', () => {
  it('refreshes a copy whose media the gym replaced, and deletes the gym’s own objects', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Gym Override`, {
      image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB,
    });
    const copyId = await importOnce(baseId);
    // The gym uploads its own image over the System one (part 1's route).
    await setMedia(copyId, {
      image_url: url(gymKey('Images/9-Gym-Press.png')),
      image_thumbnail_url: url(gymKey('Images/9-Gym-Press-thumbnail.png')),
    });
    sendMock.mockClear();

    const res = await importIds([baseId]);
    expect(res.status).toBe(201);
    expect(res.body.imported).toEqual([]);
    expect(res.body.skipped).toEqual([]);
    expect(res.body.refreshed).toEqual([
      { id: baseId, name: `${NAME_PREFIX}Gym Override`, exercise_id: copyId, image_refreshed: true, video_refreshed: false },
    ]);
    expect(await mediaOf(copyId)).toMatchObject({ image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB });
    // The gym's own replaced objects go; nothing is uploaded (§19).
    expect(deletedKeys().sort()).toEqual([
      gymKey('Images/9-Gym-Press.png'), gymKey('Images/9-Gym-Press-thumbnail.png'),
    ].sort());
    expect(putKeys()).toHaveLength(0);
  });

  it('never deletes the System object it is restoring, nor another gym’s', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Foreign Object`, { image_url: SYSTEM_IMAGE });
    const copyId = await importOnce(baseId);
    const foreignObject = url(`gyms/${otherGymId}-${OTHER_GYM_NAME}/Exercises/Images/7-Theirs.png`);
    await setMedia(copyId, { image_url: foreignObject, image_thumbnail_url: 'https://cdn.example.com/external.png' });
    sendMock.mockClear();

    const res = await importIds([baseId]);
    expect(res.status).toBe(201);
    expect(res.body.refreshed).toHaveLength(1);
    expect((await mediaOf(copyId)).image_url).toBe(SYSTEM_IMAGE);
    // Neither the other gym's object, nor an external URL, nor the System object.
    expect(deletedKeys()).toHaveLength(0);
  });

  it('leaves a gym-owned object another exercise still references in place', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Shared Object`, { image_url: SYSTEM_IMAGE });
    const copyId = await importOnce(baseId);
    const sharedObject = url(gymKey('Images/11-Shared.png'));
    await setMedia(copyId, { image_url: sharedObject });
    const { insertId: siblingId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status, image_url) VALUES (?, ?, 'active', ?)`,
      [gymId, `${NAME_PREFIX}Sibling Sharing Object`, sharedObject],
    );
    sendMock.mockClear();

    await importIds([baseId]);
    expect(deletedKeys()).toHaveLength(0);
    expect((await mediaOf(siblingId)).image_url).toBe(sharedObject);
  });

  it('restores the video pair and its poster independently of the image', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Video Only Base`, {
      video_url: SYSTEM_VIDEO, video_thumbnail_url: SYSTEM_POSTER,
    });
    const copyId = await importOnce(baseId);
    const gymImage = url(gymKey('Images/13-Gym-Own.png'));
    await setMedia(copyId, {
      image_url: gymImage,
      video_url: url(gymKey('Videos/13-Gym-Clip.mp4')),
      video_thumbnail_url: url(gymKey('Videos/13-Gym-Clip-thumbnail.png')),
    });
    sendMock.mockClear();

    const res = await importIds([baseId]);
    expect(res.body.refreshed[0]).toMatchObject({ image_refreshed: false, video_refreshed: true });
    expect(await mediaOf(copyId)).toMatchObject({
      // The Base Exercise has no image, so the gym's own image is untouched.
      image_url: gymImage,
      video_url: SYSTEM_VIDEO,
      video_thumbnail_url: SYSTEM_POSTER,
    });
    expect(deletedKeys().sort()).toEqual([
      gymKey('Videos/13-Gym-Clip.mp4'), gymKey('Videos/13-Gym-Clip-thumbnail.png'),
    ].sort());
  });

  it('does not clear a gym upload when the Base Exercise has no media at all', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Bare Base`);
    const copyId = await importOnce(baseId);
    const gymMedia = {
      image_url: url(gymKey('Images/15-Gym.png')),
      image_thumbnail_url: url(gymKey('Images/15-Gym-thumbnail.png')),
    };
    await setMedia(copyId, gymMedia);
    sendMock.mockClear();

    const res = await importIds([baseId]);
    expect(res.status).toBe(201);
    expect(res.body.refreshed).toEqual([]);
    expect(res.body.skipped[0]).toMatchObject({ id: baseId, reason: 'already_imported', exercise_id: copyId });
    expect(await mediaOf(copyId)).toMatchObject(gymMedia);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('restores media the gym removed outright (no fallback, re-import is the way back)', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Removed Media`, {
      image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB,
    });
    const copyId = await importOnce(baseId);
    await setMedia(copyId, NO_MEDIA);
    const res = await importIds([baseId]);
    expect(res.body.refreshed).toHaveLength(1);
    expect(await mediaOf(copyId)).toMatchObject({ image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB });
    expect(deletedKeys()).toHaveLength(0);
  });

  it('picks up the Base Exercise’s *current* media, not the ones imported earlier', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Base Updated`, { image_url: SYSTEM_IMAGE });
    const copyId = await importOnce(baseId);
    const newSystemImage = url('cordel/Exercises/Images/902-System-Press.png');
    const newSystemThumb = url('cordel/Exercises/Images/902-System-Press-thumbnail.png');
    await setMedia(baseId, { image_url: newSystemImage, image_thumbnail_url: newSystemThumb });

    const res = await importIds([baseId]);
    expect(res.body.refreshed).toHaveLength(1);
    expect(await mediaOf(copyId)).toMatchObject({ image_url: newSystemImage, image_thumbnail_url: newSystemThumb });
  });

  it('skips a copy that already carries the current System media', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Already Current`, {
      image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB,
      video_url: SYSTEM_VIDEO, video_thumbnail_url: SYSTEM_POSTER,
    });
    await importOnce(baseId);
    const res = await importIds([baseId]);
    expect(res.status).toBe(201);
    expect(res.body.refreshed).toEqual([]);
    expect(res.body.skipped[0]).toMatchObject({ reason: 'already_imported' });
    expect(deletedKeys()).toHaveLength(0);
  });

  it('refreshes media without touching provenance, name, description or defaults', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Edited Copy`, { image_url: SYSTEM_IMAGE });
    const copyId = await importOnce(baseId);
    await db.query(
      `UPDATE exercises SET name = ?, description = 'gym wording', sets_default = 7, image_url = ? WHERE id = ?`,
      [`${NAME_PREFIX}Edited Copy Renamed`, url(gymKey('Images/17-Gym.png')), copyId],
    );
    await db.query('UPDATE exercises SET description = ?, sets_default = 2 WHERE id = ?', ['base wording', baseId]);

    // Matched by provenance, not by name — the gym renamed its copy.
    const res = await importIds([baseId]);
    expect(res.body.refreshed).toHaveLength(1);
    const { rows } = await db.query(
      'SELECT name, description, sets_default, cloned_from_id, image_url FROM exercises WHERE id = ?',
      [copyId],
    );
    expect(rows[0]).toMatchObject({
      name: `${NAME_PREFIX}Edited Copy Renamed`,
      description: 'gym wording',
      sets_default: 7,
      image_url: SYSTEM_IMAGE,
    });
    expect(Number(rows[0].cloned_from_id)).toBe(baseId);
  });

  it('refreshes a same-named copy that carries no provenance, without claiming it', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Legacy Name`, { image_url: SYSTEM_IMAGE });
    const { insertId: legacyId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, ?, 'active')`,
      [gymId, `${NAME_PREFIX}Legacy Name`],
    );
    const res = await importIds([baseId]);
    expect(res.body.imported).toEqual([]);
    expect(res.body.refreshed[0]).toMatchObject({ exercise_id: legacyId, image_refreshed: true });
    const { rows } = await db.query('SELECT image_url, cloned_from_id FROM exercises WHERE id = ?', [legacyId]);
    // The media is restored; the row stays Custom — a re-import is not a claim of provenance.
    expect(rows[0].image_url).toBe(SYSTEM_IMAGE);
    expect(rows[0].cloned_from_id).toBeNull();
  });

  it('imports and refreshes in the same request', async () => {
    const freshId = await createBaseExercise(`${NAME_PREFIX}Mixed Fresh`, { image_url: SYSTEM_IMAGE });
    const heldId = await createBaseExercise(`${NAME_PREFIX}Mixed Held`, { image_url: SYSTEM_IMAGE });
    const bareId = await createBaseExercise(`${NAME_PREFIX}Mixed Bare`);
    const heldCopy = await importOnce(heldId);
    await importOnce(bareId);
    await setMedia(heldCopy, { image_url: url(gymKey('Images/19-Gym.png')) });

    const res = await importIds([freshId, heldId, bareId]);
    expect(res.status).toBe(201);
    expect(res.body.imported).toHaveLength(1);
    expect(res.body.imported[0].cloned_from_id).toBe(freshId);
    expect(res.body.refreshed.map((r: any) => r.id)).toEqual([heldId]);
    expect(res.body.skipped.map((r: any) => r.id)).toEqual([bareId]);
  });

  it('refreshes the requesting gym’s copy only (tenant isolation)', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Two Gyms`, { image_url: SYSTEM_IMAGE });
    const mine = await importOnce(baseId);
    const theirsRes = await importIds([baseId], otherGymId);
    const theirs = Number(theirsRes.body.imported[0].id);
    const theirGymObject = url(`gyms/${otherGymId}-${OTHER_GYM_NAME}/Exercises/Images/21-Theirs.png`);
    await setMedia(mine, { image_url: url(gymKey('Images/21-Mine.png')) });
    await setMedia(theirs, { image_url: theirGymObject });
    sendMock.mockClear();

    const res = await importIds([baseId]);
    expect(res.body.refreshed.map((r: any) => r.exercise_id)).toEqual([mine]);
    expect((await mediaOf(theirs)).image_url).toBe(theirGymObject);
    expect(deletedKeys()).toEqual([gymKey('Images/21-Mine.png')]);
  });

  it('records the refresh in the audit log as an update to the gym’s exercise', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Audited`, { image_url: SYSTEM_IMAGE });
    const copyId = await importOnce(baseId);
    await setMedia(copyId, { image_url: url(gymKey('Images/23-Gym.png')) });
    await importIds([baseId]);
    // recordAudit() is fire-and-forget; give the insert a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const { rows } = await db.query(
      `SELECT action, previous_values, new_values FROM audit_logs
        WHERE gym_id = ? AND entity_type = 'exercise' AND entity_id = ? AND action = 'update'
        ORDER BY id DESC LIMIT 1`,
      [gymId, copyId],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].new_values)).toContain(SYSTEM_IMAGE);
    expect(JSON.stringify(rows[0].previous_values)).toContain(gymKey('Images/23-Gym.png'));
  });
});

// ─── GET /exercises/base advertises what a re-import would do (§12) ───────────

describe('GET /exercises/base — media_refreshable', () => {
  it('is false for a row the gym has not imported', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Flag Fresh`, { image_url: SYSTEM_IMAGE });
    const row = (await listBase()).body.find((r: any) => r.id === baseId);
    expect(row).toMatchObject({ imported_exercise_id: null, media_refreshable: false });
    expect(row.image_url).toBe(SYSTEM_IMAGE);
  });

  it('is false for a copy that already carries the current System media', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Flag Current`, {
      image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB,
    });
    const copyId = await importOnce(baseId);
    const row = (await listBase()).body.find((r: any) => r.id === baseId);
    expect(row).toMatchObject({ imported_exercise_id: copyId, media_refreshable: false });
  });

  it('is true once the gym replaces the media, and false again after a re-import', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Flag Roundtrip`, {
      image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB,
    });
    const copyId = await importOnce(baseId);
    await setMedia(copyId, { image_url: url(gymKey('Images/25-Gym.png')) });
    expect((await listBase()).body.find((r: any) => r.id === baseId).media_refreshable).toBe(true);

    await importIds([baseId]);
    expect((await listBase()).body.find((r: any) => r.id === baseId).media_refreshable).toBe(false);
  });

  it('is false when the Base Exercise has no media to restore', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Flag Bare Base`);
    const copyId = await importOnce(baseId);
    await setMedia(copyId, { image_url: url(gymKey('Images/27-Gym.png')) });
    expect((await listBase()).body.find((r: any) => r.id === baseId).media_refreshable).toBe(false);
  });

  it('is true when only the video pair moved', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Flag Video`, {
      image_url: SYSTEM_IMAGE, video_url: SYSTEM_VIDEO, video_thumbnail_url: SYSTEM_POSTER,
    });
    const copyId = await importOnce(baseId);
    await setMedia(copyId, { image_url: SYSTEM_IMAGE, video_url: url(gymKey('Videos/29-Gym.mp4')) });
    expect((await listBase()).body.find((r: any) => r.id === baseId).media_refreshable).toBe(true);
  });

  it('answers per gym', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Flag Per Gym`, { image_url: SYSTEM_IMAGE });
    const copyId = await importOnce(baseId);
    await setMedia(copyId, { image_url: url(gymKey('Images/31-Gym.png')) });
    expect((await listBase()).body.find((r: any) => r.id === baseId).media_refreshable).toBe(true);
    // The other gym has no copy at all, so nothing to refresh.
    const theirRow = (await listBase(otherGymId)).body.find((r: any) => r.id === baseId);
    expect(theirRow).toMatchObject({ imported_exercise_id: null, media_refreshable: false });
  });

  it('exposes every media reference the modal may need', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Flag References`, {
      image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB,
      video_url: SYSTEM_VIDEO, video_thumbnail_url: SYSTEM_POSTER,
    });
    const row = (await listBase()).body.find((r: any) => r.id === baseId);
    expect(row).toMatchObject({
      image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB,
      video_url: SYSTEM_VIDEO, video_thumbnail_url: SYSTEM_POSTER,
    });
  });
});
