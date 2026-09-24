// #725: the six Members App background images of a Custom Theme, stored in the
// gym's own Cloudflare R2 folder under
// `<storage_folder_prefix>/Themes/<theme_id>-<name>/Members/<slot>.png`.
// Covers the upload and remove routes (`/system/themes/:id/members-images/:slot`),
// the theme payload they surface on, and the Members App's own read (`/me/gym`).
//
// Separate from gym-themes.test.ts for the same reason theme-logo-storage.test.ts
// is: this file mocks @aws-sdk/client-s3 and moves the CLOUDFLARE_R2_* env around.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const THEME_NAME = 'Members Images Custom';
const OTHER_THEME_NAME = 'Members Images Other Custom';

let gymId: string;
let otherGymId: string;
let folderPrefix: string;
let otherFolderPrefix: string;
let themeId: string;
let otherThemeId: string;

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

function upload(id: string, callerGymId: string, slot: string, mime: string, body: Buffer) {
  return request
    .post(`/system/themes/${id}/members-images/${slot}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', callerGymId)
    .set('Content-Type', mime)
    .send(body);
}

function remove(id: string, callerGymId: string, slot: string) {
  return request
    .delete(`/system/themes/${id}/members-images/${slot}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', callerGymId);
}

function keyFor(prefix: string, theme: string, name: string, slot: string) {
  return `${prefix}/Themes/${theme}-${name.replace(/\s+/g, '')}/Members/${slot}.png`;
}

beforeAll(async () => {
  gymId = await createTestGym('MembersImagesGym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('MembersImagesOtherGym');
  await createTestMembership(otherGymId, 'admin');

  folderPrefix = `gyms/${gymId}-MembersImagesGym`;
  otherFolderPrefix = `gyms/${otherGymId}-MembersImagesOtherGym`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [folderPrefix, gymId]);
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [otherFolderPrefix, otherGymId]);

  themeId = await createCustomTheme(gymId, THEME_NAME);
  otherThemeId = await createCustomTheme(otherGymId, OTHER_THEME_NAME);
});

afterAll(async () => {
  await db.query('DELETE FROM theme_member_images WHERE gym_id IN (SELECT id FROM gyms WHERE slug LIKE ?)', ['test-%']);
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
  await db.query('DELETE FROM theme_member_images WHERE theme_id IN (?, ?)', [themeId, otherThemeId]);
  await db.query('UPDATE themes SET name = ? WHERE id = ?', [THEME_NAME, themeId]);
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [folderPrefix, gymId]);
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── Upload ───────────────────────────────────────────────────────────────────

describe('POST /system/themes/:id/members-images/:slot', () => {
  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/system/themes/${themeId}/members-images/training`)
      .set('x-gym-id', gymId)
      .set('Content-Type', 'image/png')
      .send(PNG_BYTES);
    expect(res.status).toBe(401);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('returns 403 for a non-admin role', async () => {
    const frontDeskGymId = await createTestGym('MembersImagesFrontDeskGym');
    await createTestMembership(frontDeskGymId, 'front_desk');
    await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${frontDeskGymId}-FrontDesk`, frontDeskGymId]);
    const frontDeskThemeId = await createCustomTheme(frontDeskGymId, 'Members Images Front Desk Theme');

    const res = await upload(frontDeskThemeId, frontDeskGymId, 'training', 'image/png', PNG_BYTES);
    expect(res.status).toBe(403);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('stores the file at the slot\'s deterministic key and records the reference', async () => {
    const res = await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);

    const key = keyFor(folderPrefix, themeId, THEME_NAME, 'training');
    const puts = sentCommands('put');
    // The folder markers, then the image itself.
    expect(puts[puts.length - 1].input).toMatchObject({ Bucket: R2_BUCKET, Key: key, ContentType: 'image/png' });

    const { rows } = await db.query<{ slot: string; object_key: string; gym_id: string }>(
      'SELECT slot, object_key, gym_id FROM theme_member_images WHERE theme_id = ?',
      [themeId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slot: 'training', object_key: key, gym_id: gymId });

    expect(res.body.members_images.training_url).toContain(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
    expect(res.body.members_images.nutrition_url).toBeNull();
  });

  it('creates the whole missing folder hierarchy before the upload, and only markers', async () => {
    await upload(themeId, gymId, 'calendar', 'image/png', PNG_BYTES);
    const keys = sentCommands('put').map((c: any) => c.input.Key);
    const themeFolder = `${folderPrefix}/Themes/${themeId}-${THEME_NAME.replace(/\s+/g, '')}`;
    expect(keys.slice(0, 4)).toEqual([
      `${folderPrefix}/`,
      `${folderPrefix}/Themes/`,
      `${themeFolder}/`,
      `${themeFolder}/Members/`,
    ]);
    // Everything before the image is a folder marker; nothing else is written.
    expect(keys.slice(0, 4).every((k: string) => k.endsWith('/'))).toBe(true);
    expect(keys).toHaveLength(5);
  });

  it('re-creates the hierarchy idempotently on a second upload', async () => {
    await upload(themeId, gymId, 'calendar', 'image/png', PNG_BYTES);
    sendMock.mockClear();
    const res = await upload(themeId, gymId, 'bookings', 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);
    // Same markers again, same empty bodies — reusing a folder, never replacing one.
    const markers = sentCommands('put').filter((c: any) => c.input.Key.endsWith('/'));
    expect(markers).toHaveLength(4);
    expect(markers.every((c: any) => c.input.Body === '')).toBe(true);
  });

  it('ignores the uploaded file\'s name and type when naming the object', async () => {
    const res = await request
      .post(`/system/themes/${themeId}/members-images/training`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('Content-Type', 'image/jpeg')
      .set('Content-Disposition', 'attachment; filename="../../awesome-training-image.webp"')
      .send(JPEG_BYTES);
    expect(res.status).toBe(200);
    const puts = sentCommands('put');
    // Always `training.png`, and the object carries the real type.
    expect(puts[puts.length - 1].input).toMatchObject({
      Key: keyFor(folderPrefix, themeId, THEME_NAME, 'training'),
      ContentType: 'image/jpeg',
    });
  });

  it('keeps each of the six slots on its own fixed filename', async () => {
    for (const slot of ['training', 'nutrition', 'calendar', 'bookings', 'background', 'membership']) {
      sendMock.mockClear();
      const res = await upload(themeId, gymId, slot, 'image/png', PNG_BYTES);
      expect(res.status).toBe(200);
      const puts = sentCommands('put');
      expect(puts[puts.length - 1].input.Key).toBe(keyFor(folderPrefix, themeId, THEME_NAME, slot));
      expect(res.body.members_images[`${slot}_url`]).toContain(`/Members/${slot}.png`);
    }
    const { rows } = await db.query('SELECT slot FROM theme_member_images WHERE theme_id = ?', [themeId]);
    expect(rows).toHaveLength(6);
  });

  it('rejects an unknown slot', async () => {
    const res = await upload(themeId, gymId, 'logo', 'image/png', PNG_BYTES);
    expect(res.status).toBe(400);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('rejects a type outside the allow-list', async () => {
    const res = await upload(themeId, gymId, 'training', 'image/svg+xml', Buffer.from('<svg/>'));
    expect(res.status).toBe(415);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('rejects bytes that are not the declared image type', async () => {
    const res = await upload(themeId, gymId, 'training', 'image/png', NOT_AN_IMAGE);
    expect(res.status).toBe(400);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('rejects an oversized image', async () => {
    const tooBig = Buffer.concat([PNG_BYTES, Buffer.alloc(4 * 1024 * 1024)]);
    const res = await upload(themeId, gymId, 'training', 'image/png', tooBig);
    expect(res.status).toBe(413);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('leaves the existing image in place when an invalid upload is refused', async () => {
    expect((await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);
    const key = keyFor(folderPrefix, themeId, THEME_NAME, 'training');

    expect((await upload(themeId, gymId, 'training', 'image/png', NOT_AN_IMAGE)).status).toBe(400);
    const { rows } = await db.query<{ object_key: string }>(
      'SELECT object_key FROM theme_member_images WHERE theme_id = ? AND slot = ?',
      [themeId, 'training'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].object_key).toBe(key);
  });

  it('keeps the existing image and its reference when the R2 upload fails', async () => {
    expect((await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);
    const key = keyFor(folderPrefix, themeId, THEME_NAME, 'training');
    sendMock.mockReset();
    sendMock.mockRejectedValue(new Error('R2 down'));

    const res = await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES);
    expect(res.status).toBe(502);
    const { rows } = await db.query<{ object_key: string }>(
      'SELECT object_key FROM theme_member_images WHERE theme_id = ? AND slot = ?',
      [themeId, 'training'],
    );
    expect(rows[0].object_key).toBe(key);
  });

  it('replaces in place — same key, one row, no second object', async () => {
    expect((await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);
    sendMock.mockClear();

    const res = await upload(themeId, gymId, 'training', 'image/jpeg', JPEG_BYTES);
    expect(res.status).toBe(200);
    const key = keyFor(folderPrefix, themeId, THEME_NAME, 'training');
    const puts = sentCommands('put');
    expect(puts[puts.length - 1].input.Key).toBe(key);
    expect(sentCommands('delete')).toHaveLength(0);

    const { rows } = await db.query('SELECT id FROM theme_member_images WHERE theme_id = ? AND slot = ?', [themeId, 'training']);
    expect(rows).toHaveLength(1);
  });

  it('moves the `?v=` stamp on a replacement, so a cached image is not served', async () => {
    const first = await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES);
    // MySQL DATETIME has second resolution; wait so the two stamps can differ.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES);
    expect(second.body.members_images.training_url).not.toBe(first.body.members_images.training_url);
  });

  it('sweeps the object a rename left behind, and still saves when that fails', async () => {
    expect((await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);
    const staleKey = keyFor(folderPrefix, themeId, THEME_NAME, 'training');

    await db.query('UPDATE themes SET name = ? WHERE id = ?', ['Members Images Renamed', themeId]);
    sendMock.mockReset();
    sendMock.mockImplementation((command: any) =>
      command.__type === 'delete' ? Promise.reject(new Error('R2 down')) : Promise.resolve({}));

    const res = await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES);
    expect(res.status).toBe(200);
    expect(sentCommands('delete').map((c: any) => c.input.Key)).toEqual([staleKey]);
    const { rows } = await db.query<{ object_key: string }>(
      'SELECT object_key FROM theme_member_images WHERE theme_id = ? AND slot = ?',
      [themeId, 'training'],
    );
    expect(rows[0].object_key).toBe(keyFor(folderPrefix, themeId, 'Members Images Renamed', 'training'));
  });

  it('503s when the deployment has no R2 configured, without writing a row', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    const res = await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES);
    expect(res.status).toBe(503);
    const { rows } = await db.query('SELECT id FROM theme_member_images WHERE theme_id = ?', [themeId]);
    expect(rows).toHaveLength(0);
  });

  it('409s when this gym\'s storage folder was never initialized', async () => {
    await db.query('UPDATE gyms SET storage_folder_prefix = NULL WHERE id = ?', [gymId]);
    const res = await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES);
    expect(res.status).toBe(409);
    expect(sentCommands('put')).toHaveLength(0);
  });
});

// ─── Tenant and theme isolation ──────────────────────────────────────────────

describe('Members image isolation (#725 §Tenant Isolation, §Customer Theme Ownership)', () => {
  it('404s when a gym aims an upload at another gym\'s theme', async () => {
    const res = await upload(otherThemeId, gymId, 'training', 'image/png', PNG_BYTES);
    expect(res.status).toBe(404);
    expect(sentCommands('put')).toHaveLength(0);
    const { rows } = await db.query('SELECT id FROM theme_member_images WHERE theme_id = ?', [otherThemeId]);
    expect(rows).toHaveLength(0);
  });

  it('404s when a gym tries to clear another gym\'s slot', async () => {
    expect((await upload(otherThemeId, otherGymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);
    const res = await remove(otherThemeId, gymId, 'training');
    expect(res.status).toBe(404);
    const { rows } = await db.query('SELECT id FROM theme_member_images WHERE theme_id = ?', [otherThemeId]);
    expect(rows).toHaveLength(1);
  });

  it('404s for a Base Theme — the platform has no gym folder to store one in', async () => {
    const { rows: base } = await db.query<{ id: string }>(
      'SELECT id FROM themes WHERE gym_id IS NULL AND deleted_at IS NULL LIMIT 1',
    );
    const res = await upload(base[0].id, gymId, 'training', 'image/png', PNG_BYTES);
    expect(res.status).toBe(404);
    expect(sentCommands('put')).toHaveLength(0);
  });

  it('never writes outside the caller\'s own gym folder', async () => {
    expect((await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);
    for (const command of sentCommands('put')) {
      expect(command.input.Key.startsWith(`${folderPrefix}/`)).toBe(true);
      expect(command.input.Key).not.toContain(otherFolderPrefix);
    }
  });

  it('keeps two themes of one gym on separate objects', async () => {
    const siblingId = await createCustomTheme(gymId, 'Members Images Sibling');
    expect((await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);
    expect((await upload(siblingId, gymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);

    const { rows } = await db.query<{ theme_id: string; object_key: string }>(
      'SELECT theme_id, object_key FROM theme_member_images WHERE gym_id = ? AND slot = ?',
      [gymId, 'training'],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.object_key)).size).toBe(2);

    // Clearing one leaves the other exactly as it was.
    expect((await remove(siblingId, gymId, 'training')).status).toBe(200);
    const { rows: after } = await db.query(
      'SELECT id FROM theme_member_images WHERE theme_id = ? AND slot = ?',
      [themeId, 'training'],
    );
    expect(after).toHaveLength(1);

    await db.query('DELETE FROM theme_member_images WHERE theme_id = ?', [siblingId]);
    await db.query('DELETE FROM themes WHERE id = ?', [siblingId]);
  });
});

// ─── Remove ───────────────────────────────────────────────────────────────────

describe('DELETE /system/themes/:id/members-images/:slot', () => {
  it('clears the reference and leaves the R2 object alone', async () => {
    expect((await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);
    sendMock.mockClear();

    const res = await remove(themeId, gymId, 'training');
    expect(res.status).toBe(200);
    expect(res.body.members_images.training_url).toBeNull();
    // #725 is explicit: Remove does not delete the object.
    expect(sentCommands('delete')).toHaveLength(0);

    const { rows } = await db.query('SELECT id FROM theme_member_images WHERE theme_id = ? AND slot = ?', [themeId, 'training']);
    expect(rows).toHaveLength(0);
  });

  it('leaves every other slot configured', async () => {
    expect((await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);
    expect((await upload(themeId, gymId, 'nutrition', 'image/png', PNG_BYTES)).status).toBe(200);

    const res = await remove(themeId, gymId, 'training');
    expect(res.body.members_images.training_url).toBeNull();
    expect(res.body.members_images.nutrition_url).not.toBeNull();
  });

  it('re-uploading a cleared slot reuses the same object path', async () => {
    const first = await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES);
    const key = keyFor(folderPrefix, themeId, THEME_NAME, 'training');
    expect((await remove(themeId, gymId, 'training')).status).toBe(200);
    sendMock.mockClear();

    const again = await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES);
    expect(again.status).toBe(200);
    const puts = sentCommands('put');
    expect(puts[puts.length - 1].input.Key).toBe(key);
    expect(again.body.members_images.training_url).toContain(key);
    expect(first.body.members_images.training_url).toContain(key);

    const { rows } = await db.query('SELECT id FROM theme_member_images WHERE theme_id = ? AND slot = ?', [themeId, 'training']);
    expect(rows).toHaveLength(1);
  });

  it('is a no-op for a slot that was never configured', async () => {
    const res = await remove(themeId, gymId, 'membership');
    expect(res.status).toBe(200);
    expect(res.body.members_images.membership_url).toBeNull();
  });

  it('rejects an unknown slot', async () => {
    expect((await remove(themeId, gymId, 'logo')).status).toBe(400);
  });
});

// ─── The theme payload ───────────────────────────────────────────────────────

describe('Members images on the theme payload (#725 §Performance, §API)', () => {
  it('rides on the list, all six fields, without a request per image', async () => {
    expect((await upload(themeId, gymId, 'background', 'image/png', PNG_BYTES)).status).toBe(200);

    const res = await request.get('/system/themes').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const theme = res.body.find((t: any) => t.id === themeId);
    expect(Object.keys(theme.members_images).sort()).toEqual(
      ['background_url', 'bookings_url', 'calendar_url', 'membership_url', 'nutrition_url', 'training_url'],
    );
    expect(theme.members_images.background_url).toContain('/Members/background.png');
    expect(theme.members_images.training_url).toBeNull();
  });

  it('reports a Base Theme as six nulls', async () => {
    const res = await request.get('/system/themes').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const base = res.body.find((t: any) => t.is_base);
    expect(base.members_images).toEqual({
      training_url: null,
      nutrition_url: null,
      calendar_url: null,
      bookings_url: null,
      background_url: null,
      membership_url: null,
    });
  });

  it('never shows one gym another gym\'s configuration', async () => {
    expect((await upload(otherThemeId, otherGymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);
    const res = await request.get('/system/themes').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.body.find((t: any) => t.id === otherThemeId)).toBeUndefined();
    for (const theme of res.body) {
      for (const url of Object.values(theme.members_images)) {
        expect(String(url)).not.toContain(otherFolderPrefix);
      }
    }
  });

  it('survives a theme update — editing colours does not clear the configuration', async () => {
    expect((await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);
    const res = await request
      .put(`/system/themes/${themeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: THEME_NAME, tokens: { v: 2 } });
    expect(res.status).toBe(200);
    expect(res.body.members_images.training_url).toContain('/Members/training.png');
  });

  it('gives a clone its own, independent (and empty) configuration', async () => {
    expect((await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);

    const clone = await request
      .post(`/system/themes/clone/${themeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Members Images Clone' });
    expect(clone.status).toBe(201);
    // Cloning has never copied a theme's R2 assets (it does not copy the logo
    // either), so the clone starts unconfigured — and therefore shares no
    // object path with its source.
    expect(clone.body.members_images.training_url).toBeNull();

    expect((await upload(clone.body.id, gymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);
    const { rows } = await db.query<{ theme_id: string; object_key: string }>(
      'SELECT theme_id, object_key FROM theme_member_images WHERE gym_id = ? AND slot = ?',
      [gymId, 'training'],
    );
    expect(new Set(rows.map((r) => r.object_key)).size).toBe(2);

    // Clearing the clone leaves the source alone.
    expect((await remove(clone.body.id, gymId, 'training')).status).toBe(200);
    const { rows: source } = await db.query(
      'SELECT id FROM theme_member_images WHERE theme_id = ? AND slot = ?',
      [themeId, 'training'],
    );
    expect(source).toHaveLength(1);

    await db.query('DELETE FROM theme_member_images WHERE theme_id = ?', [clone.body.id]);
    await db.query('DELETE FROM themes WHERE id = ?', [clone.body.id]);
  });
});

// ─── What the Members App reads ──────────────────────────────────────────────

describe('GET /me/gyms (#725 §Members App Rendering)', () => {
  beforeEach(async () => {
    await db.query('UPDATE gyms SET theme_id = ? WHERE id = ?', [themeId, gymId]);
  });

  function gymFrom(body: any[], id: string) {
    return body.find((g: any) => g.id === id);
  }

  it('carries the configured URLs on the gym\'s own theme', async () => {
    expect((await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);

    const res = await request.get('/me/gyms').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    const theme = gymFrom(res.body, gymId).theme;
    expect(theme.members_images.training_url).toContain('/Members/training.png');
    expect(theme.members_images.calendar_url).toBeNull();
    // Only URLs reach the Members App — never a key, a prefix or a theme folder.
    expect(JSON.stringify(theme.members_images)).not.toContain('object_key');
    expect(JSON.stringify(theme.members_images)).not.toContain('storage_folder_prefix');
  });

  it('reports a cleared slot as null on the next read', async () => {
    expect((await upload(themeId, gymId, 'training', 'image/png', PNG_BYTES)).status).toBe(200);
    expect((await remove(themeId, gymId, 'training')).status).toBe(200);

    const res = await request.get('/me/gyms').set('Authorization', TEST_AUTH_HEADER);
    expect(gymFrom(res.body, gymId).theme.members_images.training_url).toBeNull();
  });

  it('returns 401 without auth', async () => {
    expect((await request.get('/me/gyms')).status).toBe(401);
  });
});
