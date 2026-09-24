// #715 — images for the **Base Nutrition Library**: the superadmin upload route
// (`POST /platform/nutrition-library/:id/image`), the `image_url` the API
// exposes, and the one-time backfill script that populates the existing foods.
//
// Separate from platform-nutrition-library.test.ts for the same reason
// base-theme-members-images.test.ts is separate from themes.test.ts: this file
// mocks @aws-sdk/client-s3 and moves the CLOUDFLARE_R2_* env around.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { encodePngRgba } from '../domain/pngImage';
import { BASE_NUTRITION_IMAGE_SIZE } from '../domain/baseNutritionImages';
import { backfillBaseNutritionImages, parseArgs } from '../scripts/backfill-base-nutrition-images';

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

/** A valid upload: 512×512, PNG, alpha channel. */
function validPng(size = BASE_NUTRITION_IMAGE_SIZE): Buffer {
  return encodePngRgba(size, size, Buffer.alloc(size * size * 4, 0x40));
}

/** A 512×512 PNG with no alpha channel — colour type 2 in the IHDR. */
function opaquePng(): Buffer {
  const png = Buffer.from(validPng(1));
  png.writeUInt32BE(BASE_NUTRITION_IMAGE_SIZE, 16);
  png.writeUInt32BE(BASE_NUTRITION_IMAGE_SIZE, 20);
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

const BASE_FOOD_NAME = 'Test Base Image Chicken Breast';
const SECOND_FOOD_NAME = 'Test Base Image Salmon, Atlantic';
const GYM_FOOD_NAME = 'Test Base Image Gym Owned Food';

let gymId: string;
let foodId: number;
let secondFoodId: number;
let gymFoodId: number;

async function createBaseFood(name: string): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO nutrition_library_items (gym_id, name, status) VALUES (NULL, ?, 'active')",
    [name],
  );
  return insertId as number;
}

function upload(id: number | string, body: Buffer, contentType = 'image/png') {
  return request
    .post(`/platform/nutrition-library/${id}/image`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('Content-Type', contentType)
    .send(body);
}

async function imageUrlOf(id: number): Promise<string | null> {
  const { rows } = await db.query<{ image_url: string | null }>(
    'SELECT image_url FROM nutrition_library_items WHERE id = ?',
    [id],
  );
  return rows[0]?.image_url ?? null;
}

beforeAll(async () => {
  gymId = await createTestGym('BaseNutritionImagesGym');
  await createTestMembership(gymId, 'admin');

  foodId = await createBaseFood(BASE_FOOD_NAME);
  secondFoodId = await createBaseFood(SECOND_FOOD_NAME);
  const { insertId } = await db.query(
    "INSERT INTO nutrition_library_items (gym_id, name, status) VALUES (?, ?, 'active')",
    [gymId, GYM_FOOD_NAME],
  );
  gymFoodId = insertId as number;
});

afterAll(async () => {
  await db.query("DELETE FROM nutrition_library_items WHERE name LIKE 'Test Base Image %'");
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
    "UPDATE nutrition_library_items SET image_url = NULL, name = ?, status = 'active' WHERE id = ?",
    [BASE_FOOD_NAME, foodId],
  );
  await db.query(
    "UPDATE nutrition_library_items SET image_url = NULL, status = 'active' WHERE id IN (?, ?)",
    [secondFoodId, gymFoodId],
  );
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('POST /platform/nutrition-library/:id/image — auth', () => {
  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/platform/nutrition-library/${foodId}/image`)
      .set('Content-Type', 'image/png')
      .send(validPng());
    expect(res.status).toBe(401);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('returns 403 for an authenticated non-superadmin', async () => {
    mockAsNonSuperadmin();
    const res = await upload(foodId, validPng());
    expect(res.status).toBe(403);
    expect(sentCommands('put')).toHaveLength(0);
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('POST /platform/nutrition-library/:id/image', () => {
  it('stores the image at cordel/Nutrition/<id>-<Name>.png and persists the URL', async () => {
    const res = await upload(foodId, validPng());
    expect(res.status).toBe(200);

    const key = `cordel/Nutrition/${foodId}-Test-Base-Image-Chicken-Breast.png`;
    const puts = sentCommands('put');
    expect(puts[puts.length - 1].input).toMatchObject({ Bucket: R2_BUCKET, Key: key, ContentType: 'image/png' });
    expect(key.startsWith('cordel/')).toBe(true);
    expect(key).not.toContain('gyms/');

    const expectedUrl = `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;
    expect(res.body.image_url).toBe(expectedUrl);
    expect(await imageUrlOf(foodId)).toBe(expectedUrl);
  });

  it('sanitizes the food name in the key', async () => {
    const res = await upload(secondFoodId, validPng());
    expect(res.status).toBe(200);
    const puts = sentCommands('put');
    expect(puts[puts.length - 1].input.Key).toBe(`cordel/Nutrition/${secondFoodId}-Test-Base-Image-Salmon-Atlantic.png`);
  });

  it('writes the cordel/Nutrition/ folder markers', async () => {
    await upload(foodId, validPng());
    const keys = sentCommands('put').map((c: any) => c.input.Key);
    expect(keys).toContain('cordel/');
    expect(keys).toContain('cordel/Nutrition/');
  });

  it('replaces an image at the same key, leaving nothing orphaned', async () => {
    await upload(foodId, validPng());
    const firstUrl = await imageUrlOf(foodId);
    sendMock.mockClear();

    const res = await upload(foodId, validPng());
    expect(res.status).toBe(200);
    expect(await imageUrlOf(foodId)).toBe(firstUrl);
    // Same deterministic key, so the object is overwritten — nothing to delete.
    expect(sentCommands('delete')).toHaveLength(0);
  });

  it('deletes the object a rename left behind', async () => {
    await upload(foodId, validPng());
    const staleKey = `cordel/Nutrition/${foodId}-Test-Base-Image-Chicken-Breast.png`;

    await db.query('UPDATE nutrition_library_items SET name = ? WHERE id = ?', ['Test Base Image Renamed Food', foodId]);
    sendMock.mockClear();

    const res = await upload(foodId, validPng());
    expect(res.status).toBe(200);
    const newKey = `cordel/Nutrition/${foodId}-Test-Base-Image-Renamed-Food.png`;
    expect(sentCommands('put').map((c: any) => c.input.Key)).toContain(newKey);
    expect(sentCommands('delete').map((c: any) => c.input.Key)).toEqual([staleKey]);
    expect(await imageUrlOf(foodId)).toBe(`${R2_ENDPOINT}/${R2_BUCKET}/${newKey}`);
  });

  it('still saves the new image when sweeping the renamed food\'s old object fails', async () => {
    await upload(foodId, validPng());
    await db.query('UPDATE nutrition_library_items SET name = ? WHERE id = ?', ['Test Base Image Renamed Food', foodId]);
    sendMock.mockReset();
    sendMock.mockImplementation((command: any) => (
      command?.__type === 'delete' ? Promise.reject(new Error('R2 down')) : Promise.resolve({})
    ));

    const res = await upload(foodId, validPng());
    expect(res.status).toBe(200);
    expect(await imageUrlOf(foodId)).toContain('Test-Base-Image-Renamed-Food.png');
  });
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe('POST /platform/nutrition-library/:id/image — validation', () => {
  it('rejects a non-image content type with 415', async () => {
    const res = await upload(foodId, validPng(), 'image/jpeg');
    expect(res.status).toBe(415);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('rejects bytes that are not a PNG', async () => {
    const res = await upload(foodId, JPEG_BYTES);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('not_a_png');
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('rejects the wrong dimensions', async () => {
    const res = await upload(foodId, validPng(256));
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('not_square_512');
    expect(res.body.error).toContain('512');
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('rejects a PNG without a transparent background', async () => {
    const res = await upload(foodId, opaquePng());
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('not_transparent');
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('leaves the existing image in place when an upload is refused', async () => {
    await upload(foodId, validPng());
    const good = await imageUrlOf(foodId);
    sendMock.mockClear();

    const res = await upload(foodId, validPng(256));
    expect(res.status).toBe(400);
    expect(await imageUrlOf(foodId)).toBe(good);
    expect(sentCommands('put')).toHaveLength(0);
    expect(sentCommands('delete')).toHaveLength(0);
  });

  it('does not persist a URL when the upload to R2 fails', async () => {
    sendMock.mockReset();
    sendMock.mockRejectedValue(new Error('R2 is unreachable'));
    const res = await upload(foodId, validPng());
    expect(res.status).toBe(502);
    expect(await imageUrlOf(foodId)).toBeNull();
  });

  it('returns 503 when the deployment has no R2 configured', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    const res = await upload(foodId, validPng());
    expect(res.status).toBe(503);
    expect(res.body.missingConfig).toContain('CLOUDFLARE_R2_BUCKET');
    expect(sentCommands('put')).toHaveLength(0);
  });
});

// ─── Scope: base foods only ──────────────────────────────────────────────────

describe('POST /platform/nutrition-library/:id/image — scope', () => {
  it('returns 404 for a gym-owned food, so no gym item is reachable here', async () => {
    const res = await upload(gymFoodId, validPng());
    expect(res.status).toBe(404);
    expect(sentCommands('put')).toHaveLength(0);
    expect(await imageUrlOf(gymFoodId)).toBeNull();
  });

  it('returns 404 for an unknown food', async () => {
    const res = await upload(99999999, validPng());
    expect(res.status).toBe(404);
  });

  it('returns 409 for a deleted food', async () => {
    await db.query("UPDATE nutrition_library_items SET status = 'deleted' WHERE id = ?", [foodId]);
    const res = await upload(foodId, validPng());
    expect(res.status).toBe(409);
    expect(sentCommands('put')).toHaveLength(0);
  });
});

// ─── The API exposes the reference ───────────────────────────────────────────

describe('GET /platform/nutrition-library', () => {
  it('returns image_url for every food, null when there is none', async () => {
    await upload(foodId, validPng());
    const res = await request
      .get('/platform/nutrition-library?search=Test Base Image&limit=50')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);

    const withImage = res.body.items.find((i: any) => i.id === foodId);
    const withoutImage = res.body.items.find((i: any) => i.id === secondFoodId);
    expect(withImage.image_url).toContain(`cordel/Nutrition/${foodId}-`);
    expect(withoutImage).toBeDefined();
    expect(withoutImage.image_url).toBeNull();
  });
});

// ─── The backfill script (#715 §3, §4) ───────────────────────────────────────

describe('backfillBaseNutritionImages()', () => {
  const silent = () => {};
  /**
   * Scoped to this file's own foods with `--only`, so the run neither depends on
   * nor rewrites whatever else the test database's base library holds.
   */
  const run = (overrides: Partial<Parameters<typeof backfillBaseNutritionImages>[0]> = {}) =>
    backfillBaseNutritionImages(
      { dryRun: false, force: false, fromDir: null, limit: null, ids: [foodId, secondFoodId], ...overrides },
      silent,
    );

  it('parses its flags', () => {
    expect(parseArgs(['--dry-run', '--force', '--from', '/tmp/art', '--limit', '5'])).toEqual({
      dryRun: true, force: true, fromDir: '/tmp/art', limit: 5, ids: null,
    });
    expect(parseArgs(['--only', '3, 4'])).toMatchObject({ ids: [3, 4] });
    expect(() => parseArgs(['--only', 'chicken'])).toThrow(/food ids/);
    expect(parseArgs(['--from=/tmp/art', '--limit=2'])).toMatchObject({ fromDir: '/tmp/art', limit: 2 });
    expect(() => parseArgs(['--limit', '0'])).toThrow(/positive integer/);
  });

  it('generates, uploads and persists an image for every base food that has none', async () => {
    const counters = await run();

    expect(counters.discovered).toBe(2);
    expect(counters.generated).toBe(2);
    expect(counters.failed).toEqual([]);
    expect(await imageUrlOf(foodId)).toContain(`cordel/Nutrition/${foodId}-Test-Base-Image-Chicken-Breast.png`);
    expect(await imageUrlOf(secondFoodId)).toContain(`cordel/Nutrition/${secondFoodId}-`);
  });

  it('never touches a gym-owned food', async () => {
    await backfillBaseNutritionImages({ dryRun: false, force: false, fromDir: null, limit: null, ids: null }, silent);
    expect(await imageUrlOf(gymFoodId)).toBeNull();
    const keys = sentCommands('put').map((c: any) => c.input.Key);
    expect(keys.every((k: string) => k.startsWith('cordel/'))).toBe(true);
  });

  it('is idempotent — a second run re-uploads nothing', async () => {
    await run();
    const firstUrl = await imageUrlOf(foodId);
    sendMock.mockClear();

    const second = await run();
    expect(second.alreadyPresent).toBe(second.discovered);
    expect(second.uploaded).toBe(0);
    expect(sentCommands('put')).toHaveLength(0);
    expect(await imageUrlOf(foodId)).toBe(firstUrl);
  });

  it('regenerates when --force is passed', async () => {
    await run();
    sendMock.mockClear();
    const forced = await run({ force: true });
    expect(forced.uploaded).toBe(forced.discovered);
  });

  it('uploads nothing in a dry run', async () => {
    const counters = await run({ dryRun: true });
    expect(counters.generated).toBe(2);
    expect(counters.uploaded).toBe(0);
    expect(sentCommands('put')).toHaveLength(0);
    expect(await imageUrlOf(foodId)).toBeNull();
  });

  it('keeps going after one food fails, and reports it with its id and name', async () => {
    let attempt = 0;
    sendMock.mockReset();
    sendMock.mockImplementation((command: any) => {
      if (command?.__type !== 'put') return Promise.resolve({});
      // The folder markers go first; fail the first real object only.
      if (String(command.input.Key).endsWith('/')) return Promise.resolve({});
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('R2 rejected this object')) : Promise.resolve({});
    });

    const counters = await run();
    expect(counters.failed).toHaveLength(1);
    expect(counters.failed[0]).toMatchObject({ id: expect.any(Number), name: expect.any(String) });
    expect(counters.failed[0].error).toContain('R2 rejected this object');
    // Every other food still got its image.
    expect(counters.uploaded).toBe(counters.discovered - 1);
  });

  it('prefers supplied artwork from --from over a generated illustration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nutrition-art-'));
    try {
      const supplied = encodePngRgba(
        BASE_NUTRITION_IMAGE_SIZE,
        BASE_NUTRITION_IMAGE_SIZE,
        Buffer.alloc(BASE_NUTRITION_IMAGE_SIZE * BASE_NUTRITION_IMAGE_SIZE * 4, 0x11),
      );
      writeFileSync(join(dir, `${foodId}.png`), supplied);

      const counters = await run({ fromDir: dir });
      expect(counters.supplied).toBe(1);

      const put = sentCommands('put').find((c: any) => String(c.input.Key).includes(`${foodId}-Test-Base-Image`));
      expect(Buffer.from(put.input.Body).equals(supplied)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses supplied artwork that the upload route would refuse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nutrition-art-'));
    try {
      writeFileSync(join(dir, `${foodId}.png`), encodePngRgba(256, 256, Buffer.alloc(256 * 256 * 4)));
      const counters = await run({ fromDir: dir });
      expect(counters.failed.map((f) => f.id)).toContain(foodId);
      expect(counters.failed.find((f) => f.id === foodId)?.error).toContain('512');
      expect(await imageUrlOf(foodId)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to run against an unconfigured deployment unless it is a dry run', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    await expect(run()).rejects.toThrow(/CLOUDFLARE_R2/);
  });
});
