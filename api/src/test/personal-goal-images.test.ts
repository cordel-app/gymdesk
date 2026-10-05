// #1035 stage 2 — a **Personal Goal's image**: the gym-facing routes
// (`POST`/`DELETE /personal-goals/:id/image`), the platform pair
// (`/platform/personal-goals/:id/image`), the keys each lands under, and the
// objects each side may and may not delete.
//
// Separate from goal-library.test.ts and platform-goal-library.test.ts for the
// same reason base-nutrition-images.test.ts is separate from
// platform-nutrition-library.test.ts: this file mocks @aws-sdk/client-s3 and
// moves the CLOUDFLARE_R2_* env around.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { encodePngRgba } from '../domain/pngImage';
import {
  PERSONAL_GOAL_IMAGE_MAX_BYTES,
  PERSONAL_GOAL_IMAGE_MAX_SIZE,
} from '../domain/personalGoalImages';

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

/** A valid upload: PNG, at most 512×512. */
function validPng(size = PERSONAL_GOAL_IMAGE_MAX_SIZE): Buffer {
  return encodePngRgba(size, size, Buffer.alloc(size * size * 4, 0x40));
}

/**
 * A PNG whose IHDR claims `width × height` with no alpha channel — colour type
 * 2. Used both for "over the ceiling" and for "opaque", which this feature
 * accepts (#1035 `Q3`: no alpha requirement).
 */
function opaquePng(width: number, height = width): Buffer {
  const png = Buffer.from(validPng(1));
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png[25] = 2;
  return png;
}

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

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

/** Object puts only — the folder markers end in `/` and are asserted separately. */
function putKeys(): string[] {
  return sentCommands('put').map((c: any) => c.input.Key as string).filter((key) => !key.endsWith('/'));
}

function markerKeys(): string[] {
  return sentCommands('put').map((c: any) => c.input.Key as string).filter((key) => key.endsWith('/'));
}

function deletedKeys(): string[] {
  return sentCommands('delete').map((c: any) => c.input.Key as string);
}

const GOAL_NAME = 'Test Goal Image Marathon Ready';
const SANITIZED = 'Test-Goal-Image-Marathon-Ready';
const PREFIX_SUFFIX = 'PersonalGoalImagesGym';

let gymId: string;
let gymPrefix: string;
let otherGymId: string;
let otherGymPrefix: string;
let noBucketGymId: string;
let frontDeskGymId: string;
let goalId: number;
let otherGymGoalId: number;
let noBucketGoalId: number;
let frontDeskGoalId: number;
let systemGoalId: number;
let nutritionGoalId: number;

async function createGoal(gym: string | null, name: string): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO personal_goals (gym_id, name, status) VALUES (?, ?, 'active')",
    [gym, name],
  );
  return insertId as number;
}

async function imageUrlOf(id: number, table = 'personal_goals'): Promise<string | null> {
  const { rows } = await db.query<{ image_url: string | null }>(
    `SELECT image_url FROM ${table} WHERE id = ?`,
    [id],
  );
  return rows[0]?.image_url ?? null;
}

function upload(path: string, gym: string | null, body: Buffer, contentType = 'image/png') {
  const req = request.post(path).set('Authorization', TEST_AUTH_HEADER).set('Content-Type', contentType);
  if (gym) req.set('x-gym-id', gym);
  return req.send(body);
}

function remove(path: string, gym: string | null) {
  const req = request.delete(path).set('Authorization', TEST_AUTH_HEADER);
  if (gym) req.set('x-gym-id', gym);
  return req.send();
}

const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

beforeAll(async () => {
  gymId = await createTestGym(PREFIX_SUFFIX);
  await createTestMembership(gymId, 'admin');
  gymPrefix = `gyms/${gymId}-${PREFIX_SUFFIX}`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);

  otherGymId = await createTestGym('PersonalGoalImagesOther');
  await createTestMembership(otherGymId, 'admin');
  otherGymPrefix = `gyms/${otherGymId}-PersonalGoalImagesOther`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [otherGymPrefix, otherGymId]);

  // Deliberately left with no `storage_folder_prefix`: an upload there is the 409.
  noBucketGymId = await createTestGym('PersonalGoalImagesNoBucket');
  await createTestMembership(noBucketGymId, 'admin');

  // front_desk has 'R' on NUTRITION, so every write is a 403.
  frontDeskGymId = await createTestGym('PersonalGoalImagesFrontDesk');
  await createTestMembership(frontDeskGymId, 'front_desk');

  goalId = await createGoal(gymId, GOAL_NAME);
  otherGymGoalId = await createGoal(otherGymId, 'Test Goal Image Other Gym');
  noBucketGoalId = await createGoal(noBucketGymId, 'Test Goal Image No Bucket');
  frontDeskGoalId = await createGoal(frontDeskGymId, 'Test Goal Image Front Desk');
  systemGoalId = await createGoal(null, 'Test Goal Image System Owned');

  const { rows } = await db.query<{ id: number }>(
    "SELECT id FROM nutrition_goals WHERE gym_id IS NULL AND slug = 'protein'",
  );
  nutritionGoalId = rows[0].id;
});

afterAll(async () => {
  await db.query("DELETE FROM personal_goals WHERE name LIKE 'Test Goal Image %'");
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
    "UPDATE personal_goals SET image_url = NULL, name = ?, status = 'active' WHERE id = ?",
    [GOAL_NAME, goalId],
  );
  await db.query(
    "UPDATE personal_goals SET image_url = NULL, status = 'active' WHERE id IN (?, ?, ?, ?)",
    [otherGymGoalId, noBucketGoalId, frontDeskGoalId, systemGoalId],
  );
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── Auth and ownership (the gym route) ──────────────────────────────────────

describe('POST /personal-goals/:id/image — auth and ownership', () => {
  it('returns 401 without auth, and uploads nothing', async () => {
    const res = await request
      .post(`/personal-goals/${goalId}/image`)
      .set('Content-Type', 'image/png')
      .send(validPng());
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for a read-only role', async () => {
    // The Clerk user is mocked as a **superadmin** for the `/platform/*` half of
    // this file, and `tenantContext` gives a superadmin full admin on any gym it
    // is handed — so the `front_desk` membership only decides anything once the
    // caller is an ordinary user. Without this the case reached the handler and
    // read as a 409 (that gym has no `storage_folder_prefix`), which is a pass
    // for the wrong reason: the prefix below removes that second explanation, so
    // a regression in `requireWrite` shows up as a 200 rather than as a 409.
    mockAsNonSuperadmin();
    await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [
      `gyms/${frontDeskGymId}-PersonalGoalImagesFrontDesk`, frontDeskGymId,
    ]);
    const res = await upload(`/personal-goals/${frontDeskGoalId}/image`, frontDeskGymId, validPng());
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
    expect(await imageUrlOf(frontDeskGoalId)).toBeNull();
  });

  it('returns 403 for a System goal — Cordel administers those', async () => {
    const res = await upload(`/personal-goals/${systemGoalId}/image`, gymId, validPng());
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
    expect(await imageUrlOf(systemGoalId)).toBeNull();
  });

  it("returns 404 for another gym's goal, and writes nothing", async () => {
    const res = await upload(`/personal-goals/${otherGymGoalId}/image`, gymId, validPng());
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
    expect(await imageUrlOf(otherGymGoalId)).toBeNull();
  });

  it('returns 409 for a soft-deleted goal', async () => {
    await db.query("UPDATE personal_goals SET status = 'deleted' WHERE id = ?", [goalId]);
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, validPng());
    expect(res.status).toBe(409);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 409 for a gym whose bucket was never initialized', async () => {
    const res = await upload(`/personal-goals/${noBucketGoalId}/image`, noBucketGymId, validPng());
    expect(res.status).toBe(409);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 503 when the deployment has no Cloudflare configuration', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, validPng());
    expect(res.status).toBe(503);
    expect(res.body.missingConfig?.length).toBeGreaterThan(0);
  });

  it('has no image route at all for a Nutrition Goal', async () => {
    // `IMAGE_GOAL_KINDS` decides whether the routes are registered, so this is a
    // 404 from the router rather than a write to a column that does not exist
    // (which would be ER_BAD_FIELD_ERROR and a bare 500, #966).
    const res = await upload(`/nutrition-goals/${nutritionGoalId}/image`, gymId, validPng());
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });
});

// ─── Validation (the file, never the request) ────────────────────────────────

describe('POST /personal-goals/:id/image — validation', () => {
  it('refuses a non-PNG content type', async () => {
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, validPng(), 'image/jpeg');
    expect(res.status).toBe(415);
    expect(putKeys()).toHaveLength(0);
  });

  it('refuses bytes that are not a PNG, whatever the header claimed', async () => {
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, JPEG_BYTES);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('not_a_png');
    expect(putKeys()).toHaveLength(0);
  });

  it('refuses a PNG over 512 in either dimension', async () => {
    expect((await upload(`/personal-goals/${goalId}/image`, gymId, opaquePng(513, 512))).body.reason)
      .toBe('too_large_dimensions');
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, opaquePng(512, 513));
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('too_large_dimensions');
    expect(putKeys()).toHaveLength(0);
  });

  it('accepts a smaller, non-square, fully opaque PNG (#1035 Q3)', async () => {
    // The ceiling is a maximum, and there is no transparency requirement —
    // deliberately unlike a Base Nutrition Library food (#715 §2).
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, opaquePng(400, 300));
    expect(res.status).toBe(200);
    expect(putKeys()).toHaveLength(1);
  });

  it('refuses an empty body', async () => {
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(putKeys()).toHaveLength(0);
  });

  it('leaves an existing image untouched when the upload is refused', async () => {
    const existing = url(`${gymPrefix}/goals/${goalId}-${SANITIZED}.png`);
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [existing, goalId]);
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, JPEG_BYTES);
    expect(res.status).toBe(400);
    expect(await imageUrlOf(goalId)).toBe(existing);
    expect(deletedKeys()).toHaveLength(0);
  });
});

// ─── Happy path (the gym route) ──────────────────────────────────────────────

describe('POST /personal-goals/:id/image', () => {
  it("stores the object at <gym prefix>/goals/<id>-<Name>.png and persists the URL", async () => {
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, validPng());
    expect(res.status).toBe(200);

    const key = `${gymPrefix}/goals/${goalId}-${SANITIZED}.png`;
    expect(putKeys()).toEqual([key]);
    expect(sentCommands('put').at(-1).input).toMatchObject({
      Bucket: R2_BUCKET, Key: key, ContentType: 'image/png',
    });
    // Never the platform's root, and never another gym's folder.
    expect(key.startsWith(`${gymPrefix}/`)).toBe(true);
    expect(key).not.toContain('cordel/');

    expect(await imageUrlOf(goalId)).toBe(url(key));
    expect(res.body.image_url).toBe(url(key));
  });

  it('writes the folder markers between the bucket root and goals/', async () => {
    await upload(`/personal-goals/${goalId}/image`, gymId, validPng());
    expect(markerKeys()).toEqual([`${gymPrefix}/`, `${gymPrefix}/goals/`]);
  });

  it('answers 502 and writes nothing to the row when the upload fails', async () => {
    sendMock.mockRejectedValue(new Error('R2 is down'));
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, validPng());
    expect(res.status).toBe(502);
    expect(await imageUrlOf(goalId)).toBeNull();
  });

  it('overwrites its own object on a replace, with nothing to sweep', async () => {
    const key = `${gymPrefix}/goals/${goalId}-${SANITIZED}.png`;
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [url(key), goalId]);
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, validPng());
    expect(res.status).toBe(200);
    // The key is deterministic, so the replacement *is* the same object.
    expect(putKeys()).toEqual([key]);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('sweeps the old object only when the key actually moved', async () => {
    const stale = `${gymPrefix}/goals/${goalId}-An-Older-Name.png`;
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [url(stale), goalId]);
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, validPng());
    expect(res.status).toBe(200);
    expect(deletedKeys()).toEqual([stale]);
    expect(await imageUrlOf(goalId)).toBe(url(`${gymPrefix}/goals/${goalId}-${SANITIZED}.png`));
  });

  it("never deletes the platform's object, another gym's, or an external URL", async () => {
    for (const foreign of [
      url(`cordel/goals/${goalId}-${SANITIZED}.png`),
      url(`${otherGymPrefix}/goals/${goalId}-${SANITIZED}.png`),
      'https://example.org/somebody-elses.png',
    ]) {
      sendMock.mockReset();
      sendMock.mockResolvedValue({});
      await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [foreign, goalId]);
      const res = await upload(`/personal-goals/${goalId}/image`, gymId, validPng());
      expect(res.status).toBe(200);
      expect(deletedKeys(), foreign).toHaveLength(0);
    }
  });

  it('records who uploaded it', async () => {
    await upload(`/personal-goals/${goalId}/image`, gymId, validPng());
    const { rows } = await db.query<{ modified_by_name: string | null; modified_at: string | null }>(
      'SELECT modified_by_name, modified_at FROM personal_goals WHERE id = ?',
      [goalId],
    );
    expect(rows[0].modified_by_name).toBeTruthy();
    expect(rows[0].modified_at).toBeTruthy();
  });
});

// ─── DELETE (the gym route) ──────────────────────────────────────────────────

describe('DELETE /personal-goals/:id/image', () => {
  it("clears the reference and deletes the gym's own object", async () => {
    const key = `${gymPrefix}/goals/${goalId}-${SANITIZED}.png`;
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [url(key), goalId]);
    const res = await remove(`/personal-goals/${goalId}/image`, gymId);
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBeNull();
    expect(await imageUrlOf(goalId)).toBeNull();
    expect(deletedKeys()).toEqual([key]);
  });

  it('leaves a System object alone while still clearing the reference', async () => {
    const platformKey = `cordel/goals/${goalId}-${SANITIZED}.png`;
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [url(platformKey), goalId]);
    const res = await remove(`/personal-goals/${goalId}/image`, gymId);
    expect(res.status).toBe(200);
    expect(await imageUrlOf(goalId)).toBeNull();
    expect(deletedKeys()).toHaveLength(0);
  });

  it('works for a gym with no bucket — the reference is the gym\'s to clear either way', async () => {
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [
      'https://example.org/x.png', noBucketGoalId,
    ]);
    const res = await remove(`/personal-goals/${noBucketGoalId}/image`, noBucketGymId);
    expect(res.status).toBe(200);
    expect(await imageUrlOf(noBucketGoalId)).toBeNull();
    expect(deletedKeys()).toHaveLength(0);
  });

  it('is 403 for a System goal and 404 for another gym\'s', async () => {
    expect((await remove(`/personal-goals/${systemGoalId}/image`, gymId)).status).toBe(403);
    expect((await remove(`/personal-goals/${otherGymGoalId}/image`, gymId)).status).toBe(404);
  });

  it('returns 401 without auth', async () => {
    expect((await request.delete(`/personal-goals/${goalId}/image`)).status).toBe(401);
  });
});

// ─── The platform pair ───────────────────────────────────────────────────────

describe('POST /platform/personal-goals/:id/image', () => {
  it('returns 401 without auth and 403 for a non-superadmin', async () => {
    const unauth = await request
      .post(`/platform/personal-goals/${systemGoalId}/image`)
      .set('Content-Type', 'image/png')
      .send(validPng());
    expect(unauth.status).toBe(401);

    mockAsNonSuperadmin();
    const res = await upload(`/platform/personal-goals/${systemGoalId}/image`, null, validPng());
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });

  it('stores the object at cordel/goals/<id>-<Name>.png and persists the URL', async () => {
    const res = await upload(`/platform/personal-goals/${systemGoalId}/image`, null, validPng());
    expect(res.status).toBe(200);

    const key = `cordel/goals/${systemGoalId}-Test-Goal-Image-System-Owned.png`;
    expect(putKeys()).toEqual([key]);
    // The platform root, and never a gym's folder — not even the one a
    // superadmin happens to have selected.
    expect(key).not.toContain('gyms/');
    expect(await imageUrlOf(systemGoalId)).toBe(url(key));
    expect(res.body.image_url).toBe(url(key));
  });

  it('writes its own markers, because Gym Bucket Initialization writes none under cordel/', async () => {
    await upload(`/platform/personal-goals/${systemGoalId}/image`, null, validPng());
    expect(markerKeys()).toEqual(['cordel/', 'cordel/goals/']);
  });

  it("is 404 for a gym's own goal, whoever asks", async () => {
    const res = await upload(`/platform/personal-goals/${goalId}/image`, null, validPng());
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
    expect(await imageUrlOf(goalId)).toBeNull();
  });

  it('applies the same file validation as the gym route', async () => {
    expect((await upload(`/platform/personal-goals/${systemGoalId}/image`, null, JPEG_BYTES)).body.reason)
      .toBe('not_a_png');
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    expect((await upload(`/platform/personal-goals/${systemGoalId}/image`, null, opaquePng(1024))).body.reason)
      .toBe('too_large_dimensions');
    expect(putKeys()).toHaveLength(0);
  });

  it("never deletes a gym's object when a System goal's image moves", async () => {
    const gymObject = url(`${gymPrefix}/goals/${systemGoalId}-X.png`);
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [gymObject, systemGoalId]);
    const res = await upload(`/platform/personal-goals/${systemGoalId}/image`, null, validPng());
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });

  it("sweeps its own stale object, and another platform feature's is not its to delete", async () => {
    const stale = `cordel/goals/${systemGoalId}-An-Older-Name.png`;
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [url(stale), systemGoalId]);
    expect((await upload(`/platform/personal-goals/${systemGoalId}/image`, null, validPng())).status).toBe(200);
    expect(deletedKeys()).toEqual([stale]);

    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [
      url('cordel/nutrition/9-Salmon.png'), systemGoalId,
    ]);
    expect((await upload(`/platform/personal-goals/${systemGoalId}/image`, null, validPng())).status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('has no image route for a Nutrition Goal', async () => {
    const res = await upload(`/platform/nutrition-goals/${nutritionGoalId}/image`, null, validPng());
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });
});

describe('DELETE /platform/personal-goals/:id/image', () => {
  it("clears the reference and deletes the platform's own object", async () => {
    const key = `cordel/goals/${systemGoalId}-Test-Goal-Image-System-Owned.png`;
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [url(key), systemGoalId]);
    const res = await remove(`/platform/personal-goals/${systemGoalId}/image`, null);
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBeNull();
    expect(await imageUrlOf(systemGoalId)).toBeNull();
    expect(deletedKeys()).toEqual([key]);
  });

  it("is 404 for a gym's own goal", async () => {
    expect((await remove(`/platform/personal-goals/${goalId}/image`, null)).status).toBe(404);
  });

  it('returns 403 for a non-superadmin', async () => {
    mockAsNonSuperadmin();
    expect((await remove(`/platform/personal-goals/${systemGoalId}/image`, null)).status).toBe(403);
  });
});

// ─── The column itself ───────────────────────────────────────────────────────

describe('personal_goals.image_url (migration 225)', () => {
  it('is nullable and starts null, with no backfill', async () => {
    const { rows } = await db.query<{ IS_NULLABLE: string; CHARACTER_MAXIMUM_LENGTH: number }>(
      `SELECT IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'personal_goals' AND COLUMN_NAME = 'image_url'`,
    );
    expect(rows[0]?.IS_NULLABLE).toBe('YES');
    expect(Number(rows[0]?.CHARACTER_MAXIMUM_LENGTH)).toBe(1024);

    // Nothing was generated or guessed for the seeded System goals (#716's rule:
    // generating the artwork is out of scope and there is no fallback image).
    const { rows: seeded } = await db.query<{ withImage: number }>(
      "SELECT COUNT(*) AS withImage FROM personal_goals WHERE gym_id IS NULL AND slug IS NOT NULL AND image_url IS NOT NULL",
    );
    expect(Number(seeded[0].withImage)).toBe(0);
  });

  it('is reported by the list and the single read, for Personal Goals only', async () => {
    const key = `${gymPrefix}/goals/${goalId}-${SANITIZED}.png`;
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [url(key), goalId]);

    const list = await request
      .get('/personal-goals?search=Test Goal Image Marathon')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list.status).toBe(200);
    expect(list.body.items.find((g: any) => g.id === goalId)?.image_url).toBe(url(key));

    // `nutrition_goals` has no such column, so the key must be absent rather
    // than null — a projection of it would be ER_BAD_FIELD_ERROR (#966).
    const nutrition = await request
      .get('/nutrition-goals')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(nutrition.status).toBe(200);
    expect(nutrition.body.items[0]).not.toHaveProperty('image_url');
  });

  it('is bounded by the request limit rather than by a stray large body', async () => {
    // The parser's ceiling is the byte limit plus headroom; the route's own check
    // is what reports the 413 with a message naming the limit.
    expect(PERSONAL_GOAL_IMAGE_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});
