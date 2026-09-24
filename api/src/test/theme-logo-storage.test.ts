// #713: a Custom Theme logo is stored in the gym's Cloudflare R2 folder under
// `<storage_folder_prefix>/Branding/Logo/logo.<ext>` instead of in
// `themes.logo_bytes`. Covers the gym-admin upload/remove routes
// (`/system/themes/:id/logo`) and the public read (`GET /themes/:id/logo`),
// which now serves either storage mode.
//
// Split out of gym-themes.test.ts because these tests mock @aws-sdk/client-s3
// and move the CLOUDFLARE_R2_* env around — the same reason storage-uploads.test.ts
// is separate from the routers it exercises.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// The real SDK must never hit the network in tests — same shape as
// storage-uploads.test.ts, plus the Get/Delete commands this feature adds.
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

let gymId: string;
let otherGymId: string;
let folderPrefix: string;
let otherFolderPrefix: string;
let themeId: string;
let otherThemeId: string;

/** Commands of one kind the mocked S3 client was asked to send. */
function sentCommands(type: 'put' | 'get' | 'delete') {
  return sendMock.mock.calls.map(([command]) => command).filter((c: any) => c?.__type === type);
}

async function createCustomTheme(ownerGymId: string, name: string): Promise<string> {
  await db.query(
    `INSERT INTO themes (id, gym_id, name, status, tokens, created_at)
     VALUES (UUID(), ?, ?, 'active', '{}', UTC_TIMESTAMP())`,
    [ownerGymId, name],
  );
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM themes WHERE gym_id = ? AND name = ? LIMIT 1',
    [ownerGymId, name],
  );
  return rows[0].id;
}

function uploadLogo(id: string, callerGymId: string, mime: string, body: Buffer) {
  return request
    .post(`/system/themes/${id}/logo`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', callerGymId)
    .set('Content-Type', mime)
    .send(body);
}

beforeAll(async () => {
  gymId = await createTestGym('ThemeLogoStorageGym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('ThemeLogoStorageOtherGym');
  await createTestMembership(otherGymId, 'admin');

  folderPrefix = `gyms/${gymId}-ThemeLogoStorageGym`;
  otherFolderPrefix = `gyms/${otherGymId}-ThemeLogoStorageOtherGym`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [folderPrefix, gymId]);
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [otherFolderPrefix, otherGymId]);

  themeId = await createCustomTheme(gymId, 'Theme Logo Storage Custom');
  otherThemeId = await createCustomTheme(otherGymId, 'Theme Logo Storage Other Custom');
});

afterAll(async () => {
  await db.query('DELETE FROM themes WHERE gym_id IN (SELECT id FROM gyms WHERE slug LIKE ?)', ['test-%']);
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
    'UPDATE themes SET logo_bytes = NULL, logo_object_key = NULL, logo_mime = NULL, logo_updated_at = NULL WHERE id IN (?, ?)',
    [themeId, otherThemeId],
  );
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [folderPrefix, gymId]);
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── POST /system/themes/:id/logo ─────────────────────────────────────────────

describe('POST /system/themes/:id/logo', () => {
  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/system/themes/${themeId}/logo`)
      .set('x-gym-id', gymId)
      .set('Content-Type', 'image/png')
      .send(PNG_BYTES);
    expect(res.status).toBe(401);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('returns 403 for a non-admin role', async () => {
    const frontDeskGymId = await createTestGym('ThemeLogoStorageFrontDeskGym');
    await createTestMembership(frontDeskGymId, 'front_desk');
    await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${frontDeskGymId}-FrontDesk`, frontDeskGymId]);
    const frontDeskThemeId = await createCustomTheme(frontDeskGymId, 'Theme Logo Storage Front Desk Theme');

    const res = await uploadLogo(frontDeskThemeId, frontDeskGymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(403);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('stores the file at <prefix>/Branding/Logo/logo.<ext> and keeps only the key on the row', async () => {
    const res = await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);

    const puts = sentCommands('put');
    expect(puts).toHaveLength(1);
    expect(puts[0].input).toMatchObject({
      Bucket: R2_BUCKET,
      Key: `${folderPrefix}/Branding/Logo/logo.png`,
      ContentType: 'image/png',
    });

    const { rows } = await db.query<{ logo_object_key: string | null; logo_bytes: Buffer | null; logo_mime: string | null }>(
      'SELECT logo_object_key, logo_bytes, logo_mime FROM themes WHERE id = ?',
      [themeId],
    );
    expect(rows[0].logo_object_key).toBe(`${folderPrefix}/Branding/Logo/logo.png`);
    expect(rows[0].logo_bytes).toBeNull();
    expect(rows[0].logo_mime).toBe('image/png');

    expect(res.body.has_logo).toBe(true);
    expect(res.body.logo_url).toContain(`${R2_ENDPOINT}/${R2_BUCKET}/${folderPrefix}/Branding/Logo/logo.png`);
    // The binary never comes back on a theme-shaped response.
    expect(res.body.logo_bytes).toBeUndefined();
    expect(res.body.logo_object_key).toBeUndefined();
  });

  it('never uses the uploaded file name, only the validated mime type', async () => {
    const res = await request
      .post(`/system/themes/${themeId}/logo`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('Content-Type', 'image/svg+xml')
      .set('Content-Disposition', 'attachment; filename="../../evil.php"')
      .send(SVG_BYTES);
    expect(res.status).toBe(200);
    expect(sentCommands('put')[0].input.Key).toBe(`${folderPrefix}/Branding/Logo/logo.svg`);
  });

  it('replaces a logo of a different type and removes the previous object', async () => {
    expect((await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES)).status).toBe(200);
    sendMock.mockClear();

    const res = await uploadLogo(themeId, gymId, 'image/svg+xml', SVG_BYTES);
    expect(res.status).toBe(200);
    expect(sentCommands('put')[0].input.Key).toBe(`${folderPrefix}/Branding/Logo/logo.svg`);
    // The old extension must not survive as an orphan.
    expect(sentCommands('delete').map((c: any) => c.input.Key)).toEqual([`${folderPrefix}/Branding/Logo/logo.png`]);

    const { rows } = await db.query<{ logo_object_key: string }>('SELECT logo_object_key FROM themes WHERE id = ?', [themeId]);
    expect(rows[0].logo_object_key).toBe(`${folderPrefix}/Branding/Logo/logo.svg`);
  });

  it('overwrites in place — no delete — when the type is unchanged', async () => {
    expect((await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES)).status).toBe(200);
    sendMock.mockClear();

    const res = await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);
    expect(sentCommands('put')[0].input.Key).toBe(`${folderPrefix}/Branding/Logo/logo.png`);
    expect(sentCommands('delete')).toHaveLength(0);
  });

  it('still saves the new logo when removing the previous object fails', async () => {
    expect((await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES)).status).toBe(200);
    sendMock.mockReset();
    sendMock.mockImplementation((command: any) =>
      command.__type === 'delete' ? Promise.reject(new Error('R2 down')) : Promise.resolve({}));

    const res = await uploadLogo(themeId, gymId, 'image/webp', PNG_BYTES);
    expect(res.status).toBe(200);
    const { rows } = await db.query<{ logo_object_key: string }>('SELECT logo_object_key FROM themes WHERE id = ?', [themeId]);
    expect(rows[0].logo_object_key).toBe(`${folderPrefix}/Branding/Logo/logo.webp`);
  });

  // The key names the gym, not the theme, so a gym holds one branding logo at a
  // time and the upload has to hand the slot over — otherwise a sibling theme
  // would keep pointing at a file this upload replaced or removed.
  it('takes the branding slot from the gym\'s other themes', async () => {
    const siblingId = await createCustomTheme(gymId, 'Theme Logo Storage Sibling');
    expect((await uploadLogo(siblingId, gymId, 'image/png', PNG_BYTES)).status).toBe(200);
    sendMock.mockClear();

    const res = await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);
    expect(res.body.has_logo).toBe(true);

    const { rows } = await db.query<{ id: string; logo_object_key: string | null; logo_mime: string | null }>(
      'SELECT id, logo_object_key, logo_mime FROM themes WHERE gym_id = ? ORDER BY name',
      [gymId],
    );
    const sibling = rows.find((r) => r.id === siblingId)!;
    expect(sibling.logo_object_key).toBeNull();
    expect(sibling.logo_mime).toBeNull();
    // Exactly one theme of the gym claims the branding logo.
    expect(rows.filter((r) => r.logo_object_key !== null)).toHaveLength(1);

    await db.query('DELETE FROM themes WHERE id = ?', [siblingId]);
  });

  it('does not touch another gym\'s logo when taking its own branding slot', async () => {
    expect((await uploadLogo(otherThemeId, otherGymId, 'image/png', PNG_BYTES)).status).toBe(200);
    expect((await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES)).status).toBe(200);

    const { rows } = await db.query<{ logo_object_key: string | null }>(
      'SELECT logo_object_key FROM themes WHERE id = ?',
      [otherThemeId],
    );
    expect(rows[0].logo_object_key).toBe(`${otherFolderPrefix}/Branding/Logo/logo.png`);
  });

  it('uploads into the calling gym\'s own folder and 404s on another gym\'s theme', async () => {
    const res = await uploadLogo(otherThemeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(404);
    expect(sentCommands('put')).toHaveLength(0);

    // …and the owner's own upload lands under the owner's prefix, never the caller's.
    const owned = await uploadLogo(otherThemeId, otherGymId, 'image/png', PNG_BYTES);
    expect(owned.status).toBe(200);
    expect(sentCommands('put')[0].input.Key).toBe(`${otherFolderPrefix}/Branding/Logo/logo.png`);
  });

  it('returns 409 when the gym has no storage folder yet, and stores nothing', async () => {
    await db.query('UPDATE gyms SET storage_folder_prefix = NULL WHERE id = ?', [gymId]);
    const res = await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cloudflare storage has not been initialized for this gym, therefore images cannot be uploaded.');
    expect(sentCommands('put')).toHaveLength(0);

    const { rows } = await db.query<{ logo_object_key: string | null }>('SELECT logo_object_key FROM themes WHERE id = ?', [themeId]);
    expect(rows[0].logo_object_key).toBeNull();
  });

  it('returns 503 with the missing keys when the deployment has no R2 configured', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    const res = await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(503);
    expect(res.body.missingConfig).toEqual([...R2_ENV_KEYS]);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('returns 502 and leaves the row untouched when the R2 upload fails', async () => {
    sendMock.mockRejectedValue(Object.assign(new Error('NoSuchBucket'), { name: 'NoSuchBucket' }));
    const res = await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(502);
    expect(res.body.details.operation).toBe('uploadStorageObject');
    // Gym-facing route: structured details, but never the platform config snapshot.
    expect(res.body.diagnostics).toBeUndefined();

    const { rows } = await db.query<{ logo_object_key: string | null; logo_mime: string | null }>(
      'SELECT logo_object_key, logo_mime FROM themes WHERE id = ?',
      [themeId],
    );
    expect(rows[0].logo_object_key).toBeNull();
    expect(rows[0].logo_mime).toBeNull();
  });

  it('returns 415 for an unsupported image type before touching storage', async () => {
    const res = await uploadLogo(themeId, gymId, 'image/tiff', PNG_BYTES);
    expect(res.status).toBe(415);
    expect(sentCommands('put')).toHaveLength(0);
  });
});

// ─── DELETE /system/themes/:id/logo ───────────────────────────────────────────

describe('DELETE /system/themes/:id/logo', () => {
  function removeLogo(id: string, callerGymId: string) {
    return request
      .delete(`/system/themes/${id}/logo`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', callerGymId);
  }

  it('removes the R2 object and clears the row', async () => {
    expect((await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES)).status).toBe(200);
    sendMock.mockClear();

    const res = await removeLogo(themeId, gymId);
    expect(res.status).toBe(200);
    expect(res.body.has_logo).toBe(false);
    expect(res.body.logo_url).toBeNull();
    expect(sentCommands('delete').map((c: any) => c.input.Key)).toEqual([`${folderPrefix}/Branding/Logo/logo.png`]);

    const { rows } = await db.query<{ logo_object_key: string | null; logo_mime: string | null }>(
      'SELECT logo_object_key, logo_mime FROM themes WHERE id = ?',
      [themeId],
    );
    expect(rows[0].logo_object_key).toBeNull();
    expect(rows[0].logo_mime).toBeNull();
  });

  it('keeps the reference when the object could not be removed', async () => {
    expect((await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES)).status).toBe(200);
    sendMock.mockReset();
    sendMock.mockRejectedValue(new Error('R2 down'));

    const res = await removeLogo(themeId, gymId);
    expect(res.status).toBe(502);

    const { rows } = await db.query<{ logo_object_key: string | null }>('SELECT logo_object_key FROM themes WHERE id = ?', [themeId]);
    expect(rows[0].logo_object_key).toBe(`${folderPrefix}/Branding/Logo/logo.png`);
  });

  it('still clears a legacy blob logo without calling storage', async () => {
    await db.query(
      "UPDATE themes SET logo_bytes = ?, logo_mime = 'image/png', logo_updated_at = UTC_TIMESTAMP() WHERE id = ?",
      [PNG_BYTES, themeId],
    );
    const res = await removeLogo(themeId, gymId);
    expect(res.status).toBe(200);
    expect(res.body.has_logo).toBe(false);
    expect(sentCommands('delete')).toHaveLength(0);
  });

  it('returns 404 for another gym\'s theme (tenant isolation)', async () => {
    const res = await removeLogo(otherThemeId, gymId);
    expect(res.status).toBe(404);
    expect(sentCommands('delete')).toHaveLength(0);
  });
});

// ─── GET /themes/:id/logo (public) ────────────────────────────────────────────

describe('GET /themes/:id/logo', () => {
  it('serves the R2 object bytes with the stored content type', async () => {
    expect((await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES)).status).toBe(200);
    sendMock.mockReset();
    sendMock.mockResolvedValue({
      ContentType: 'image/png',
      Body: { transformToByteArray: async () => new Uint8Array(PNG_BYTES) },
    });

    const res = await request.get(`/themes/${themeId}/logo`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(Buffer.from(res.body).equals(PNG_BYTES)).toBe(true);
    expect(sentCommands('get')[0].input).toMatchObject({
      Bucket: R2_BUCKET,
      Key: `${folderPrefix}/Branding/Logo/logo.png`,
    });
  });

  it('still serves a legacy blob logo', async () => {
    await db.query(
      "UPDATE themes SET logo_bytes = ?, logo_object_key = NULL, logo_mime = 'image/png', logo_updated_at = UTC_TIMESTAMP() WHERE id = ?",
      [PNG_BYTES, themeId],
    );
    const res = await request.get(`/themes/${themeId}/logo`);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(PNG_BYTES)).toBe(true);
    expect(sentCommands('get')).toHaveLength(0);
  });

  it('returns 404 when the stored object is gone', async () => {
    expect((await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES)).status).toBe(200);
    sendMock.mockReset();
    sendMock.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));

    const res = await request.get(`/themes/${themeId}/logo`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a theme with no logo at all', async () => {
    const res = await request.get(`/themes/${themeId}/logo`);
    expect(res.status).toBe(404);
  });
});
