// #828: "Initialize bucket" on a Theme's context menu — a manual, explicitly
// repeatable way to create the Cloudflare folder structure a Theme's own assets
// live in.
//
// Two routes, because a Theme's folder hangs off two different roots: a Custom
// Theme's off its gym's `storage_folder_prefix`
// (`POST /system/themes/:id/storage/initialize`) and a Base Theme's off
// `PLATFORM_STORAGE_ROOT` (`POST /platform/themes/:id/storage/initialize`). Each
// answers for its own rows only, so neither can be used to reach the other's
// objects by changing the Theme id.
//
// Separate from gym-themes.test.ts / themes.test.ts for the same reason
// theme-storage-init.test.ts is: this file mocks @aws-sdk/client-s3 and moves
// the CLOUDFLARE_R2_* env around. The pure key and stage rules stay in
// theme-storage-folders.unit.test.ts.

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

const originalEnv: Record<string, string | undefined> = {};
for (const key of R2_ENV_KEYS) originalEnv[key] = process.env[key];

function setStorageConfigured() {
  process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
}

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

const CUSTOM_THEME_NAME = 'Bucket Init Custom Theme';
const OTHER_GYM_THEME_NAME = 'Bucket Init Other Gym Theme';
const BASE_THEME_NAME = 'Test Bucket Init Base Theme';

let gymId: string;
let otherGymId: string;
let folderPrefix: string;
let customThemeId: string;
let otherGymThemeId: string;
let baseThemeId: string;

/** The three markers an initialization writes, outermost first. */
function expectedMarkers(prefix: string, themeId: string, themeName: string): string[] {
  const folder = `${prefix}/Themes/${themeId}-${themeName.replace(/\s+/g, '')}`;
  return [`${folder}/`, `${folder}/Logo/`, `${folder}/Members/`];
}

function sentCommands(type: 'put' | 'get' | 'delete') {
  return sendMock.mock.calls.map(([command]) => command).filter((c: any) => c?.__type === type);
}

function putKeys(): string[] {
  return sentCommands('put').map((c: any) => c.input.Key);
}

function initCustom(themeId: string, callerGymId: string) {
  return request
    .post(`/system/themes/${themeId}/storage/initialize`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', callerGymId);
}

function initBase(themeId: string) {
  return request
    .post(`/platform/themes/${themeId}/storage/initialize`)
    .set('Authorization', TEST_AUTH_HEADER);
}

async function createCustomTheme(gym: string, name: string): Promise<string> {
  await db.query(
    `INSERT INTO themes (id, gym_id, name, status, tokens, created_at)
     VALUES (UUID(), ?, ?, 'active', '{}', UTC_TIMESTAMP())`,
    [gym, name],
  );
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM themes WHERE gym_id = ? AND name = ? LIMIT 1',
    [gym, name],
  );
  return rows[0].id;
}

beforeAll(async () => {
  gymId = await createTestGym('BucketInitThemeGym');
  await createTestMembership(gymId, 'admin');
  folderPrefix = `gyms/${gymId}-BucketInitThemeGym`;

  otherGymId = await createTestGym('BucketInitOtherGym');
  await createTestMembership(otherGymId, 'admin');

  customThemeId = await createCustomTheme(gymId, CUSTOM_THEME_NAME);
  otherGymThemeId = await createCustomTheme(otherGymId, OTHER_GYM_THEME_NAME);

  await db.query(
    `INSERT INTO themes (id, gym_id, is_system_default, name, status, tokens, created_at)
     VALUES (UUID(), NULL, 0, ?, 'active', '{}', UTC_TIMESTAMP())`,
    [BASE_THEME_NAME],
  );
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM themes WHERE gym_id IS NULL AND name = ? LIMIT 1',
    [BASE_THEME_NAME],
  );
  baseThemeId = rows[0].id;
});

afterAll(async () => {
  await db.query('DELETE FROM themes WHERE gym_id IN (SELECT id FROM gyms WHERE slug LIKE ?)', ['test-%']);
  await db.query("DELETE FROM themes WHERE gym_id IS NULL AND name LIKE 'Test Bucket Init Base Theme%'");
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
  mockAsSuperadmin();
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [folderPrefix, gymId]);
  await db.query('UPDATE themes SET deleted_at = NULL WHERE id = ?', [customThemeId]);
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

describe('POST /system/themes/:id/storage/initialize — a Custom Theme (#828 §1)', () => {
  it('creates the theme folder with its Logo/ and Members/ leaves', async () => {
    const res = await initCustom(customThemeId, gymId);
    expect(res.status).toBe(200);
    expect(res.body.initialized).toBe(true);
    const markers = expectedMarkers(folderPrefix, customThemeId, CUSTOM_THEME_NAME);
    expect(res.body.folders).toEqual(markers);
    expect(putKeys()).toEqual(markers);
  });

  it('is idempotent — a second run writes the same markers and nothing else (§3)', async () => {
    const first = await initCustom(customThemeId, gymId);
    expect(first.status).toBe(200);

    sendMock.mockClear();
    const again = await initCustom(customThemeId, gymId);
    expect(again.status).toBe(200);
    expect(putKeys()).toEqual(expectedMarkers(folderPrefix, customThemeId, CUSTOM_THEME_NAME));
    // §3: folder markers only — zero-byte objects whose keys end in `/`, so
    // nothing can be deleted or overwritten. No GET and no DELETE either.
    for (const command of sentCommands('put')) {
      expect((command as any).input.Key.endsWith('/')).toBe(true);
      expect((command as any).input.Body).toBe('');
    }
    expect(sentCommands('delete')).toHaveLength(0);
    expect(sentCommands('get')).toHaveLength(0);
  });

  it('never touches the gym root or its Themes/ branch — Gym Bucket Initialization owns those (§5, #735)', async () => {
    const res = await initCustom(customThemeId, gymId);
    expect(res.status).toBe(200);
    expect(putKeys()).not.toContain(`${folderPrefix}/`);
    expect(putKeys()).not.toContain(`${folderPrefix}/Themes/`);
  });

  it('leaves the theme row untouched — no id, name, status or configuration change (§3)', async () => {
    const { rows: before } = await db.query(
      'SELECT id, name, status, tokens, modified_at FROM themes WHERE id = ?',
      [customThemeId],
    );
    const res = await initCustom(customThemeId, gymId);
    expect(res.status).toBe(200);
    const { rows: after } = await db.query(
      'SELECT id, name, status, tokens, modified_at FROM themes WHERE id = ?',
      [customThemeId],
    );
    expect(after[0]).toEqual(before[0]);
  });

  it('sanitizes the theme name in the key, exactly as the upload routes do', async () => {
    const res = await initCustom(customThemeId, gymId);
    expect(res.body.folders[0]).toBe(`${folderPrefix}/Themes/${customThemeId}-BucketInitCustomTheme/`);
  });

  it('404s another gym\'s theme and writes nothing', async () => {
    const res = await initCustom(otherGymThemeId, gymId);
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });

  it('404s a Base Theme — its objects are the platform\'s, not a gym\'s', async () => {
    const res = await initCustom(baseThemeId, gymId);
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });

  it('404s a soft-deleted theme', async () => {
    await db.query('UPDATE themes SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [customThemeId]);
    const res = await initCustom(customThemeId, gymId);
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });

  it('401s without authentication', async () => {
    const res = await request.post(`/system/themes/${customThemeId}/storage/initialize`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('409s when the gym bucket was never initialized — §5 keeps that a separate action', async () => {
    await db.query('UPDATE gyms SET storage_folder_prefix = NULL WHERE id = ?', [gymId]);
    const res = await initCustom(customThemeId, gymId);
    expect(res.status).toBe(409);
    expect(res.body.stage).toBe('resolve_path');
    expect(res.body.error).toContain('not been initialized');
    expect(putKeys()).toHaveLength(0);
  });

  it('503s naming the missing config when the deployment has no R2', async () => {
    delete process.env.CLOUDFLARE_R2_BUCKET;
    const res = await initCustom(customThemeId, gymId);
    expect(res.status).toBe(503);
    expect(res.body.stage).toBe('resolve_path');
    expect(res.body.missingConfig).toEqual(expect.arrayContaining(['CLOUDFLARE_R2_BUCKET']));
    expect(putKeys()).toHaveLength(0);
  });

  it('502s naming the marker that failed (§4)', async () => {
    sendMock.mockRejectedValue(Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' }));
    const res = await initCustom(customThemeId, gymId);
    expect(res.status).toBe(502);
    expect(res.body.stage).toBe('create_theme_folder');
    expect(res.body.path).toBe(`${folderPrefix}/Themes/${customThemeId}-BucketInitCustomTheme/`);
    expect(res.body.details.operation).toBe('ensureStorageFolders');
  });

  it('names the Members leaf when that is the marker that failed', async () => {
    let call = 0;
    sendMock.mockImplementation(async () => {
      call += 1;
      if (call === 3) throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' });
      return {};
    });
    const res = await initCustom(customThemeId, gymId);
    expect(res.status).toBe(502);
    expect(res.body.stage).toBe('create_members_folder');
    expect(res.body.path.endsWith('/Members/')).toBe(true);
  });
});

describe('POST /platform/themes/:id/storage/initialize — a Base Theme (#828 §2)', () => {
  it('creates the theme folder with its Logo/ and Members/ leaves under the platform root', async () => {
    const res = await initBase(baseThemeId);
    expect(res.status).toBe(200);
    const markers = expectedMarkers('cordel', baseThemeId, BASE_THEME_NAME);
    expect(res.body.folders).toEqual(markers);
    expect(putKeys()).toEqual(markers);
    // Never a gym's folder, whichever gym the superadmin has selected.
    for (const key of putKeys()) expect(key.startsWith('cordel/Themes/')).toBe(true);
  });

  it('is idempotent — a second run rewrites the same zero-byte markers (§3)', async () => {
    expect((await initBase(baseThemeId)).status).toBe(200);
    sendMock.mockClear();
    const again = await initBase(baseThemeId);
    expect(again.status).toBe(200);
    expect(putKeys()).toEqual(expectedMarkers('cordel', baseThemeId, BASE_THEME_NAME));
    for (const command of sentCommands('put')) {
      expect((command as any).input.Key.endsWith('/')).toBe(true);
      expect((command as any).input.Body).toBe('');
    }
    expect(sentCommands('delete')).toHaveLength(0);
  });

  it('leaves the theme row untouched (§3)', async () => {
    const { rows: before } = await db.query(
      'SELECT id, name, status, tokens, modified_at FROM themes WHERE id = ?',
      [baseThemeId],
    );
    expect((await initBase(baseThemeId)).status).toBe(200);
    const { rows: after } = await db.query(
      'SELECT id, name, status, tokens, modified_at FROM themes WHERE id = ?',
      [baseThemeId],
    );
    expect(after[0]).toEqual(before[0]);
  });

  it('404s a Custom Theme — each router answers for its own rows only', async () => {
    const res = await initBase(customThemeId);
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });

  it('403s a non-superadmin', async () => {
    mockAsNonSuperadmin();
    const res = await initBase(baseThemeId);
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });

  it('401s without authentication', async () => {
    const res = await request.post(`/platform/themes/${baseThemeId}/storage/initialize`);
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('503s when the deployment has no R2 — there is no per-gym 409 here', async () => {
    delete process.env.CLOUDFLARE_R2_BUCKET;
    const res = await initBase(baseThemeId);
    expect(res.status).toBe(503);
    expect(res.body.stage).toBe('resolve_path');
    expect(res.body.missingConfig).toEqual(expect.arrayContaining(['CLOUDFLARE_R2_BUCKET']));
    expect(putKeys()).toHaveLength(0);
  });

  it('502s naming the marker that failed (§4)', async () => {
    sendMock.mockRejectedValue(Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' }));
    const res = await initBase(baseThemeId);
    expect(res.status).toBe(502);
    expect(res.body.stage).toBe('create_theme_folder');
    expect(res.body.path.startsWith('cordel/Themes/')).toBe(true);
    expect(res.body.details.operation).toBe('ensureStorageFolders');
  });
});
