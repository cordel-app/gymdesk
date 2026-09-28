// #827: a Custom Theme is created only when the gym's Cloudflare R2 bucket has
// been initialized, and creating one initializes the Theme's own storage
// structure — `themes/<theme_id>-<name>/` with its `Logo/` and `Members/`
// leaves.
//
// Cloning is the only way a Custom Theme comes into existence (there is no
// gym-side `POST /system/themes`), so `POST /system/themes/clone/:sourceId` is
// where both the ticket's Create and Clone flows land.
//
// Split out of gym-themes.test.ts for the same reason theme-logo-storage.test.ts
// is: this file mocks @aws-sdk/client-s3 and moves the CLOUDFLARE_R2_* env
// around. The pure key/stage rules are covered by
// theme-storage-folders.unit.test.ts.

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

const originalEnv: Record<string, string | undefined> = {};
for (const key of R2_ENV_KEYS) originalEnv[key] = process.env[key];

function setStorageConfigured() {
  process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
}

let gymId: string;
let folderPrefix: string;
let sourceThemeId: string;

const SOURCE_THEME_NAME = 'Theme Storage Init Source';

/** The three markers a Theme's initialization writes, outermost first. */
function expectedMarkers(prefix: string, themeId: string, themeName: string): string[] {
  const folder = `${prefix}/themes/${themeId}-${themeName.replace(/\s+/g, '')}`;
  return [`${folder}/`, `${folder}/logo/`, `${folder}/members_app/`];
}

function sentCommands(type: 'put' | 'get' | 'delete') {
  return sendMock.mock.calls.map(([command]) => command).filter((c: any) => c?.__type === type);
}

/** Keys of every PUT the route made, folder markers included. */
function putKeys(): string[] {
  return sentCommands('put').map((c: any) => c.input.Key);
}

function clone(sourceId: string, callerGymId: string, name: string) {
  return request
    .post(`/system/themes/clone/${sourceId}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', callerGymId)
    .send({ name });
}

async function themeRowCount(name: string): Promise<number> {
  const { rows } = await db.query<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM themes WHERE gym_id = ? AND name = ?',
    [gymId, name],
  );
  return Number(rows[0].cnt);
}

beforeAll(async () => {
  gymId = await createTestGym('ThemeStorageInitGym');
  await createTestMembership(gymId, 'admin');
  folderPrefix = `gyms/${gymId}-ThemeStorageInitGym`;

  await db.query(
    `INSERT INTO themes (id, gym_id, name, status, tokens, created_at)
     VALUES (UUID(), ?, ?, 'active', '{}', UTC_TIMESTAMP())`,
    [gymId, SOURCE_THEME_NAME],
  );
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM themes WHERE gym_id = ? AND name = ? LIMIT 1',
    [gymId, SOURCE_THEME_NAME],
  );
  sourceThemeId = rows[0].id;
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
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [folderPrefix, gymId]);
  // Every clone below uses its own name, so the source is all that survives a case.
  await db.query('DELETE FROM themes WHERE gym_id = ? AND id <> ?', [gymId, sourceThemeId]);
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

describe('POST /system/themes/clone/:sourceId — gym bucket check (#827)', () => {
  it('returns 409 and creates no theme when the gym bucket was never initialized', async () => {
    await db.query('UPDATE gyms SET storage_folder_prefix = NULL WHERE id = ?', [gymId]);

    const res = await clone(sourceThemeId, gymId, 'Uninitialized Bucket Clone');
    expect(res.status).toBe(409);
    expect(res.body.stage).toBe('resolve_path');
    expect(res.body.error).toContain('not been initialized');
    // §2: no partially created theme, and §7: no folders either.
    expect(await themeRowCount('Uninitialized Bucket Clone')).toBe(0);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 503 naming the missing config and creates no theme when the deployment has no R2', async () => {
    delete process.env.CLOUDFLARE_R2_BUCKET;

    const res = await clone(sourceThemeId, gymId, 'Unconfigured Storage Clone');
    expect(res.status).toBe(503);
    expect(res.body.stage).toBe('resolve_path');
    expect(res.body.missingConfig).toEqual(expect.arrayContaining(['CLOUDFLARE_R2_BUCKET']));
    expect(await themeRowCount('Unconfigured Storage Clone')).toBe(0);
    expect(putKeys()).toHaveLength(0);
  });

  it('checks the bucket before the name conflict is even relevant — an existing name still wins', async () => {
    // The uniqueness check stays first, so its 409 keeps its own message.
    const res = await clone(sourceThemeId, gymId, SOURCE_THEME_NAME);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A theme with this name already exists');
    expect(putKeys()).toHaveLength(0);
  });
});

describe('POST /system/themes/clone/:sourceId — theme storage initialization (#827)', () => {
  it('creates the theme folder with its Logo/ and Members/ leaves', async () => {
    const res = await clone(sourceThemeId, gymId, 'Initialized Clone');
    expect(res.status).toBe(201);
    expect(putKeys()).toEqual(expectedMarkers(folderPrefix, res.body.id, 'Initialized Clone'));
  });

  it('never creates the gym root or its themes/ branch — Gym Bucket Initialization owns those (#735)', async () => {
    const res = await clone(sourceThemeId, gymId, 'Roots Untouched Clone');
    expect(res.status).toBe(201);
    expect(putKeys()).not.toContain(`${folderPrefix}/`);
    expect(putKeys()).not.toContain(`${folderPrefix}/themes/`);
  });

  it('writes folder markers only — zero-byte keys ending in a slash, so a re-run is idempotent (§8)', async () => {
    const res = await clone(sourceThemeId, gymId, 'Idempotent Clone');
    expect(res.status).toBe(201);
    for (const command of sentCommands('put')) {
      expect((command as any).input.Key.endsWith('/')).toBe(true);
      expect((command as any).input.Body).toBe('');
    }
    // A second clone of the same source succeeds and writes its own markers:
    // existing ones are simply rewritten, never a reason to fail.
    sendMock.mockClear();
    const again = await clone(sourceThemeId, gymId, 'Idempotent Clone Two');
    expect(again.status).toBe(201);
    expect(putKeys()).toEqual(expectedMarkers(folderPrefix, again.body.id, 'Idempotent Clone Two'));
  });

  it('gives the clone its own storage path — never the source theme\'s', async () => {
    const res = await clone(sourceThemeId, gymId, 'Own Path Clone');
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(sourceThemeId);
    for (const key of putKeys()) {
      expect(key).toContain(`${folderPrefix}/themes/${res.body.id}-`);
      expect(key).not.toContain(`/${sourceThemeId}-`);
    }
  });

  it('sanitizes the theme name in the key, exactly as the upload routes do', async () => {
    const res = await clone(sourceThemeId, gymId, 'Spaced Out Clone');
    expect(res.status).toBe(201);
    expect(putKeys()[0]).toBe(`${folderPrefix}/themes/${res.body.id}-SpacedOutClone/`);
  });

  it('returns 502 naming the failing marker and creates no theme when storage fails', async () => {
    sendMock.mockRejectedValue(Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' }));

    const res = await clone(sourceThemeId, gymId, 'Storage Failure Clone');
    expect(res.status).toBe(502);
    expect(res.body.stage).toBe('create_theme_folder');
    expect(res.body.path).toContain(`${folderPrefix}/themes/`);
    expect(res.body.details.operation).toBe('ensureStorageFolders');
    // §7: no partially created theme is left behind.
    expect(await themeRowCount('Storage Failure Clone')).toBe(0);
  });

  it('names the Members leaf when that is the marker that failed', async () => {
    let call = 0;
    sendMock.mockImplementation(async () => {
      call += 1;
      if (call === 3) throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' });
      return {};
    });

    const res = await clone(sourceThemeId, gymId, 'Members Leaf Failure Clone');
    expect(res.status).toBe(502);
    expect(res.body.stage).toBe('create_members_folder');
    expect(res.body.path.endsWith('/members_app/')).toBe(true);
    expect(await themeRowCount('Members Leaf Failure Clone')).toBe(0);
  });

});

// The cases below were in gym-themes.test.ts until #827 made a clone depend on
// the gym's bucket: what they assert about cloning is unchanged, they just need
// the mocked R2 client this file provides.
describe('POST /system/themes/clone/:sourceId — what a clone carries over', () => {
  it('snapshots the creating actor on clone and returns it on the theme (#712)', async () => {
    const res = await clone(sourceThemeId, gymId, 'Creator Snapshot Clone');
    expect(res.status).toBe(201);
    expect(res.body.created_by_name).toBe('Test User');
    expect(res.body.created_by_type).toBe('staff');
    expect(typeof res.body.created_at).toBe('string');
    expect(res.body.status).toBe('draft');

    const { rows } = await db.query<{ created_by_name: string | null; created_by_type: string | null }>(
      'SELECT created_by_name, created_by_type FROM themes WHERE id = ?',
      [res.body.id],
    );
    expect(rows[0].created_by_name).toBe('Test User');
    expect(rows[0].created_by_type).toBe('staff');
  });

  it('inherits logo_contains_gym_name from the source theme', async () => {
    await db.query('UPDATE themes SET logo_contains_gym_name = 1 WHERE id = ?', [sourceThemeId]);
    const res = await clone(sourceThemeId, gymId, 'Logo Flag Clone');
    expect(res.status).toBe(201);
    expect(res.body.logo_contains_gym_name).toBe(true);
  });

  it('copies the source theme\'s tokens, calendar colours included', async () => {
    const calendarColors = { calendarBackground: '#101828', calendarEventBackground: '#1d2939' };
    await db.query('UPDATE themes SET tokens = ? WHERE id = ?', [
      JSON.stringify({ colors: calendarColors }),
      sourceThemeId,
    ]);

    const res = await clone(sourceThemeId, gymId, 'Calendar Clone Test');
    expect(res.status).toBe(201);
    expect(res.body.tokens.colors).toMatchObject(calendarColors);
  });

  it('starts the clone with no Members App images of its own', async () => {
    const res = await clone(sourceThemeId, gymId, 'Empty Members Clone');
    expect(res.status).toBe(201);
    for (const url of Object.values(res.body.members_images)) expect(url).toBeNull();
  });
});
