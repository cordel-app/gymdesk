// #2287: a Theme's Home Image (`home/home.webp`, 1080 x 1080 WebP, no thumbnail) — Custom Theme
// (`/system/themes/:id/home-image`) and Base Theme (`/platform/themes/:id/home-image`)
// upload/remove, server-side WebP conversion, independence from the full logo and
// tenant isolation. Mocks @aws-sdk/client-s3 like the other logo storage suites.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createClerkClient } from '@clerk/backend';
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

const R2_ENV_KEYS = ['CLOUDFLARE_R2_ENDPOINT', 'CLOUDFLARE_R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_R2_BUCKET'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of R2_ENV_KEYS) originalEnv[key] = process.env[key];

function setStorageConfigured() {
  process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'k';
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 's';
  process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
}

function mockSuperadmin(isSuper: boolean) {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) {
    vi.mocked(client.users.getUser).mockResolvedValue({
      publicMetadata: isSuper ? { platform_role: 'superadmin' } : {},
      fullName: 'Test Admin', firstName: 'Test', lastName: 'Admin',
    } as any);
  }
}

const GYM_THEME = 'Home Image Custom';
const BASE_THEME = 'Test Home Image Base';
let gymId: string;
let otherGymId: string;
let gymThemeId: string;
let otherGymThemeId: string;
let baseThemeId: string;

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 200, g: 20, b: 20, alpha: 0.5 } } }).png().toBuffer();
}

function putCommands() {
  return sendMock.mock.calls.map(([c]) => c).filter((c: any) => c?.__type === 'put');
}
function deleteKeys() {
  return sendMock.mock.calls.map(([c]) => c).filter((c: any) => c?.__type === 'delete').map((c: any) => c.input.Key);
}

async function insertTheme(owner: string | null, name: string): Promise<string> {
  await db.query(
    `INSERT INTO themes (id, gym_id, is_system_default, name, status, tokens, created_at)
     VALUES (UUID(), ?, 0, ?, 'active', '{}', UTC_TIMESTAMP())`,
    [owner, name],
  );
  const { rows } = await db.query<{ id: string }>(
    owner ? 'SELECT id FROM themes WHERE gym_id = ? AND name = ? LIMIT 1' : 'SELECT id FROM themes WHERE gym_id IS NULL AND name = ? LIMIT 1',
    owner ? [owner, name] : [name],
  );
  return rows[0].id;
}

const uploadGym = (id: string, callerGym: string, body: Buffer, mime = 'image/png') =>
  request.post(`/system/themes/${id}/home-image`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', callerGym).set('Content-Type', mime).send(body);
const removeGym = (id: string, callerGym: string) =>
  request.delete(`/system/themes/${id}/home-image`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', callerGym);
const uploadBase = (id: string, body: Buffer, mime = 'image/png') =>
  request.post(`/platform/themes/${id}/home-image`).set('Authorization', TEST_AUTH_HEADER).set('Content-Type', mime).send(body);
const removeBase = (id: string) => request.delete(`/platform/themes/${id}/home-image`).set('Authorization', TEST_AUTH_HEADER);

beforeAll(async () => {
  gymId = await createTestGym('HomeImageGym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('HomeImageOtherGym');
  await createTestMembership(otherGymId, 'admin');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${gymId}-HomeImageGym`, gymId]);
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${otherGymId}-HomeImageOtherGym`, otherGymId]);
  gymThemeId = await insertTheme(gymId, GYM_THEME);
  otherGymThemeId = await insertTheme(otherGymId, GYM_THEME);
  baseThemeId = await insertTheme(null, BASE_THEME);
});

afterAll(async () => {
  await db.query("DELETE FROM themes WHERE gym_id IS NULL AND name LIKE 'Test Home Image%'");
  await db.query('DELETE FROM themes WHERE gym_id IN (?, ?)', [gymId, otherGymId]);
  await cleanupTestGyms();
  for (const key of R2_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await db.end();
});

beforeEach(async () => {
  setStorageConfigured();
  mockSuperadmin(true);
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
  await db.query(
    "UPDATE themes SET home_image_object_key = NULL, logo_object_key = 'keep/logo.png', logo_mime = 'image/png' WHERE id IN (?, ?, ?)",
    [gymThemeId, otherGymThemeId, baseThemeId],
  );
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

describe('Theme Home Image', () => {
  it('401 without auth', async () => {
    const res = await request.post(`/system/themes/${gymThemeId}/home-image`).set('x-gym-id', gymId).set('Content-Type', 'image/png').send(await png(8, 8));
    expect(res.status).toBe(401);
  });

  it('Custom: stores a 1080x1080 WebP at themes/<id>-<name>/home/home.webp, no thumbnail, logo untouched', async () => {
    const res = await uploadGym(gymThemeId, gymId, await png(1600, 900));
    expect(res.status).toBe(200);
    const key = `gyms/${gymId}-HomeImageGym/themes/${gymThemeId}-HomeImageCustom/home/home.webp`;
    const puts = putCommands().filter((c: any) => !String(c.input.Key).endsWith('/'));
    expect(puts.map((c: any) => c.input.Key)).toEqual([key]);
    const meta = await sharp((puts[0] as any).input.Body).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 1080, 1080]);
    expect(res.body.home_image_url).toContain(key);
    expect(res.body.home_image_object_key).toBeUndefined();
    const { rows } = await db.query<{ logo_object_key: string }>('SELECT logo_object_key FROM themes WHERE id = ?', [gymThemeId]);
    expect(rows[0].logo_object_key).toBe('keep/logo.png');
  });

  it('rejects a non-image body', async () => {
    const res = await uploadGym(gymThemeId, gymId, Buffer.from('not an image at all'));
    expect(res.status).toBe(415);
    expect(putCommands()).toHaveLength(0);
  });

  it("another gym's theme is a 404", async () => {
    const res = await uploadGym(otherGymThemeId, gymId, await png(16, 16));
    expect(res.status).toBe(404);
  });

  it('remove deletes the object and clears the reference', async () => {
    expect((await uploadGym(gymThemeId, gymId, await png(16, 16))).status).toBe(200);
    sendMock.mockClear();
    const res = await removeGym(gymThemeId, gymId);
    expect(res.status).toBe(200);
    expect(res.body.home_image_url).toBeNull();
    expect(deleteKeys()).toEqual([`gyms/${gymId}-HomeImageGym/themes/${gymThemeId}-HomeImageCustom/home/home.webp`]);
  });

  it('Base: 403 for a non-superadmin; superadmin stores under cordel/themes/', async () => {
    mockSuperadmin(false);
    expect((await uploadBase(baseThemeId, await png(16, 16))).status).toBe(403);
    mockSuperadmin(true);
    const res = await uploadBase(baseThemeId, await png(600, 600));
    expect(res.status).toBe(200);
    const key = `cordel/themes/${baseThemeId}-${BASE_THEME.replace(/\s+/g, '')}/home/home.webp`;
    expect(putCommands().some((c: any) => c.input.Key === key)).toBe(true);
    expect(res.body.home_image_url).toContain(key);
    const rm = await removeBase(baseThemeId);
    expect(rm.status).toBe(200);
    expect(rm.body.home_image_url).toBeNull();
  });

  it('Home dashboard uses the active theme Home Image over the exercise fallback', async () => {
    await uploadGym(gymThemeId, gymId, await png(16, 16));
    await db.query('UPDATE gyms SET theme_id = ? WHERE id = ?', [gymThemeId, gymId]);
    const res = await request.get('/dashboard/home').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.welcome_image_url).toContain('/home/home.webp');
    expect(res.body.welcome_exercise_id).toBeNull();
  });
});
