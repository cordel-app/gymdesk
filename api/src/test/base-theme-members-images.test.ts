// #732: the six Members App background images of a **Base Theme**, stored in
// the platform's own Cloudflare R2 folder under
// `cordel/Themes/<theme_id>-<name>/Members/<slot>.png`.
// Covers the upload and remove routes (`/platform/themes/:id/members-images/:slot`),
// the theme payload they surface on, what a gym is served for a Base Theme and
// what the Members App reads (`/me/gym`).
//
// Separate from themes.test.ts for the same reason theme-members-images.test.ts
// is separate from gym-themes.test.ts: this file mocks @aws-sdk/client-s3 and
// moves the CLOUDFLARE_R2_* env around.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

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

// Minimal but genuine headers — the server validates the bytes, not the header.
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const NOT_AN_IMAGE = Buffer.from('<html>definitely not a png</html>');

const THEME_NAME = 'Test Base Theme Members Images';
const OTHER_THEME_NAME = 'Test Base Theme Members Images Other';

const superadminUser = {
  publicMetadata: { platform_role: 'superadmin' },
  fullName: 'Test Admin',
  firstName: 'Test',
  lastName: 'Admin',
};

const regularUser = {
  publicMetadata: {},
  fullName: 'Test User',
  firstName: 'Test',
  lastName: 'User',
};

function mockAsSuperadmin() {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue(superadminUser as any);
}

function mockAsNonSuperadmin() {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue(regularUser as any);
}

let baseThemeId: string;
let otherBaseThemeId: string;
let customThemeId: string;
let gymId: string;

function sentCommands(type: 'put' | 'get' | 'delete') {
  return sendMock.mock.calls.map(([command]) => command).filter((c: any) => c?.__type === type);
}

async function createBaseTheme(name: string): Promise<string> {
  await db.query(
    `INSERT INTO themes (id, gym_id, is_system_default, name, status, tokens, created_at)
     VALUES (UUID(), NULL, 0, ?, 'active', '{}', UTC_TIMESTAMP())`,
    [name],
  );
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM themes WHERE gym_id IS NULL AND name = ? LIMIT 1',
    [name],
  );
  return rows[0].id;
}

function upload(id: string, slot: string, mime: string, body: Buffer) {
  return request
    .post(`/platform/themes/${id}/members-images/${slot}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('Content-Type', mime)
    .send(body);
}

function remove(id: string, slot: string) {
  return request
    .delete(`/platform/themes/${id}/members-images/${slot}`)
    .set('Authorization', TEST_AUTH_HEADER);
}

/** `cordel/Themes/<id>-<Name>/Members/<slot>.png` — the key the route derives. */
function keyFor(theme: string, name: string, slot: string) {
  return `cordel/Themes/${theme}-${name.replace(/\s+/g, '')}/Members/${slot}.png`;
}

beforeAll(async () => {
  gymId = await createTestGym('BaseThemeMembersImagesGym');
  await createTestMembership(gymId, 'admin');

  baseThemeId = await createBaseTheme(THEME_NAME);
  otherBaseThemeId = await createBaseTheme(OTHER_THEME_NAME);

  await db.query(
    `INSERT INTO themes (id, gym_id, is_system_default, name, status, tokens, created_at)
     VALUES (UUID(), ?, 0, 'Base Theme Members Images Custom', 'active', '{}', UTC_TIMESTAMP())`,
    [gymId],
  );
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM themes WHERE gym_id = ? AND name = 'Base Theme Members Images Custom' LIMIT 1",
    [gymId],
  );
  customThemeId = rows[0].id;
});

afterAll(async () => {
  await db.query('DELETE FROM theme_member_images WHERE theme_id IN (?, ?, ?)', [baseThemeId, otherBaseThemeId, customThemeId]);
  await db.query('DELETE FROM themes WHERE gym_id IN (SELECT id FROM gyms WHERE slug LIKE ?)', ['test-%']);
  await db.query("DELETE FROM themes WHERE gym_id IS NULL AND name LIKE 'Test Base Theme Members Images%'");
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
  await db.query('DELETE FROM theme_member_images WHERE theme_id IN (?, ?, ?)', [baseThemeId, otherBaseThemeId, customThemeId]);
  await db.query('UPDATE themes SET name = ? WHERE id = ?', [THEME_NAME, baseThemeId]);
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── Upload ───────────────────────────────────────────────────────────────────

describe('POST /platform/themes/:id/members-images/:slot', () => {
  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/platform/themes/${baseThemeId}/members-images/training`)
      .set('Content-Type', 'image/png')
      .send(PNG_BYTES);
    expect(res.status).toBe(401);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('returns 403 for an authenticated non-superadmin', async () => {
    mockAsNonSuperadmin();
    const res = await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    expect(res.status).toBe(403);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('stores the file under cordel/ at the slot\'s deterministic key and records the reference', async () => {
    const res = await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);

    const key = keyFor(baseThemeId, THEME_NAME, 'training');
    expect(key.startsWith('cordel/Themes/')).toBe(true);
    const puts = sentCommands('put');
    expect(puts[puts.length - 1].input).toMatchObject({ Bucket: R2_BUCKET, Key: key, ContentType: 'image/png' });

    const { rows } = await db.query<{ slot: string; object_key: string; gym_id: string | null }>(
      'SELECT slot, object_key, gym_id FROM theme_member_images WHERE theme_id = ?',
      [baseThemeId],
    );
    expect(rows).toHaveLength(1);
    // The platform owns it: `gym_id IS NULL` is what says so (migration 182).
    expect(rows[0]).toMatchObject({ slot: 'training', object_key: key, gym_id: null });

    expect(res.body.members_images.training_url).toContain(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
    expect(res.body.members_images.nutrition_url).toBeNull();
  });

  it('never uses a gym storage prefix', async () => {
    await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    for (const command of sentCommands('put')) {
      expect(command.input.Key.startsWith('cordel/')).toBe(true);
      expect(command.input.Key).not.toContain('gyms/');
    }
  });

  it('creates the whole missing folder hierarchy before the upload, and only markers', async () => {
    await upload(baseThemeId, 'calendar', 'image/png', PNG_BYTES);
    const keys = sentCommands('put').map((c: any) => c.input.Key);
    const themeFolder = `cordel/Themes/${baseThemeId}-${THEME_NAME.replace(/\s+/g, '')}`;
    expect(keys.slice(0, 4)).toEqual([
      'cordel/',
      'cordel/Themes/',
      `${themeFolder}/`,
      `${themeFolder}/Members/`,
    ]);
    expect(keys.slice(0, 4).every((k: string) => k.endsWith('/'))).toBe(true);
    expect(keys).toHaveLength(5);
  });

  it('is idempotent about the hierarchy — a second upload rewrites the same markers', async () => {
    await upload(baseThemeId, 'calendar', 'image/png', PNG_BYTES);
    sendMock.mockClear();
    await upload(baseThemeId, 'bookings', 'image/png', PNG_BYTES);
    const keys = sentCommands('put').map((c: any) => c.input.Key);
    expect(keys.filter((k: string) => k.endsWith('/'))).toHaveLength(4);
    expect(sentCommands('delete')).toHaveLength(0);
  });

  it('ignores the uploaded file name and type when naming the object', async () => {
    const res = await upload(baseThemeId, 'nutrition', 'image/jpeg', JPEG_BYTES);
    expect(res.status).toBe(200);
    const key = keyFor(baseThemeId, THEME_NAME, 'nutrition');
    const puts = sentCommands('put');
    // `.png` is the slot's fixed name; the validated MIME is what the object carries.
    expect(puts[puts.length - 1].input).toMatchObject({ Key: key, ContentType: 'image/jpeg' });
  });

  it('replaces an image at the same key without creating a second object', async () => {
    await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    sendMock.mockClear();
    const res = await upload(baseThemeId, 'training', 'image/jpeg', JPEG_BYTES);
    expect(res.status).toBe(200);

    const key = keyFor(baseThemeId, THEME_NAME, 'training');
    const { rows } = await db.query<{ object_key: string }>(
      'SELECT object_key FROM theme_member_images WHERE theme_id = ? AND slot = ?',
      [baseThemeId, 'training'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].object_key).toBe(key);
    expect(sentCommands('delete')).toHaveLength(0);
  });

  it('rejects a non-image body whatever the header claims, and keeps the existing image', async () => {
    await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    const res = await upload(baseThemeId, 'training', 'image/png', NOT_AN_IMAGE);
    expect(res.status).toBe(400);

    const { rows } = await db.query<{ object_key: string }>(
      'SELECT object_key FROM theme_member_images WHERE theme_id = ? AND slot = ?',
      [baseThemeId, 'training'],
    );
    expect(rows[0].object_key).toBe(keyFor(baseThemeId, THEME_NAME, 'training'));
  });

  it('rejects an unsupported image type with 415', async () => {
    const res = await upload(baseThemeId, 'training', 'image/gif', PNG_BYTES);
    expect(res.status).toBe(415);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('rejects an unknown slot with 400', async () => {
    const res = await upload(baseThemeId, 'dashboard', 'image/png', PNG_BYTES);
    expect(res.status).toBe(400);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('returns 503 when the deployment has no R2 configuration', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    const res = await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    expect(res.status).toBe(503);
    expect(res.body.missingConfig).toEqual(expect.arrayContaining(['CLOUDFLARE_R2_BUCKET']));
  });

  it('returns 404 for a Custom Theme — a gym\'s theme is not the platform\'s to write', async () => {
    const res = await upload(customThemeId, 'training', 'image/png', PNG_BYTES);
    expect(res.status).toBe(404);
    expect(sentCommands('put')).toHaveLength(0);

    const { rows } = await db.query('SELECT id FROM theme_member_images WHERE theme_id = ?', [customThemeId]);
    expect(rows).toHaveLength(0);
  });

  it('writes only the named theme\'s slot — another Base Theme is untouched', async () => {
    await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    const { rows } = await db.query('SELECT id FROM theme_member_images WHERE theme_id = ?', [otherBaseThemeId]);
    expect(rows).toHaveLength(0);
  });

  it('removes the unreachable object when the theme was renamed since the last upload', async () => {
    await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    const staleKey = keyFor(baseThemeId, THEME_NAME, 'training');
    await db.query('UPDATE themes SET name = ? WHERE id = ?', ['Test Base Theme Members Images Renamed', baseThemeId]);
    sendMock.mockClear();

    const res = await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);
    const newKey = keyFor(baseThemeId, 'Test Base Theme Members Images Renamed', 'training');
    expect(sentCommands('delete').map((c: any) => c.input.Key)).toEqual([staleKey]);
    const { rows } = await db.query<{ object_key: string }>(
      'SELECT object_key FROM theme_member_images WHERE theme_id = ? AND slot = ?',
      [baseThemeId, 'training'],
    );
    expect(rows[0].object_key).toBe(newKey);
  });
});

// ─── Remove ───────────────────────────────────────────────────────────────────

describe('DELETE /platform/themes/:id/members-images/:slot', () => {
  it('clears the reference and leaves the object in the bucket', async () => {
    await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    sendMock.mockClear();

    const res = await remove(baseThemeId, 'training');
    expect(res.status).toBe(200);
    expect(res.body.members_images.training_url).toBeNull();
    // #732: Remove does not delete the R2 object.
    expect(sentCommands('delete')).toHaveLength(0);

    const { rows } = await db.query('SELECT id FROM theme_member_images WHERE theme_id = ? AND slot = ?', [baseThemeId, 'training']);
    expect(rows).toHaveLength(0);
  });

  it('leaves the other slots alone', async () => {
    await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    await upload(baseThemeId, 'nutrition', 'image/png', PNG_BYTES);

    const res = await remove(baseThemeId, 'training');
    expect(res.body.members_images.training_url).toBeNull();
    expect(res.body.members_images.nutrition_url).toContain(keyFor(baseThemeId, THEME_NAME, 'nutrition'));
  });

  it('re-uploading a removed slot reuses the same deterministic key', async () => {
    await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    await remove(baseThemeId, 'training');
    sendMock.mockClear();

    const res = await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);
    const key = keyFor(baseThemeId, THEME_NAME, 'training');
    expect(res.body.members_images.training_url).toContain(key);
    const { rows } = await db.query<{ object_key: string }>(
      'SELECT object_key FROM theme_member_images WHERE theme_id = ?',
      [baseThemeId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].object_key).toBe(key);
  });

  it('returns 403 for an authenticated non-superadmin', async () => {
    await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    mockAsNonSuperadmin();
    const res = await remove(baseThemeId, 'training');
    expect(res.status).toBe(403);

    mockAsSuperadmin();
    const { rows } = await db.query('SELECT id FROM theme_member_images WHERE theme_id = ?', [baseThemeId]);
    expect(rows).toHaveLength(1);
  });

  it('returns 404 for a Custom Theme', async () => {
    const res = await remove(customThemeId, 'training');
    expect(res.status).toBe(404);
  });
});

// ─── The theme payload ────────────────────────────────────────────────────────

describe('Base Theme payloads carry the Members configuration', () => {
  it('GET /platform/themes returns all six fields per theme', async () => {
    await upload(baseThemeId, 'membership', 'image/png', PNG_BYTES);
    const res = await request.get('/platform/themes').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);

    const theme = res.body.find((t: any) => t.id === baseThemeId);
    expect(Object.keys(theme.members_images).sort()).toEqual(
      ['background_url', 'bookings_url', 'calendar_url', 'membership_url', 'nutrition_url', 'training_url'],
    );
    expect(theme.members_images.membership_url).toContain(keyFor(baseThemeId, THEME_NAME, 'membership'));
    expect(theme.members_images.training_url).toBeNull();

    // One theme's rows never leak onto another's.
    const other = res.body.find((t: any) => t.id === otherBaseThemeId);
    expect(other.members_images.membership_url).toBeNull();
  });

  it('GET /platform/themes/:id returns the configuration of that theme', async () => {
    await upload(baseThemeId, 'bookings', 'image/png', PNG_BYTES);
    const res = await request.get(`/platform/themes/${baseThemeId}`).set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.members_images.bookings_url).toContain(keyFor(baseThemeId, THEME_NAME, 'bookings'));
  });

  it('a clone of a Base Theme starts with its own, empty configuration', async () => {
    await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    const res = await request
      .post(`/platform/themes/clone/${baseThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: 'Test Base Theme Members Images Clone' });
    expect(res.status).toBe(201);
    // Independent by construction: cloning has never copied a theme's R2
    // assets, so the clone shares no object path with its source and cannot be
    // changed by it.
    expect(res.body.members_images.training_url).toBeNull();

    const { rows } = await db.query('SELECT id FROM theme_member_images WHERE theme_id = ?', [res.body.id]);
    expect(rows).toHaveLength(0);

    // …and the source keeps its own.
    const source = await request.get(`/platform/themes/${baseThemeId}`).set('Authorization', TEST_AUTH_HEADER);
    expect(source.body.members_images.training_url).toContain(keyFor(baseThemeId, THEME_NAME, 'training'));

    await db.query('DELETE FROM themes WHERE id = ?', [res.body.id]);
  });
});

// ─── What a gym and the Members App read ──────────────────────────────────────

describe('A Base Theme\'s images reach the gym and the Members App', () => {
  it('the gym\'s theme list serves the Base Theme\'s images read-only', async () => {
    await upload(baseThemeId, 'background', 'image/png', PNG_BYTES);
    mockAsNonSuperadmin();

    const res = await request
      .get('/system/themes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const theme = res.body.find((t: any) => t.id === baseThemeId);
    expect(theme.is_base).toBe(true);
    expect(theme.members_images.background_url).toContain(keyFor(baseThemeId, THEME_NAME, 'background'));

    // Read-only: the gym-scoped write routes do not accept a Base Theme.
    const write = await request
      .post(`/system/themes/${baseThemeId}/members-images/background`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('Content-Type', 'image/png')
      .send(PNG_BYTES);
    expect(write.status).toBe(404);
  });

  it('/me/gyms resolves the six URLs for a gym running a Base Theme', async () => {
    await upload(baseThemeId, 'training', 'image/png', PNG_BYTES);
    await db.query('UPDATE gyms SET theme_id = ? WHERE id = ?', [baseThemeId, gymId]);
    mockAsNonSuperadmin();

    const res = await request.get('/me/gyms').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    const theme = res.body.find((g: any) => g.id === gymId).theme;
    expect(theme.id).toBe(baseThemeId);
    expect(theme.members_images.training_url).toContain(keyFor(baseThemeId, THEME_NAME, 'training'));
    expect(theme.members_images.nutrition_url).toBeNull();
    // Only URLs reach the Members App — never a key, a prefix or a theme folder.
    expect(JSON.stringify(theme.members_images)).not.toContain('object_key');

    await db.query('UPDATE gyms SET theme_id = NULL WHERE id = ?', [gymId]);
  });
});
