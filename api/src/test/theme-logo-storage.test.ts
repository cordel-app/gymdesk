// #713: a Custom Theme logo is stored in the gym's Cloudflare R2 folder instead
// of in `themes.logo_bytes`. #824 moved the key into the theme's own folder —
// `<storage_folder_prefix>/themes/<theme_id>-<name>/logo/logo.<ext>` — so each
// theme carries its own logo and nothing writes to the obsolete `Branding/`
// any more. Covers the gym-admin upload/remove routes
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

const THEME_NAME = 'Theme Logo Storage Custom';
const OTHER_THEME_NAME = 'Theme Logo Storage Other Custom';

/**
 * #824: `<prefix>/themes/<theme_id>-<sanitized name>/logo/logo.<ext>`. Built
 * here from the same parts the route builds it from rather than imported, so a
 * change to the shape has to be stated in the test too.
 */
function logoKey(prefix: string, id: string, themeName: string, ext: string): string {
  return `${prefix}/themes/${id}-${themeName.replace(/\s+/g, '')}/logo/logo.${ext}`;
}

/** The two folder markers the upload writes before the object itself. */
function folderMarkers(prefix: string, id: string, themeName: string): string[] {
  const folder = `${prefix}/themes/${id}-${themeName.replace(/\s+/g, '')}`;
  return [`${folder}/`, `${folder}/logo/`];
}

/** Keys of the PUTs that are objects rather than zero-byte folder markers. */
function putObjectKeys(): string[] {
  return sentCommands('put').map((c: any) => c.input.Key).filter((k: string) => !k.endsWith('/'));
}

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

  themeId = await createCustomTheme(gymId, THEME_NAME);
  otherThemeId = await createCustomTheme(otherGymId, OTHER_THEME_NAME);
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

  it("stores the file in the theme's own Logo folder and keeps only the key on the row", async () => {
    const res = await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);
    const key = logoKey(folderPrefix, themeId, THEME_NAME, 'png');

    const objects = sentCommands('put').filter((c: any) => !c.input.Key.endsWith('/'));
    expect(objects).toHaveLength(1);
    expect(objects[0].input).toMatchObject({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: 'image/png',
    });
    expect(key).not.toContain('Branding');

    const { rows } = await db.query<{ logo_object_key: string | null; logo_bytes: Buffer | null; logo_mime: string | null }>(
      'SELECT logo_object_key, logo_bytes, logo_mime FROM themes WHERE id = ?',
      [themeId],
    );
    expect(rows[0].logo_object_key).toBe(key);
    expect(rows[0].logo_bytes).toBeNull();
    expect(rows[0].logo_mime).toBe('image/png');

    expect(res.body.has_logo).toBe(true);
    expect(res.body.logo_url).toContain(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
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
    expect(putObjectKeys()).toEqual([logoKey(folderPrefix, themeId, THEME_NAME, 'svg')]);
  });

  // §"The theme folder is automatically created when missing" / "The Logo folder
  // is automatically created when missing" — and the gym-level `themes/` root is
  // not, because Gym Bucket Initialization owns it (#735) and #823 keeps the
  // control disabled until it exists.
  it('creates the theme folder and its Logo leaf, but never the Themes root', async () => {
    expect((await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES)).status).toBe(200);

    const markerKeys = sentCommands('put').map((c: any) => c.input.Key).filter((k: string) => k.endsWith('/'));
    expect(markerKeys).toEqual(folderMarkers(folderPrefix, themeId, THEME_NAME));
    expect(markerKeys).not.toContain(`${folderPrefix}/themes/`);
    expect(markerKeys.some((k: string) => k.includes('Branding'))).toBe(false);
  });

  it('returns 502 naming the folder stage when the marker write fails, and stores nothing', async () => {
    sendMock.mockRejectedValue(Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' }));
    const res = await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(502);
    expect(res.body.stage).toBe('create_theme_folder');
    expect(res.body.path).toBe(`${folderPrefix}/themes/${themeId}-${THEME_NAME.replace(/\s+/g, '')}/`);
    expect(res.body.details.operation).toBe('ensureStorageFolders');

    const { rows } = await db.query<{ logo_object_key: string | null }>('SELECT logo_object_key FROM themes WHERE id = ?', [themeId]);
    expect(rows[0].logo_object_key).toBeNull();
  });

  it('replaces a logo of a different type and removes the previous object', async () => {
    expect((await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES)).status).toBe(200);
    sendMock.mockClear();

    const res = await uploadLogo(themeId, gymId, 'image/svg+xml', SVG_BYTES);
    expect(res.status).toBe(200);
    expect(putObjectKeys()).toEqual([logoKey(folderPrefix, themeId, THEME_NAME, 'svg')]);
    // The old extension must not survive as an orphan.
    expect(sentCommands('delete').map((c: any) => c.input.Key))
      .toEqual([logoKey(folderPrefix, themeId, THEME_NAME, 'png')]);

    const { rows } = await db.query<{ logo_object_key: string }>('SELECT logo_object_key FROM themes WHERE id = ?', [themeId]);
    expect(rows[0].logo_object_key).toBe(logoKey(folderPrefix, themeId, THEME_NAME, 'svg'));
  });

  it('overwrites in place — no delete — when the type is unchanged', async () => {
    expect((await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES)).status).toBe(200);
    sendMock.mockClear();

    const res = await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);
    expect(putObjectKeys()).toEqual([logoKey(folderPrefix, themeId, THEME_NAME, 'png')]);
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
    expect(rows[0].logo_object_key).toBe(logoKey(folderPrefix, themeId, THEME_NAME, 'webp'));
  });

  // #824: the key names the *theme*, so each theme of a gym keeps its own logo
  // and an upload takes nothing away from its siblings — the hand-over #713
  // needed for one gym-wide key is gone with the key that required it (§6:
  // existing logos are not deleted or moved).
  it("leaves the gym's other themes' logos exactly where they are", async () => {
    const siblingName = 'Theme Logo Storage Sibling';
    const siblingId = await createCustomTheme(gymId, siblingName);
    expect((await uploadLogo(siblingId, gymId, 'image/png', PNG_BYTES)).status).toBe(200);
    sendMock.mockClear();

    const res = await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);
    expect(res.body.has_logo).toBe(true);
    // Nothing of the sibling's is deleted.
    expect(sentCommands('delete')).toHaveLength(0);

    const { rows } = await db.query<{ id: string; logo_object_key: string | null; logo_mime: string | null }>(
      'SELECT id, logo_object_key, logo_mime FROM themes WHERE gym_id = ? ORDER BY name',
      [gymId],
    );
    const sibling = rows.find((r) => r.id === siblingId)!;
    expect(sibling.logo_object_key).toBe(logoKey(folderPrefix, siblingId, siblingName, 'png'));
    expect(sibling.logo_mime).toBe('image/png');
    // Two themes, two logos, two distinct objects.
    expect(rows.filter((r) => r.logo_object_key !== null)).toHaveLength(2);
    expect(sibling.logo_object_key).not.toBe(logoKey(folderPrefix, themeId, THEME_NAME, 'png'));

    await db.query('DELETE FROM themes WHERE id = ?', [siblingId]);
  });

  it("does not touch another gym's logo", async () => {
    expect((await uploadLogo(otherThemeId, otherGymId, 'image/png', PNG_BYTES)).status).toBe(200);
    expect((await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES)).status).toBe(200);

    const { rows } = await db.query<{ logo_object_key: string | null }>(
      'SELECT logo_object_key FROM themes WHERE id = ?',
      [otherThemeId],
    );
    expect(rows[0].logo_object_key).toBe(logoKey(otherFolderPrefix, otherThemeId, OTHER_THEME_NAME, 'png'));
  });

  // §6: a row written before #824 keeps its `Branding/logo/` key and still
  // renders; replacing the logo is what moves it into the theme's folder, and
  // the object it left behind is swept.
  it('moves a legacy Branding/Logo key into the theme folder on the next upload', async () => {
    const legacyKey = `${folderPrefix}/Branding/logo/logo.png`;
    await db.query(
      "UPDATE themes SET logo_object_key = ?, logo_mime = 'image/png', logo_updated_at = UTC_TIMESTAMP() WHERE id = ?",
      [legacyKey, themeId],
    );

    const res = await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);
    expect(putObjectKeys()).toEqual([logoKey(folderPrefix, themeId, THEME_NAME, 'png')]);
    expect(sentCommands('delete').map((c: any) => c.input.Key)).toEqual([legacyKey]);

    const { rows } = await db.query<{ logo_object_key: string }>('SELECT logo_object_key FROM themes WHERE id = ?', [themeId]);
    expect(rows[0].logo_object_key).toBe(logoKey(folderPrefix, themeId, THEME_NAME, 'png'));
  });

  it('uploads into the calling gym\'s own folder and 404s on another gym\'s theme', async () => {
    const res = await uploadLogo(otherThemeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(404);
    expect(sentCommands('put')).toHaveLength(0);

    // …and the owner's own upload lands under the owner's prefix, never the caller's.
    const owned = await uploadLogo(otherThemeId, otherGymId, 'image/png', PNG_BYTES);
    expect(owned.status).toBe(200);
    expect(putObjectKeys()).toEqual([logoKey(otherFolderPrefix, otherThemeId, OTHER_THEME_NAME, 'png')]);
  });

  it('returns 409 when the gym has no storage folder yet, and stores nothing', async () => {
    await db.query('UPDATE gyms SET storage_folder_prefix = NULL WHERE id = ?', [gymId]);
    const res = await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cloudflare storage has not been initialized for this gym, therefore images cannot be uploaded.');
    expect(res.body.stage).toBe('resolve_path');
    expect(sentCommands('put')).toHaveLength(0);

    const { rows } = await db.query<{ logo_object_key: string | null }>('SELECT logo_object_key FROM themes WHERE id = ?', [themeId]);
    expect(rows[0].logo_object_key).toBeNull();
  });

  it('returns 503 with the missing keys when the deployment has no R2 configured', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    const res = await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(503);
    expect(res.body.missingConfig).toEqual([...R2_ENV_KEYS]);
    expect(res.body.stage).toBe('resolve_path');
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('returns 502 and leaves the row untouched when the R2 upload fails', async () => {
    // The folder markers succeed; only the object PUT is rejected, so the
    // failure is reported at the upload stage rather than the folder one.
    sendMock.mockImplementation((command: any) => (command.input.Key.endsWith('/')
      ? Promise.resolve({})
      : Promise.reject(Object.assign(new Error('NoSuchBucket'), { name: 'NoSuchBucket' }))));
    const res = await uploadLogo(themeId, gymId, 'image/png', PNG_BYTES);
    expect(res.status).toBe(502);
    expect(res.body.details.operation).toBe('uploadStorageObject');
    // #824: the diagnostic the admin is shown is built from these two.
    expect(res.body.stage).toBe('upload_logo');
    expect(res.body.path).toBe(logoKey(folderPrefix, themeId, THEME_NAME, 'png'));
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
    expect(sentCommands('delete').map((c: any) => c.input.Key))
      .toEqual([logoKey(folderPrefix, themeId, THEME_NAME, 'png')]);

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
    expect(res.body.stage).toBe('remove_logo');
    expect(res.body.path).toBe(logoKey(folderPrefix, themeId, THEME_NAME, 'png'));

    const { rows } = await db.query<{ logo_object_key: string | null }>('SELECT logo_object_key FROM themes WHERE id = ?', [themeId]);
    expect(rows[0].logo_object_key).toBe(logoKey(folderPrefix, themeId, THEME_NAME, 'png'));
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
      Key: logoKey(folderPrefix, themeId, THEME_NAME, 'png'),
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
