// #1077 — GET /platform/mobile-builds and GET /platform/mobile-builds/:id/download.
// Storage is mocked: the bucket is the record, so the tests stand in for it.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, request } from './helpers';
import { buildIdFromKey, mobileBuildsPrefix } from '../domain/mobileBuilds';

const mockGetUser = vi.hoisted(() =>
  vi.fn().mockImplementation(async () => ({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin',
    firstName: 'Super',
    lastName: 'Admin',
  })),
);

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: { getUser: mockGetUser, getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }) },
      invitations: { createInvitation: vi.fn(), revokeInvitation: vi.fn() },
      emailAddresses: { getEmailAddress: vi.fn() },
    })),
  };
});

const storage = vi.hoisted(() => ({
  configured: true,
  objects: new Map<string, { body: string; size?: number }>(),
}));

vi.mock('../infra/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/storage')>();
  return {
    ...actual,
    isStorageConfigured: () => storage.configured,
    listStorageObjects: async (prefix: string) =>
      [...storage.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, o]) => ({ key, size: o.size ?? Buffer.byteLength(o.body), lastModified: null })),
    getStorageObject: async (key: string) => {
      const o = storage.objects.get(key);
      if (!o) {
        throw new actual.StorageOperationError(
          {
            operation: 'getStorageObject', message: 'missing', name: 'NoSuchKey', code: 'NoSuchKey',
            httpStatusCode: 404, requestId: null, attempts: 1, key, bucket: 'b', causes: [],
          },
          new Error('NoSuchKey'),
        );
      }
      return { body: Buffer.from(o.body), contentType: null };
    },
  };
});

const PREFIX = mobileBuildsPrefix();
const APK = 'cordel-fitness-dev-1.0.0-b57-ab12cd34.apk';
const APK_KEY = `${PREFIX}com.cordel.fitness.dev/android/${APK}`;
const ZIP = 'cordel-fitness-dev-1.0.0-b57-ab12cd34-ios-simulator.zip';
const ZIP_KEY = `${PREFIX}com.cordel.fitness.dev/ios_simulator/${ZIP}`;

function sidecar(platform: string, file: string, builtAt: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    app_id: 'com.cordel.fitness.dev', app_name: 'Cordel Fitness Dev', environment: 'dev', platform,
    version: '1.0.0', build_number: 57, git_sha: 'ab12cd34ef56', built_at: builtAt, file, ...extra,
  });
}

beforeEach(() => {
  storage.configured = true;
  storage.objects.clear();
  storage.objects.set(APK_KEY, { body: 'APK-BYTES' });
  storage.objects.set(`${APK_KEY}.json`, { body: sidecar('android', APK, '2026-10-08T17:00:00Z') });
  storage.objects.set(ZIP_KEY, { body: 'ZIP' });
  storage.objects.set(`${ZIP_KEY}.json`, { body: sidecar('ios_simulator', ZIP, '2026-10-08T18:00:00Z') });
});

afterAll(async () => {
  await db.end();
});

describe('auth', () => {
  it('401 without a token', async () => {
    expect((await request.get('/platform/mobile-builds')).status).toBe(401);
    expect((await request.get(`/platform/mobile-builds/${buildIdFromKey(APK_KEY)}/download`)).status).toBe(401);
  });

  it('403 for a user who is not a superadmin', async () => {
    mockGetUser.mockResolvedValueOnce({ publicMetadata: {}, fullName: 'R', firstName: 'R', lastName: 'U' });
    const list = await request.get('/platform/mobile-builds').set('Authorization', TEST_AUTH_HEADER);
    expect(list.status).toBe(403);
    mockGetUser.mockResolvedValueOnce({ publicMetadata: {}, fullName: 'R', firstName: 'R', lastName: 'U' });
    const download = await request
      .get(`/platform/mobile-builds/${buildIdFromKey(APK_KEY)}/download`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(download.status).toBe(403);
  });
});

describe('GET /platform/mobile-builds', () => {
  it('lists the published builds, newest first, with the retention it keeps', async () => {
    const res = await request.get('/platform/mobile-builds').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.keep).toBe(20);
    expect(res.body.builds.map((b: any) => b.platform)).toEqual(['ios_simulator', 'android']);
    expect(res.body.builds[1]).toMatchObject({
      app_id: 'com.cordel.fitness.dev', version: '1.0.0', build_number: 57, file: APK, size_bytes: 9,
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('leaves out a sidecar that does not describe a build, and one whose file is gone', async () => {
    storage.objects.set(`${PREFIX}com.cordel.fitness.dev/android/broken.apk.json`, { body: '{"nope":true}' });
    storage.objects.set(`${PREFIX}com.cordel.fitness.dev/android/broken.apk`, { body: 'x' });
    storage.objects.set(`${PREFIX}com.cordel.fitness.dev/android/orphan.apk.json`, {
      body: sidecar('android', 'orphan.apk', '2026-10-08T19:00:00Z'),
    });
    storage.objects.set(`${PREFIX}com.cordel.fitness.dev/android/notjson.apk.json`, { body: 'not json' });
    storage.objects.set(`${PREFIX}com.cordel.fitness.dev/android/notjson.apk`, { body: 'x' });
    const res = await request.get('/platform/mobile-builds').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.builds).toHaveLength(2);
  });

  it('answers an empty list when nothing was published', async () => {
    storage.objects.clear();
    const res = await request.get('/platform/mobile-builds').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.builds).toEqual([]);
  });

  it('503 when this deployment has no storage', async () => {
    storage.configured = false;
    const res = await request.get('/platform/mobile-builds').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('storage_not_configured');
  });
});

describe('GET /platform/mobile-builds/:id/download', () => {
  it('streams the file as an attachment with the right type', async () => {
    const res = await request
      .get(`/platform/mobile-builds/${buildIdFromKey(APK_KEY)}/download`)
      .set('Authorization', TEST_AUTH_HEADER)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${APK}"`);
    expect(res.headers['content-length']).toBe('9');
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as Buffer).toString()).toBe('APK-BYTES');
  });

  it('404 for an id that decodes outside the builds, or to a sidecar', async () => {
    const outside = Buffer.from('../gyms/g1/members/photo.png', 'utf8').toString('base64url');
    const sidecarId = Buffer.from(`com.cordel.fitness.dev/android/${APK}.json`, 'utf8').toString('base64url');
    for (const id of [outside, sidecarId, 'not-an-id!!']) {
      const res = await request.get(`/platform/mobile-builds/${id}/download`).set('Authorization', TEST_AUTH_HEADER);
      expect(res.status).toBe(404);
    }
  });

  it('404 for a well-formed id whose object is gone', async () => {
    const gone = buildIdFromKey(`${PREFIX}com.cordel.fitness.dev/android/old-build.apk`);
    const res = await request.get(`/platform/mobile-builds/${gone}/download`).set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });
});
