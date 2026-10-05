// #1035 §4/§5 — a **gym** Nutrition Library food's image:
// `POST /nutrition-library/:id/image`, the per-row route that replaced
// `POST /storage/uploads/nutrition-image`.
//
// The route exists because the key carries the food's own id and name
// (`<prefix>/nutrition/<food_id>-<name>.<ext>`), which a generic upload route
// that never sees the row cannot build. Separate from nutrition-library.test.ts
// for the reason base-nutrition-images.test.ts is separate from
// platform-nutrition-library.test.ts: this file mocks @aws-sdk/client-s3 and
// moves the CLOUDFLARE_R2_* env around.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

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

/** The bytes are not validated beyond their size, so any buffer will do. */
const PNG_BYTES = Buffer.from('fake-png-bytes');

function sentCommands(type: 'put' | 'delete') {
  return sendMock.mock.calls.map(([command]) => command).filter((c: any) => c?.__type === type);
}

function sentKeys(type: 'put' | 'delete'): string[] {
  return sentCommands(type).map((c: any) => c.input.Key as string);
}

const FOOD_NAME = 'Test Gym Image Chicken Breast';
const SYSTEM_FOOD_NAME = 'Test Gym Image System Food';

let gymId: string;
let prefix: string;
let foodId: number;
let systemFoodId: number;

function upload(gym: string, id: number | string, body: Buffer = PNG_BYTES, contentType = 'image/png') {
  return request
    .post(`/nutrition-library/${id}/image`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gym)
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
  gymId = await createTestGym('NutritionLibraryImagesGym');
  await createTestMembership(gymId, 'admin');
  prefix = `${gymId}-NutritionLibraryImagesGym`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [prefix, gymId]);

  const own = await db.query(
    "INSERT INTO nutrition_library_items (gym_id, name, status) VALUES (?, ?, 'active')",
    [gymId, FOOD_NAME],
  );
  foodId = own.insertId as number;
  const system = await db.query(
    "INSERT INTO nutrition_library_items (gym_id, name, status) VALUES (NULL, ?, 'active')",
    [SYSTEM_FOOD_NAME],
  );
  systemFoodId = system.insertId as number;
});

afterAll(async () => {
  await db.query("DELETE FROM nutrition_library_items WHERE name LIKE 'Test Gym Image %'");
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
    "UPDATE nutrition_library_items SET image_url = NULL, name = ?, status = 'active' WHERE id = ?",
    [FOOD_NAME, foodId],
  );
  await db.query(
    "UPDATE nutrition_library_items SET image_url = NULL, status = 'active' WHERE id = ?",
    [systemFoodId],
  );
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('POST /nutrition-library/:id/image — auth', () => {
  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/nutrition-library/${foodId}/image`)
      .set('x-gym-id', gymId)
      .set('Content-Type', 'image/png')
      .send(PNG_BYTES);
    expect(res.status).toBe(401);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('returns 403 for front_desk (NUTRITION is read-only, requireModuleWrite blocks)', async () => {
    const frontDeskGym = await createTestGym('NutritionLibraryImagesFrontDesk');
    await createTestMembership(frontDeskGym, 'front_desk');

    const res = await upload(frontDeskGym, foodId);
    expect(res.status).toBe(403);
    expect(sentCommands('put')).toHaveLength(0);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('POST /nutrition-library/:id/image — tenant isolation', () => {
  it("returns 404 for another gym's food and writes nothing", async () => {
    const otherGym = await createTestGym('NutritionLibraryImagesOtherGym');
    await createTestMembership(otherGym, 'admin');

    const res = await upload(otherGym, foodId);
    expect(res.status).toBe(404);
    expect(sentCommands('put')).toHaveLength(0);
    expect(await imageUrlOf(foodId)).toBeNull();
  });

  it('returns 403 for a System food — its image is Cordel’s', async () => {
    const res = await upload(gymId, systemFoodId);
    expect(res.status).toBe(403);
    expect(sentCommands('put')).toHaveLength(0);
    expect(await imageUrlOf(systemFoodId)).toBeNull();
  });

  it('never writes outside the gym’s own folder prefix', async () => {
    const res = await upload(gymId, foodId);
    expect(res.status).toBe(200);
    for (const key of sentKeys('put')) expect(key.startsWith(`${prefix}/`)).toBe(true);
  });
});

// ─── Happy path: the #1035 key shape ─────────────────────────────────────────

describe('POST /nutrition-library/:id/image — the stored key', () => {
  it('stores the object at <prefix>/nutrition/<food_id>-<name>.png and persists the URL', async () => {
    const res = await upload(gymId, foodId);
    expect(res.status).toBe(200);

    const key = `${prefix}/nutrition/${foodId}-Test-Gym-Image-Chicken-Breast.png`;
    expect(sentKeys('put')).toContain(key);
    expect(res.body.image_url).toBe(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
    expect(await imageUrlOf(foodId)).toBe(res.body.image_url);
  });

  it('no longer writes the pre-#1035 Nutrition/Images/<uuid> key', async () => {
    await upload(gymId, foodId);
    for (const key of sentKeys('put')) {
      // Assert on the tree *below* the gym's own folder. A gym's
      // `storage_folder_prefix` is derived from its name, and this one's
      // legitimately contains "Nutrition" — testing the whole key would fail on
      // the prefix rather than on the folder shape under test.
      const relative = key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : key;
      expect(relative).not.toContain('Nutrition');
      expect(relative).not.toContain('/Images/');
    }
  });

  it('writes the gym root and nutrition/ folder markers', async () => {
    await upload(gymId, foodId);
    const keys = sentKeys('put');
    expect(keys).toContain(`${prefix}/`);
    expect(keys).toContain(`${prefix}/nutrition/`);
  });

  it('takes the extension from the Content-Type, not from a fixed .png', async () => {
    const res = await upload(gymId, foodId, PNG_BYTES, 'image/jpeg');
    expect(res.status).toBe(200);
    expect(sentKeys('put')).toContain(`${prefix}/nutrition/${foodId}-Test-Gym-Image-Chicken-Breast.jpg`);
  });

  it('returns the whole item, so the list row the page holds stays current', async () => {
    const res = await upload(gymId, foodId);
    expect(res.body).toMatchObject({ id: foodId, name: FOOD_NAME });
    expect(res.body).toHaveProperty('categories');
    expect(res.body).toHaveProperty('translations');
    expect(res.body.modified_by_name).toBeTruthy();
  });
});

// ─── Replacing an image ───────────────────────────────────────────────────────

describe('POST /nutrition-library/:id/image — replacing', () => {
  it('reuses the key and deletes nothing when the format and the name are unchanged', async () => {
    await upload(gymId, foodId);
    sendMock.mockClear();

    const res = await upload(gymId, foodId);
    expect(res.status).toBe(200);
    expect(sentCommands('delete')).toHaveLength(0);
  });

  it('sweeps the old object when the food was renamed under it', async () => {
    await upload(gymId, foodId);
    const staleKey = `${prefix}/nutrition/${foodId}-Test-Gym-Image-Chicken-Breast.png`;
    await db.query('UPDATE nutrition_library_items SET name = ? WHERE id = ?', ['Test Gym Image Turkey Breast', foodId]);
    sendMock.mockClear();

    const res = await upload(gymId, foodId);
    expect(res.status).toBe(200);
    expect(sentKeys('put')).toContain(`${prefix}/nutrition/${foodId}-Test-Gym-Image-Turkey-Breast.png`);
    expect(sentKeys('delete')).toEqual([staleKey]);
  });

  it('leaves a cordel/ System object alone — a gym never deletes platform media', async () => {
    const systemUrl = `${R2_ENDPOINT}/${R2_BUCKET}/cordel/nutrition/99-Imported-Food.png`;
    await db.query('UPDATE nutrition_library_items SET image_url = ? WHERE id = ?', [systemUrl, foodId]);
    sendMock.mockClear();

    const res = await upload(gymId, foodId);
    expect(res.status).toBe(200);
    expect(sentCommands('delete')).toHaveLength(0);
  });

  it('leaves another gym’s object alone', async () => {
    const otherUrl = `${R2_ENDPOINT}/${R2_BUCKET}/gyms/someone-else/nutrition/1-Food.png`;
    await db.query('UPDATE nutrition_library_items SET image_url = ? WHERE id = ?', [otherUrl, foodId]);
    sendMock.mockClear();

    await upload(gymId, foodId);
    expect(sentCommands('delete')).toHaveLength(0);
  });
});

// ─── Refusals leave the existing image exactly as it was ─────────────────────

describe('POST /nutrition-library/:id/image — refusals', () => {
  it('returns 415 for an unsupported image type', async () => {
    const res = await upload(gymId, foodId, PNG_BYTES, 'image/bmp');
    expect(res.status).toBe(415);
    expect(sentCommands('put')).toHaveLength(0);
    expect(await imageUrlOf(foodId)).toBeNull();
  });

  it('returns 400 for an empty body', async () => {
    const res = await upload(gymId, foodId, Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('returns 503 when the deployment has no CLOUDFLARE_R2_* configuration', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    const res = await upload(gymId, foodId);
    expect(res.status).toBe(503);
    expect(res.body.missingConfig.length).toBeGreaterThan(0);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('returns 409 when the gym has no storage_folder_prefix', async () => {
    const freshGym = await createTestGym('NutritionLibraryImagesNoPrefix');
    await createTestMembership(freshGym, 'admin');
    const { insertId } = await db.query(
      "INSERT INTO nutrition_library_items (gym_id, name, status) VALUES (?, ?, 'active')",
      [freshGym, 'Test Gym Image Unprefixed Food'],
    );

    const res = await upload(freshGym, insertId as number);
    expect(res.status).toBe(409);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('returns 409 for a deleted food', async () => {
    await db.query("UPDATE nutrition_library_items SET status = 'deleted' WHERE id = ?", [foodId]);
    const res = await upload(gymId, foodId);
    expect(res.status).toBe(409);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('returns 404 for a food that does not exist', async () => {
    const res = await upload(gymId, 99999999);
    expect(res.status).toBe(404);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('leaves the row untouched when the upload itself fails', async () => {
    await upload(gymId, foodId);
    const stored = await imageUrlOf(foodId);
    sendMock.mockReset();
    sendMock.mockRejectedValue(new Error('R2 is down'));

    const res = await upload(gymId, foodId);
    expect(res.status).toBe(502);
    expect(await imageUrlOf(foodId)).toBe(stored);
  });
});
