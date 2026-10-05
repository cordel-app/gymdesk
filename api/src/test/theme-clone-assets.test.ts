// #1041: cloning a Theme copies every asset it owns — its logo and each
// configured Members App background — into the clone's own Cloudflare folder,
// stores the *new* keys on the clone, and leaves the source untouched. A copy
// failure fails the whole clone, so no theme row is created at all.
//
// Separate from gym-themes.test.ts for theme-logo-storage.test.ts' reason: this
// file mocks @aws-sdk/client-s3 and moves the CLOUDFLARE_R2_* env around.

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

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const SOURCE_NAME = 'Theme Clone Assets Source';
const CLONE_NAME = 'Theme Clone Assets Clone';

let gymId: string;
let folderPrefix: string;
let sourceThemeId: string;

function sentCommands(type: 'put' | 'get' | 'delete' | 'copy') {
  return sendMock.mock.calls.map(([command]) => command).filter((c: any) => c?.__type === type);
}

/** Keys of the PUTs that are real objects rather than zero-byte folder markers. */
function putObjectKeys(): string[] {
  return sentCommands('put').map((c: any) => c.input.Key).filter((k: string) => !k.endsWith('/'));
}

function themeFolder(prefix: string, id: string, name: string): string {
  return `${prefix}/themes/${id}-${name.replace(/\s+/g, '')}`;
}

async function createCustomTheme(ownerGymId: string, name: string): Promise<string> {
  await db.query(
    `INSERT INTO themes (id, gym_id, name, status, tokens, created_at)
     VALUES (UUID(), ?, ?, 'active', '{"colors":{"brand":"#111"}}', UTC_TIMESTAMP())`,
    [ownerGymId, name],
  );
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM themes WHERE gym_id = ? AND name = ? LIMIT 1',
    [ownerGymId, name],
  );
  return rows[0].id;
}

function clone(sourceId: string, callerGymId: string, name: string) {
  return request
    .post(`/system/themes/clone/${sourceId}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', callerGymId)
    .send({ name });
}

/** Configures the source theme's logo and one background, as an upload would. */
async function configureSourceAssets(slots: string[] = ['training', 'nutrition']) {
  const folder = themeFolder(folderPrefix, sourceThemeId, SOURCE_NAME);
  await db.query(
    `UPDATE themes SET logo_object_key = ?, logo_mime = 'image/png', logo_updated_at = UTC_TIMESTAMP(), logo_bytes = NULL
     WHERE id = ?`,
    [`${folder}/logo/logo.png`, sourceThemeId],
  );
  for (const slot of slots) {
    await db.query(
      `INSERT INTO theme_member_images (gym_id, theme_id, slot, object_key, created_at, modified_at)
       VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [gymId, sourceThemeId, slot, `${folder}/members_app/${slot}.png`],
    );
  }
}

async function dropClones() {
  await db.query(
    'DELETE FROM theme_member_images WHERE theme_id IN (SELECT id FROM themes WHERE gym_id = ? AND name LIKE ?)',
    [gymId, 'Theme Clone Assets Clone%'],
  );
  await db.query('DELETE FROM themes WHERE gym_id = ? AND name LIKE ?', [gymId, 'Theme Clone Assets Clone%']);
}

beforeAll(async () => {
  gymId = await createTestGym('ThemeCloneAssetsGym');
  await createTestMembership(gymId, 'admin');
  folderPrefix = `gyms/${gymId}-ThemeCloneAssetsGym`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [folderPrefix, gymId]);
  sourceThemeId = await createCustomTheme(gymId, SOURCE_NAME);
});

afterAll(async () => {
  await db.query('DELETE FROM theme_member_images WHERE gym_id = ?', [gymId]);
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
  await dropClones();
  await db.query('DELETE FROM theme_member_images WHERE theme_id = ?', [sourceThemeId]);
  await db.query(
    'UPDATE themes SET logo_object_key = NULL, logo_mime = NULL, logo_updated_at = NULL, logo_bytes = NULL WHERE id = ?',
    [sourceThemeId],
  );
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [folderPrefix, gymId]);
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

describe('POST /system/themes/clone/:sourceId — asset copying (#1041)', () => {
  it('copies the logo and every configured background into the clone’s own folder', async () => {
    await configureSourceAssets();

    const res = await clone(sourceThemeId, gymId, CLONE_NAME);
    expect(res.status).toBe(201);

    const cloneFolder = themeFolder(folderPrefix, res.body.id, CLONE_NAME);
    const copies = sentCommands('copy');
    expect(copies.map((c: any) => c.input.Key)).toEqual([
      `${cloneFolder}/logo/logo.png`,
      `${cloneFolder}/members_app/training.png`,
      `${cloneFolder}/members_app/nutrition.png`,
    ]);
    // The copy is server-side: `CopySource` is `<bucket>/<source key>`, so
    // nothing is downloaded and re-uploaded.
    const sourceFolder = themeFolder(folderPrefix, sourceThemeId, SOURCE_NAME);
    expect(copies[0].input.CopySource).toBe(`${R2_BUCKET}/${sourceFolder}/logo/logo.png`);
    expect(putObjectKeys()).toEqual([]);
  });

  it('stores the clone’s own keys and never the source’s (§7/§9/§11)', async () => {
    await configureSourceAssets(['background']);

    const res = await clone(sourceThemeId, gymId, CLONE_NAME);
    expect(res.status).toBe(201);
    const cloneFolder = themeFolder(folderPrefix, res.body.id, CLONE_NAME);

    const { rows } = await db.query<{ logo_object_key: string; logo_mime: string }>(
      'SELECT logo_object_key, logo_mime FROM themes WHERE id = ?',
      [res.body.id],
    );
    expect(rows[0].logo_object_key).toBe(`${cloneFolder}/logo/logo.png`);
    expect(rows[0].logo_mime).toBe('image/png');

    const { rows: images } = await db.query<{ slot: string; object_key: string }>(
      'SELECT slot, object_key FROM theme_member_images WHERE theme_id = ?',
      [res.body.id],
    );
    expect(images).toEqual([{ slot: 'background', object_key: `${cloneFolder}/members_app/background.png` }]);

    // The response carries the clone's URLs, built from its own keys.
    expect(res.body.logo_url).toContain(`${cloneFolder}/logo/logo.png`);
    expect(res.body.members_images.background_url).toContain(`${cloneFolder}/members_app/background.png`);
    const sourceFolder = themeFolder(folderPrefix, sourceThemeId, SOURCE_NAME);
    for (const url of [res.body.logo_url, ...Object.values(res.body.members_images)]) {
      if (url) expect(String(url)).not.toContain(sourceFolder);
    }
  });

  it('leaves the source theme exactly as it was (§13)', async () => {
    await configureSourceAssets(['membership']);
    const before = await db.query('SELECT logo_object_key, logo_mime FROM themes WHERE id = ?', [sourceThemeId]);

    expect((await clone(sourceThemeId, gymId, CLONE_NAME)).status).toBe(201);

    const after = await db.query('SELECT logo_object_key, logo_mime FROM themes WHERE id = ?', [sourceThemeId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const { rows: images } = await db.query<{ slot: string }>(
      'SELECT slot FROM theme_member_images WHERE theme_id = ?',
      [sourceThemeId],
    );
    expect(images.map((r) => r.slot)).toEqual(['membership']);
    // Nothing of the source was deleted or overwritten.
    expect(sentCommands('delete')).toHaveLength(0);
  });

  it('copies nothing — and writes no slot rows — for a source that configured nothing (§4)', async () => {
    const res = await clone(sourceThemeId, gymId, CLONE_NAME);
    expect(res.status).toBe(201);
    expect(sentCommands('copy')).toHaveLength(0);
    expect(res.body.logo_url).toBeNull();
    expect(res.body.members_images.training_url).toBeNull();
    const { rows } = await db.query('SELECT slot FROM theme_member_images WHERE theme_id = ?', [res.body.id]);
    expect(rows).toHaveLength(0);
  });

  it('initializes the clone’s folders before copying into them (§3)', async () => {
    await configureSourceAssets(['calendar']);
    const res = await clone(sourceThemeId, gymId, CLONE_NAME);
    expect(res.status).toBe(201);
    const cloneFolder = themeFolder(folderPrefix, res.body.id, CLONE_NAME);
    expect(sentCommands('put').map((c: any) => c.input.Key)).toEqual([
      `${cloneFolder}/`,
      `${cloneFolder}/logo/`,
      `${cloneFolder}/members_app/`,
    ]);
    // …and the gym-level roots are *not* re-created here: they belong to Gym
    // Bucket Initialization (#735).
    expect(sentCommands('put').map((c: any) => c.input.Key)).not.toContain(`${folderPrefix}/themes/`);
  });

  it('uploads a legacy `logo_bytes` logo into the clone’s own key', async () => {
    await db.query(
      "UPDATE themes SET logo_bytes = ?, logo_mime = 'image/png', logo_object_key = NULL WHERE id = ?",
      [PNG_BYTES, sourceThemeId],
    );

    const res = await clone(sourceThemeId, gymId, CLONE_NAME);
    expect(res.status).toBe(201);
    const cloneFolder = themeFolder(folderPrefix, res.body.id, CLONE_NAME);
    expect(sentCommands('copy')).toHaveLength(0);
    expect(putObjectKeys()).toEqual([`${cloneFolder}/logo/logo.png`]);

    // The clone's logo is an R2 object; `logo_bytes` gains no writer (#829).
    const { rows } = await db.query<{ logo_object_key: string; logo_bytes: Buffer | null }>(
      'SELECT logo_object_key, logo_bytes FROM themes WHERE id = ?',
      [res.body.id],
    );
    expect(rows[0].logo_object_key).toBe(`${cloneFolder}/logo/logo.png`);
    expect(rows[0].logo_bytes).toBeNull();
  });

  it('fails the whole clone when one copy fails, and creates no theme (§15/§16)', async () => {
    await configureSourceAssets(['training', 'nutrition']);
    // Folder markers succeed, the logo copy succeeds, the first background
    // copy fails — the partial state the ticket rules out.
    let copies = 0;
    sendMock.mockImplementation(async (command: any) => {
      if (command?.__type === 'copy') {
        copies += 1;
        if (copies === 2) throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
      }
      return {};
    });

    const res = await clone(sourceThemeId, gymId, CLONE_NAME);
    expect(res.status).toBe(502);
    expect(res.body.stage).toBe('copy_members_image');
    expect(res.body.path).toContain('/members_app/training.png');

    const { rows } = await db.query('SELECT id FROM themes WHERE gym_id = ? AND name = ?', [gymId, CLONE_NAME]);
    expect(rows).toHaveLength(0);

    // The copies it had already made are swept, so the gym's folder carries no
    // assets of a theme that does not exist.
    const deleted = sentCommands('delete').map((c: any) => c.input.Key);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain('/logo/logo.png');
    expect(deleted[0]).not.toContain(themeFolder(folderPrefix, sourceThemeId, SOURCE_NAME));
  });

  it('names the logo stage when the logo copy is what failed', async () => {
    await configureSourceAssets(['training']);
    sendMock.mockImplementation(async (command: any) => {
      if (command?.__type === 'copy') throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return {};
    });

    const res = await clone(sourceThemeId, gymId, CLONE_NAME);
    expect(res.status).toBe(502);
    expect(res.body.stage).toBe('copy_logo');
    expect(res.body.details.operation).toBe('copyStorageObject');
    expect(sentCommands('delete')).toHaveLength(0);
  });

  it('copies nothing and creates nothing when the gym’s bucket is not initialized (§1)', async () => {
    await configureSourceAssets();
    await db.query('UPDATE gyms SET storage_folder_prefix = NULL WHERE id = ?', [gymId]);

    const res = await clone(sourceThemeId, gymId, CLONE_NAME);
    expect(res.status).toBe(409);
    expect(res.body.stage).toBe('resolve_path');
    expect(sentCommands('copy')).toHaveLength(0);
    expect(sentCommands('put')).toHaveLength(0);
    const { rows } = await db.query('SELECT id FROM themes WHERE gym_id = ? AND name = ?', [gymId, CLONE_NAME]);
    expect(rows).toHaveLength(0);
  });

  it('copies a Base Theme’s platform assets into the gym’s folder, writing nothing under cordel/ (§14)', async () => {
    await db.query(
      `INSERT INTO themes (id, gym_id, name, status, tokens, created_at, logo_object_key, logo_mime)
       VALUES (UUID(), NULL, ?, 'active', '{}', UTC_TIMESTAMP(), 'cordel/themes/base-ThemeCloneBase/logo/logo.png', 'image/png')`,
      ['Theme Clone Assets Base'],
    );
    const { rows: base } = await db.query<{ id: string }>(
      'SELECT id FROM themes WHERE gym_id IS NULL AND name = ? LIMIT 1',
      ['Theme Clone Assets Base'],
    );
    const baseId = base[0].id;
    await db.query(
      `INSERT INTO theme_member_images (gym_id, theme_id, slot, object_key, created_at, modified_at)
       VALUES (NULL, ?, 'bookings', 'cordel/themes/base-ThemeCloneBase/members_app/bookings.png', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [baseId],
    );

    const res = await clone(baseId, gymId, CLONE_NAME);
    expect(res.status).toBe(201);
    const cloneFolder = themeFolder(folderPrefix, res.body.id, CLONE_NAME);
    const copies = sentCommands('copy');
    expect(copies.map((c: any) => c.input.CopySource)).toEqual([
      `${R2_BUCKET}/cordel/themes/base-ThemeCloneBase/logo/logo.png`,
      `${R2_BUCKET}/cordel/themes/base-ThemeCloneBase/members_app/bookings.png`,
    ]);
    for (const command of [...copies, ...sentCommands('put')]) {
      expect(String((command as any).input.Key).startsWith('gyms/')).toBe(true);
    }
    // The clone's slot row is the gym's own, pointing at the gym's object.
    const { rows: images } = await db.query<{ gym_id: string | null; object_key: string }>(
      'SELECT gym_id, object_key FROM theme_member_images WHERE theme_id = ?',
      [res.body.id],
    );
    expect(images).toEqual([{ gym_id: gymId, object_key: `${cloneFolder}/members_app/bookings.png` }]);

    await db.query('DELETE FROM theme_member_images WHERE theme_id = ?', [baseId]);
    await db.query('DELETE FROM themes WHERE id = ?', [baseId]);
  });

  it('is still refused for a duplicate name, before anything is copied', async () => {
    await configureSourceAssets();
    expect((await clone(sourceThemeId, gymId, CLONE_NAME)).status).toBe(201);
    sendMock.mockClear();

    const res = await clone(sourceThemeId, gymId, CLONE_NAME);
    expect(res.status).toBe(409);
    expect(res.body.stage).toBeUndefined();
    expect(sentCommands('copy')).toHaveLength(0);
  });
});
