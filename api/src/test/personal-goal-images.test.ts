// #1722 (replacing #1035 stage 2's PNG-only implementation) — a **Personal
// Goal's image** on the shared WebP pipeline: the gym-facing routes
// (`POST`/`DELETE /personal-goals/:id/image`), the platform pair
// (`/platform/personal-goals/:id/image`), the keys each lands under (a 1080 WebP
// master and a 256 WebP thumbnail), the objects each side may and may not
// delete, Duplicate, rename and the legacy-PNG fallback.
//
// Separate from goal-library.test.ts and platform-goal-library.test.ts for the
// same reason base-nutrition-images.test.ts is separate from
// platform-nutrition-library.test.ts: this file mocks @aws-sdk/client-s3 and
// moves the CLOUDFLARE_R2_* env around.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import sharp from 'sharp';

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

/** Any decodable picture: the server crops, resizes and re-encodes it. */
async function photo(format: 'jpeg' | 'png' = 'jpeg', width = 800, height = 600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } })[format]().toBuffer();
}

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

function sentCommands(type: 'put' | 'delete' | 'copy') {
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

async function urlsOf(id: number): Promise<{ image_url: string | null; image_thumbnail_url: string | null }> {
  const { rows } = await db.query<{ image_url: string | null; image_thumbnail_url: string | null }>(
    'SELECT image_url, image_thumbnail_url FROM personal_goals WHERE id = ?',
    [id],
  );
  return rows[0];
}

function upload(path: string, gym: string | null, body: Buffer, contentType = 'image/jpeg') {
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
    "UPDATE personal_goals SET image_url = NULL, image_thumbnail_url = NULL, name = ?, status = 'active' WHERE id = ?",
    [GOAL_NAME, goalId],
  );
  await db.query(
    "UPDATE personal_goals SET image_url = NULL, image_thumbnail_url = NULL, status = 'active' WHERE id IN (?, ?, ?, ?)",
    [otherGymGoalId, noBucketGoalId, frontDeskGoalId, systemGoalId],
  );
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── Auth and ownership (the gym route) ──────────────────────────────────────

describe('POST /personal-goals/:id/image — auth and ownership', () => {
  it('returns 401 without auth, and uploads nothing', async () => {
    const res = await request.post(`/personal-goals/${goalId}/image`).set('x-gym-id', gymId)
      .set('Content-Type', 'image/jpeg').send(await photo());
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for a read-only role', async () => {
    // The Clerk user is mocked as a superadmin by default, and `tenantContext`
    // gives a superadmin full admin on any gym, so the `front_desk` membership
    // only decides anything for an ordinary user. The prefix removes the 409
    // (no bucket) as a second explanation.
    mockAsNonSuperadmin();
    await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [
      `gyms/${frontDeskGymId}-PersonalGoalImagesFrontDesk`, frontDeskGymId,
    ]);
    const res = await upload(`/personal-goals/${frontDeskGoalId}/image`, frontDeskGymId, await photo());
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for a System goal — Cordel administers those', async () => {
    const res = await upload(`/personal-goals/${systemGoalId}/image`, gymId, await photo());
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });

  it("returns 404 for another gym's goal, and writes nothing", async () => {
    const res = await upload(`/personal-goals/${otherGymGoalId}/image`, gymId, await photo());
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
    expect(await imageUrlOf(otherGymGoalId)).toBeNull();
  });

  it('returns 409 for a soft-deleted goal and for a gym whose bucket was never initialized', async () => {
    await db.query("UPDATE personal_goals SET status = 'deleted' WHERE id = ?", [goalId]);
    expect((await upload(`/personal-goals/${goalId}/image`, gymId, await photo())).status).toBe(409);
    expect((await upload(`/personal-goals/${noBucketGoalId}/image`, noBucketGymId, await photo())).status).toBe(409);
    expect(putKeys()).toHaveLength(0);
  });

  it('refuses bytes that are not an image, whatever the header claimed, and keeps the existing image', async () => {
    const ok = await upload(`/personal-goals/${goalId}/image`, gymId, await photo());
    expect(ok.status).toBe(200);
    const before = await urlsOf(goalId);
    sendMock.mockClear();
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, Buffer.from('not an image at all'), 'image/png');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(putKeys()).toHaveLength(0);
    expect(await urlsOf(goalId)).toEqual(before);
  });
});

// ─── The gym route: WebP master + thumbnail ──────────────────────────────────

describe('POST /personal-goals/:id/image', () => {
  it('turns any picture into a 1080 WebP master and a 256 WebP thumbnail under <gym prefix>/goals/', async () => {
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, await photo('jpeg', 900, 500));
    expect(res.status).toBe(200);

    const key = `${gymPrefix}/goals/${goalId}-${SANITIZED}.webp`;
    const thumbKey = `${gymPrefix}/goals/${goalId}-${SANITIZED}-thumbnail.webp`;
    expect(putKeys().sort()).toEqual([key, thumbKey].sort());
    expect(await urlsOf(goalId)).toEqual({ image_url: url(key), image_thumbnail_url: url(thumbKey) });
    expect(res.body.image_url).toBe(url(key));
    expect(res.body.image_thumbnail_url).toBe(url(thumbKey));

    for (const [put, size] of [[key, 1080], [thumbKey, 256]] as const) {
      const command: any = sentCommands('put').find((c: any) => c.input.Key === put);
      const meta = await sharp(command.input.Body).metadata();
      expect(meta.format).toBe('webp');
      expect([meta.width, meta.height]).toEqual([size, size]);
    }
  });

  it('accepts a PNG input and writes the folder markers down to goals/', async () => {
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, await photo('png', 300, 300), 'image/png');
    expect(res.status).toBe(200);
    expect(markerKeys()).toEqual([`${gymPrefix}/`, `${gymPrefix}/goals/`]);
  });

  it('answers 502 and writes nothing to the row when the upload fails', async () => {
    sendMock.mockRejectedValue(new Error('R2 down'));
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, await photo());
    expect(res.status).toBe(502);
    expect(await urlsOf(goalId)).toEqual({ image_url: null, image_thumbnail_url: null });
  });

  it('overwrites its own objects on a replace, with nothing to sweep', async () => {
    await upload(`/personal-goals/${goalId}/image`, gymId, await photo());
    sendMock.mockClear();
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, await photo('png', 400, 400), 'image/png');
    expect(res.status).toBe(200);
    expect(deletedKeys()).toEqual([]);
  });

  it("sweeps a pre-#1722 PNG object of the gym's own when the image is replaced", async () => {
    const legacyKey = `${gymPrefix}/goals/${goalId}-${SANITIZED}.png`;
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [url(legacyKey), goalId]);
    const res = await upload(`/personal-goals/${goalId}/image`, gymId, await photo());
    expect(res.status).toBe(200);
    expect(deletedKeys()).toEqual([legacyKey]);
  });

  it("never deletes the platform's object, another gym's, or an external URL", async () => {
    for (const stale of [
      url(`cordel/goals/${systemGoalId}-x.png`),
      url(`${otherGymPrefix}/goals/${otherGymGoalId}-x.png`),
      'https://example.com/pic.png',
    ]) {
      await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [stale, goalId]);
      sendMock.mockClear();
      const res = await upload(`/personal-goals/${goalId}/image`, gymId, await photo());
      expect(res.status).toBe(200);
      expect(deletedKeys()).toEqual([]);
    }
  });

  it('records who uploaded it', async () => {
    await upload(`/personal-goals/${goalId}/image`, gymId, await photo());
    const { rows } = await db.query<{ modified_by: string | null }>('SELECT modified_by FROM personal_goals WHERE id = ?', [goalId]);
    expect(rows[0].modified_by).toBeTruthy();
  });
});

describe('DELETE /personal-goals/:id/image', () => {
  it("clears both references and deletes the gym's own objects", async () => {
    await upload(`/personal-goals/${goalId}/image`, gymId, await photo());
    const before = await urlsOf(goalId);
    sendMock.mockClear();
    const res = await remove(`/personal-goals/${goalId}/image`, gymId);
    expect(res.status).toBe(200);
    expect(await urlsOf(goalId)).toEqual({ image_url: null, image_thumbnail_url: null });
    expect(deletedKeys().sort()).toEqual([
      before.image_url!.replace(`${R2_ENDPOINT}/${R2_BUCKET}/`, ''),
      before.image_thumbnail_url!.replace(`${R2_ENDPOINT}/${R2_BUCKET}/`, ''),
    ].sort());
  });

  it('leaves a System object alone while still clearing the reference', async () => {
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [url(`cordel/goals/${systemGoalId}-x.webp`), goalId]);
    const res = await remove(`/personal-goals/${goalId}/image`, gymId);
    expect(res.status).toBe(200);
    expect(deletedKeys()).toEqual([]);
    expect(await imageUrlOf(goalId)).toBeNull();
  });

  it("is 403 for a System goal and 404 for another gym's; 401 without auth", async () => {
    expect((await remove(`/personal-goals/${systemGoalId}/image`, gymId)).status).toBe(403);
    expect((await remove(`/personal-goals/${otherGymGoalId}/image`, gymId)).status).toBe(404);
    expect((await request.delete(`/personal-goals/${goalId}/image`).set('x-gym-id', gymId)).status).toBe(401);
  });
});

describe('PUT /personal-goals/:id — rename and legacy images', () => {
  it('moves both WebP objects to the keys the new name builds', async () => {
    await upload(`/personal-goals/${goalId}/image`, gymId, await photo());
    sendMock.mockClear();
    const res = await request.put(`/personal-goals/${goalId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ name: 'Test Goal Image Renamed' });
    expect(res.status).toBe(200);
    const moved = await urlsOf(goalId);
    expect(moved.image_url).toBe(url(`${gymPrefix}/goals/${goalId}-Test-Goal-Image-Renamed.webp`));
    expect(moved.image_thumbnail_url).toBe(url(`${gymPrefix}/goals/${goalId}-Test-Goal-Image-Renamed-thumbnail.webp`));
    expect(sentCommands('copy')).toHaveLength(2);
    expect(deletedKeys()).toHaveLength(2);
  });

  it('keeps a legacy PNG master on its own key (it is not renamed to .webp)', async () => {
    const legacy = url(`${gymPrefix}/goals/${goalId}-${SANITIZED}.png`);
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [legacy, goalId]);
    const res = await request.put(`/personal-goals/${goalId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ name: 'Test Goal Image Legacy Renamed' });
    expect(res.status).toBe(200);
    expect(await imageUrlOf(goalId)).toBe(legacy);
    expect(sentCommands('copy')).toHaveLength(0);
  });

  it('lists a legacy goal with its master and a null thumbnail', async () => {
    const legacy = url(`${gymPrefix}/goals/${goalId}-${SANITIZED}.png`);
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [legacy, goalId]);
    const res = await request.get(`/personal-goals?search=${encodeURIComponent(GOAL_NAME)}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const row = res.body.items.find((g: any) => g.id === goalId);
    expect(row.image_url).toBe(legacy);
    expect(row.image_thumbnail_url).toBeNull();
  });
});

describe('POST /personal-goals/:id/duplicate — images', () => {
  it("copies the master and the thumbnail into the duplicate's own keys", async () => {
    await upload(`/personal-goals/${goalId}/image`, gymId, await photo());
    sendMock.mockClear();
    const res = await request.post(`/personal-goals/${goalId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send();
    expect(res.status).toBe(201);
    const copyId = res.body.id as number;
    const copied = await urlsOf(copyId);
    expect(copied.image_url).toMatch(new RegExp(`/goals/${copyId}-.*\\.webp$`));
    expect(copied.image_thumbnail_url).toMatch(new RegExp(`/goals/${copyId}-.*-thumbnail\\.webp$`));
    expect(sentCommands('copy')).toHaveLength(2);
    await db.query('DELETE FROM gym_personal_goals WHERE personal_goal_id = ?', [copyId]);
    await db.query('DELETE FROM personal_goals WHERE id = ?', [copyId]);
  });
});

// ─── The platform pair ───────────────────────────────────────────────────────

describe('/platform/personal-goals/:id/image', () => {
  it('returns 401 without auth and 403 for a non-superadmin', async () => {
    const unauth = await request.post(`/platform/personal-goals/${systemGoalId}/image`)
      .set('Content-Type', 'image/jpeg').send(await photo());
    expect(unauth.status).toBe(401);
    mockAsNonSuperadmin();
    const res = await upload(`/platform/personal-goals/${systemGoalId}/image`, null, await photo());
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });

  it('stores the WebP pair at cordel/goals/<id>-<Name>[-thumbnail].webp and writes its own markers', async () => {
    const res = await upload(`/platform/personal-goals/${systemGoalId}/image`, null, await photo());
    expect(res.status).toBe(200);
    const key = `cordel/goals/${systemGoalId}-Test-Goal-Image-System-Owned.webp`;
    const thumbKey = `cordel/goals/${systemGoalId}-Test-Goal-Image-System-Owned-thumbnail.webp`;
    expect(putKeys().sort()).toEqual([key, thumbKey].sort());
    expect(await urlsOf(systemGoalId)).toEqual({ image_url: url(key), image_thumbnail_url: url(thumbKey) });
    expect(markerKeys()).toEqual(['cordel/', 'cordel/goals/']);
  });

  it("is 404 for a gym's own goal, and applies the same file validation", async () => {
    expect((await upload(`/platform/personal-goals/${goalId}/image`, null, await photo())).status).toBe(404);
    const bad = await upload(`/platform/personal-goals/${systemGoalId}/image`, null, Buffer.from('nope'), 'image/png');
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(putKeys()).toHaveLength(0);
  });

  it("never deletes a gym's object when a System goal's image moves", async () => {
    await db.query('UPDATE personal_goals SET image_url = ? WHERE id = ?', [url(`${gymPrefix}/goals/9-x.png`), systemGoalId]);
    const res = await upload(`/platform/personal-goals/${systemGoalId}/image`, null, await photo());
    expect(res.status).toBe(200);
    expect(deletedKeys()).toEqual([]);
  });

  it("DELETE clears both references and deletes the platform's own objects; 404 for a gym's goal; 403 for a non-superadmin", async () => {
    await upload(`/platform/personal-goals/${systemGoalId}/image`, null, await photo());
    sendMock.mockClear();
    const res = await remove(`/platform/personal-goals/${systemGoalId}/image`, null);
    expect(res.status).toBe(200);
    expect(await urlsOf(systemGoalId)).toEqual({ image_url: null, image_thumbnail_url: null });
    expect(deletedKeys()).toHaveLength(2);
    expect((await remove(`/platform/personal-goals/${goalId}/image`, null)).status).toBe(404);
    mockAsNonSuperadmin();
    expect((await remove(`/platform/personal-goals/${systemGoalId}/image`, null)).status).toBe(403);
  });
});

describe('personal_goals image columns (migrations 225, 293)', () => {
  it('start null with no backfill, and a Nutrition Goal has no personal image route', async () => {
    const { rows } = await db.query<{ image_url: string | null; image_thumbnail_url: string | null }>(
      "SELECT image_url, image_thumbnail_url FROM personal_goals WHERE gym_id IS NULL AND slug = 'weight_loss'",
    );
    for (const row of rows) expect(row.image_thumbnail_url).toBeNull();
    const res = await upload(`/personal-goals/${nutritionGoalId}/image`, gymId, await photo());
    expect([403, 404]).toContain(res.status);
  });
});
