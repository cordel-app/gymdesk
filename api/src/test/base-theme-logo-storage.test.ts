// #829: a **Base Theme** logo is an object in the platform's own Cloudflare R2
// folder — `cordel/themes/<theme_id>-<sanitized name>/logo/logo.<ext>` — instead
// of a `themes.logo_bytes` MEDIUMBLOB. It reuses the Custom Theme's own columns
// (`logo_object_key`, with `logo_bytes` cleared) rather than a second store, and
// the URL is derived from the key.
//
// Covers the superadmin upload/remove routes (`/platform/themes/:id/logo`), the
// theme payload they surface on, and the public read (`GET /themes/:id/logo`),
// which keeps its blob fallback for a logo uploaded before this change.
//
// Separate from themes.test.ts for the reason base-theme-members-images.test.ts
// is: this file mocks @aws-sdk/client-s3 and moves the CLOUDFLARE_R2_* env around.

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

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');

const THEME_NAME = 'Test Base Theme Logo Storage';
const OTHER_THEME_NAME = 'Test Base Theme Logo Storage Other';

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

/**
 * `cordel/themes/<id>-<Name>/logo/logo.<ext>`. Built here from the same parts
 * the route builds it from rather than imported, so a change to the shape has to
 * be stated in the test too.
 */
function logoKey(id: string, themeName: string, ext: string): string {
  return `cordel/themes/${id}-${themeName.replace(/\s+/g, '')}/logo/logo.${ext}`;
}

/** The four folder markers the upload writes before the object itself. */
function folderMarkers(id: string, themeName: string): string[] {
  const folder = `cordel/themes/${id}-${themeName.replace(/\s+/g, '')}`;
  return ['cordel/', 'cordel/themes/', `${folder}/`, `${folder}/logo/`];
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

function upload(id: string, mime: string, body: Buffer) {
  return request
    .post(`/platform/themes/${id}/logo`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('Content-Type', mime)
    .send(body);
}

function remove(id: string) {
  return request.delete(`/platform/themes/${id}/logo`).set('Authorization', TEST_AUTH_HEADER);
}

async function logoRow(id: string) {
  const { rows } = await db.query<{
    logo_object_key: string | null;
    logo_mime: string | null;
    logo_bytes: Buffer | null;
  }>('SELECT logo_object_key, logo_mime, logo_bytes FROM themes WHERE id = ?', [id]);
  return rows[0];
}

beforeAll(async () => {
  gymId = await createTestGym('BaseThemeLogoStorageGym');
  await createTestMembership(gymId, 'admin');

  baseThemeId = await createBaseTheme(THEME_NAME);
  otherBaseThemeId = await createBaseTheme(OTHER_THEME_NAME);

  await db.query(
    `INSERT INTO themes (id, gym_id, is_system_default, name, status, tokens, created_at)
     VALUES (UUID(), ?, 0, 'Base Theme Logo Storage Custom', 'active', '{}', UTC_TIMESTAMP())`,
    [gymId],
  );
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM themes WHERE gym_id = ? AND name = 'Base Theme Logo Storage Custom' LIMIT 1",
    [gymId],
  );
  customThemeId = rows[0].id;
});

afterAll(async () => {
  await db.query('DELETE FROM themes WHERE gym_id IN (SELECT id FROM gyms WHERE slug LIKE ?)', ['test-%']);
  await db.query("DELETE FROM themes WHERE gym_id IS NULL AND name LIKE 'Test Base Theme Logo Storage%'");
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
    `UPDATE themes SET name = ?, logo_object_key = NULL, logo_bytes = NULL, logo_mime = NULL, logo_updated_at = NULL
     WHERE id = ?`,
    [THEME_NAME, baseThemeId],
  );
  await db.query(
    'UPDATE themes SET logo_object_key = NULL, logo_bytes = NULL, logo_mime = NULL, logo_updated_at = NULL WHERE id IN (?, ?)',
    [otherBaseThemeId, customThemeId],
  );
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── Upload ───────────────────────────────────────────────────────────────────

describe('POST /platform/themes/:id/logo', () => {
  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/platform/themes/${baseThemeId}/logo`)
      .set('Content-Type', 'image/png')
      .send(PNG_BYTES);
    expect(res.status).toBe(401);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('returns 403 for an authenticated non-superadmin', async () => {
    mockAsNonSuperadmin();
    const res = await upload(baseThemeId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(403);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it("stores the file in the theme's own logo folder under cordel/ and keeps only the key on the row", async () => {
    const res = await upload(baseThemeId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);

    const key = logoKey(baseThemeId, THEME_NAME, 'png');
    const puts = sentCommands('put');
    expect(puts[puts.length - 1].input).toMatchObject({ Bucket: R2_BUCKET, Key: key, ContentType: 'image/png' });

    const row = await logoRow(baseThemeId);
    // The bytes are the bucket's now: migration 180's `chk_themes_logo_storage`
    // forbids a row carrying both, and a surviving blob would be a second copy
    // the readers could prefer.
    expect(row).toMatchObject({ logo_object_key: key, logo_mime: 'image/png' });
    expect(row.logo_bytes).toBeNull();

    expect(res.body.has_logo).toBe(true);
    expect(res.body.logo_url).toContain(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
    // Derived, never stored — the column itself stays off the wire.
    expect(res.body.logo_object_key).toBeUndefined();
  });

  it('never uses a gym storage prefix', async () => {
    await upload(baseThemeId, 'image/png', PNG_BYTES);
    for (const command of sentCommands('put')) {
      expect(command.input.Key.startsWith('cordel/')).toBe(true);
      expect(command.input.Key).not.toContain('gyms/');
    }
  });

  it('takes the extension from the validated mime type, never from a file name', async () => {
    const res = await request
      .post(`/platform/themes/${baseThemeId}/logo`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('Content-Type', 'image/svg+xml')
      .set('X-Filename', 'my-awesome-logo.jpeg')
      .send(SVG_BYTES);
    expect(res.status).toBe(200);

    const key = logoKey(baseThemeId, THEME_NAME, 'svg');
    expect((await logoRow(baseThemeId)).logo_object_key).toBe(key);
    expect(key).not.toContain('my-awesome-logo');
    expect(key).not.toContain('jpeg');
  });

  it("creates the platform root, its themes branch, the theme folder and its logo leaf — markers only", async () => {
    await upload(baseThemeId, 'image/png', PNG_BYTES);
    const keys = sentCommands('put').map((c: any) => c.input.Key);
    expect(keys.slice(0, 4)).toEqual(folderMarkers(baseThemeId, THEME_NAME));
    expect(keys.slice(0, 4).every((k: string) => k.endsWith('/'))).toBe(true);
    expect(keys).toHaveLength(5);
  });

  it('replaces a logo of a different type and removes the object it replaced', async () => {
    await upload(baseThemeId, 'image/png', PNG_BYTES);
    sendMock.mockClear();

    const res = await upload(baseThemeId, 'image/svg+xml', SVG_BYTES);
    expect(res.status).toBe(200);
    expect((await logoRow(baseThemeId)).logo_object_key).toBe(logoKey(baseThemeId, THEME_NAME, 'svg'));
    expect(sentCommands('delete').map((c: any) => c.input.Key)).toEqual([logoKey(baseThemeId, THEME_NAME, 'png')]);
  });

  it('overwrites in place — no delete — when the type is unchanged', async () => {
    await upload(baseThemeId, 'image/png', PNG_BYTES);
    sendMock.mockClear();

    await upload(baseThemeId, 'image/png', PNG_BYTES);
    expect(sentCommands('delete')).toHaveLength(0);
    expect((await logoRow(baseThemeId)).logo_object_key).toBe(logoKey(baseThemeId, THEME_NAME, 'png'));
  });

  it('removes the unreachable object when the theme was renamed since the last upload', async () => {
    await upload(baseThemeId, 'image/png', PNG_BYTES);
    const staleKey = logoKey(baseThemeId, THEME_NAME, 'png');
    await db.query('UPDATE themes SET name = ? WHERE id = ?', ['Test Base Theme Logo Storage Renamed', baseThemeId]);
    sendMock.mockClear();

    const res = await upload(baseThemeId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);
    expect((await logoRow(baseThemeId)).logo_object_key)
      .toBe(logoKey(baseThemeId, 'Test Base Theme Logo Storage Renamed', 'png'));
    expect(sentCommands('delete').map((c: any) => c.input.Key)).toEqual([staleKey]);
  });

  it('still saves the new logo when removing the previous object fails', async () => {
    await upload(baseThemeId, 'image/png', PNG_BYTES);
    sendMock.mockReset();
    sendMock.mockImplementation((command: any) =>
      command.__type === 'delete' ? Promise.reject(new Error('R2 delete exploded')) : Promise.resolve({}));

    const res = await upload(baseThemeId, 'image/svg+xml', SVG_BYTES);
    expect(res.status).toBe(200);
    expect((await logoRow(baseThemeId)).logo_object_key).toBe(logoKey(baseThemeId, THEME_NAME, 'svg'));
  });

  it("leaves another Base Theme's logo exactly where it is", async () => {
    await upload(otherBaseThemeId, 'image/png', PNG_BYTES);
    sendMock.mockClear();

    await upload(baseThemeId, 'image/png', PNG_BYTES);
    expect(sentCommands('delete')).toHaveLength(0);
    expect((await logoRow(otherBaseThemeId)).logo_object_key)
      .toBe(logoKey(otherBaseThemeId, OTHER_THEME_NAME, 'png'));
  });

  it("returns 404 for a gym's Custom Theme — a Base Theme route never writes into a gym's folder", async () => {
    const res = await upload(customThemeId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(404);
    expect(sentCommands('put')).toHaveLength(0);
    expect((await logoRow(customThemeId)).logo_object_key).toBeNull();
  });

  it('returns 503 with the missing keys when the deployment has no R2 configured', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    const res = await upload(baseThemeId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(503);
    expect(res.body.stage).toBe('resolve_path');
    expect(res.body.missingConfig).toContain('CLOUDFLARE_R2_BUCKET');
    expect(sentCommands('put')).toHaveLength(0);
    expect((await logoRow(baseThemeId)).logo_object_key).toBeNull();
  });

  it('returns 502 naming the stage and path when the upload fails, and stores nothing', async () => {
    sendMock.mockReset();
    sendMock.mockImplementation((command: any) =>
      command.input.Key.endsWith('/') ? Promise.resolve({}) : Promise.reject(new Error('R2 upload exploded')));

    const res = await upload(baseThemeId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(502);
    expect(res.body.stage).toBe('upload_logo');
    expect(res.body.path).toBe(logoKey(baseThemeId, THEME_NAME, 'png'));
    expect(res.body.details.operation).toBe('uploadStorageObject');
    expect((await logoRow(baseThemeId)).logo_object_key).toBeNull();
  });

  it('returns 502 naming the folder stage when a marker write fails, and uploads nothing', async () => {
    sendMock.mockReset();
    sendMock.mockImplementation((command: any) =>
      command.input.Key.endsWith('/logo/') ? Promise.reject(new Error('R2 marker exploded')) : Promise.resolve({}));

    const res = await upload(baseThemeId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(502);
    expect(res.body.stage).toBe('create_logo_folder');
    expect((await logoRow(baseThemeId)).logo_object_key).toBeNull();
  });

  it('returns 415 for an unsupported image type before touching storage', async () => {
    const res = await upload(baseThemeId, 'image/gif', PNG_BYTES);
    expect(res.status).toBe(415);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('returns 413 for a logo over 512 KB', async () => {
    const tooBig = Buffer.concat([PNG_BYTES, Buffer.alloc(512 * 1024)]);
    const res = await upload(baseThemeId, 'image/png', tooBig);
    expect(res.status).toBe(413);
    expect(sentCommands('put')).toHaveLength(0);
  });
});

// ─── Remove ───────────────────────────────────────────────────────────────────

describe('DELETE /platform/themes/:id/logo', () => {
  it('removes the R2 object and clears the row', async () => {
    await upload(baseThemeId, 'image/png', PNG_BYTES);
    sendMock.mockClear();

    const res = await remove(baseThemeId);
    expect(res.status).toBe(200);
    expect(sentCommands('delete').map((c: any) => c.input.Key)).toEqual([logoKey(baseThemeId, THEME_NAME, 'png')]);

    const row = await logoRow(baseThemeId);
    expect(row).toMatchObject({ logo_object_key: null, logo_mime: null });
    expect(res.body.has_logo).toBe(false);
    expect(res.body.logo_url).toBeNull();
  });

  it('keeps the reference when the object could not be removed', async () => {
    await upload(baseThemeId, 'image/png', PNG_BYTES);
    sendMock.mockReset();
    sendMock.mockImplementation((command: any) =>
      command.__type === 'delete' ? Promise.reject(new Error('R2 delete exploded')) : Promise.resolve({}));

    const res = await remove(baseThemeId);
    expect(res.status).toBe(502);
    expect(res.body.stage).toBe('remove_logo');
    // Clearing the reference while the file survives would strand the object.
    expect((await logoRow(baseThemeId)).logo_object_key).toBe(logoKey(baseThemeId, THEME_NAME, 'png'));
  });

  it('still clears a legacy blob logo without calling storage', async () => {
    await db.query(
      'UPDATE themes SET logo_bytes = ?, logo_mime = ?, logo_updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [PNG_BYTES, 'image/png', baseThemeId],
    );
    sendMock.mockClear();

    const res = await remove(baseThemeId);
    expect(res.status).toBe(200);
    expect(sentCommands('delete')).toHaveLength(0);
    const row = await logoRow(baseThemeId);
    expect(row.logo_bytes).toBeNull();
    expect(row.logo_mime).toBeNull();
  });

  it("returns 404 for a gym's Custom Theme", async () => {
    const res = await remove(customThemeId);
    expect(res.status).toBe(404);
  });
});

// ─── The public read keeps serving both storage modes ─────────────────────────

describe('GET /themes/:id/logo for a Base Theme', () => {
  it('serves the R2 object bytes with the stored content type', async () => {
    await upload(baseThemeId, 'image/png', PNG_BYTES);
    sendMock.mockReset();
    sendMock.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array(PNG_BYTES) },
      ContentType: 'image/png',
    });

    const res = await request.get(`/themes/${baseThemeId}/logo`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(sentCommands('get').map((c: any) => c.input.Key)).toEqual([logoKey(baseThemeId, THEME_NAME, 'png')]);
  });

  it('still serves a logo uploaded before #829 from the blob', async () => {
    await db.query(
      'UPDATE themes SET logo_bytes = ?, logo_mime = ?, logo_updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [PNG_BYTES, 'image/png', baseThemeId],
    );
    sendMock.mockClear();

    const res = await request.get(`/themes/${baseThemeId}/logo`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(sentCommands('get')).toHaveLength(0);
  });
});

// ─── The theme payloads carry the derived URL ─────────────────────────────────

describe('Base Theme payloads carry logo_url (#829)', () => {
  it('GET /platform/themes/:id derives it from the stored key', async () => {
    await upload(baseThemeId, 'image/png', PNG_BYTES);

    const res = await request
      .get(`/platform/themes/${baseThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.logo_url).toContain(`${R2_ENDPOINT}/${R2_BUCKET}/${logoKey(baseThemeId, THEME_NAME, 'png')}`);
    expect(res.body.logo_object_key).toBeUndefined();
  });

  it('GET /platform/themes reads null for a theme with no logo', async () => {
    const res = await request.get('/platform/themes').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    const theme = res.body.find((t: any) => t.id === baseThemeId);
    expect(theme.logo_url).toBeNull();
    expect(theme.has_logo).toBe(false);
  });
});
