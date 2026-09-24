// Tests for gyms.ts router — POST /platform/gyms/:id/storage/initialize (#417 stage 1)

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// Default: TEST_USER_ID is a superadmin. Individual tests that need a
// non-superadmin user override this via mockResolvedValueOnce / mockResolvedValue.
const mockGetUser = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin',
    firstName: 'Super',
    lastName: 'Admin',
    emailAddresses: [],
    primaryEmailAddressId: null,
  }),
);

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: mockGetUser,
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: {
        createInvitation: vi.fn().mockResolvedValue({ id: 'inv-test-id' }),
        revokeInvitation: vi.fn().mockResolvedValue({}),
      },
      emailAddresses: {
        getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 'test@example.com' }),
      },
    })),
  };
});

// The real @aws-sdk/client-s3 calls inside initializeGymBucket() must never hit
// the network in tests — mock the whole storage module, keeping the pure
// buildGymFolderPrefix()/sanitizeGymFolderName() helpers real so tests can
// compute the same expected prefix the router computes.
const mockIsStorageConfigured = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockGetMissingStorageConfigKeys = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockInitializeGymBucket = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../infra/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/storage')>();
  return {
    ...actual,
    isStorageConfigured: mockIsStorageConfigured,
    getMissingStorageConfigKeys: mockGetMissingStorageConfigKeys,
    initializeGymBucket: mockInitializeGymBucket,
  };
});

// Imported after the mock is declared — buildGymFolderPrefix is the real
// (unmocked) implementation, so tests can compute the expected prefix.
import { buildGymFolderPrefix, StorageOperationError } from '../infra/storage';

let gymId: string;
let gymName: string;

beforeAll(async () => {
  gymName = 'Storage Init Test Gym';
  gymId = await createTestGym(gymName);
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

beforeEach(() => {
  mockGetUser.mockClear();
  mockGetUser.mockResolvedValue({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin',
    firstName: 'Super',
    lastName: 'Admin',
    emailAddresses: [],
    primaryEmailAddressId: null,
  });
  mockIsStorageConfigured.mockReset().mockReturnValue(true);
  mockGetMissingStorageConfigKeys.mockReset().mockReturnValue([]);
  mockInitializeGymBucket.mockReset().mockResolvedValue(undefined);
});

/** POST /platform/gyms/:id/storage/initialize with superadmin auth. */
function initStorage(id: string) {
  return request
    .post(`/platform/gyms/${id}/storage/initialize`)
    .set('Authorization', TEST_AUTH_HEADER);
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe('Auth guard', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request.post(`/platform/gyms/${gymId}/storage/initialize`);
    expect(res.status).toBe(401);
  });

  it('returns 403 when the authenticated user is not a superadmin', async () => {
    mockGetUser.mockResolvedValue({
      publicMetadata: {},
      fullName: 'Regular User',
      firstName: 'Regular',
      lastName: 'User',
      emailAddresses: [],
      primaryEmailAddressId: null,
    });
    const res = await initStorage(gymId);
    expect(res.status).toBe(403);
    // Must never reach the storage layer for a rejected caller.
    expect(mockInitializeGymBucket).not.toHaveBeenCalled();
  });
});

// ─── Gym not found ─────────────────────────────────────────────────────────────

describe('gym not found', () => {
  it('returns 404 for an unknown gym ID', async () => {
    const res = await initStorage('00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect(mockInitializeGymBucket).not.toHaveBeenCalled();
  });

  it('returns 404 when the gym has been soft-deleted', async () => {
    const id = await createTestGym('Soft Deleted Storage Gym');
    await db.query('UPDATE gyms SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [id]);

    const res = await initStorage(id);
    expect(res.status).toBe(404);
    expect(mockInitializeGymBucket).not.toHaveBeenCalled();
  });
});

// ─── Storage not configured ────────────────────────────────────────────────────

describe('storage not configured', () => {
  it('returns 503 when isStorageConfigured() is false, naming the missing env vars', async () => {
    mockIsStorageConfigured.mockReturnValue(false);
    mockGetMissingStorageConfigKeys.mockReturnValue(['CLOUDFLARE_R2_BUCKET']);

    const res = await initStorage(gymId);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: 'Cloudflare storage has not been configured for this deployment (missing: CLOUDFLARE_R2_BUCKET)',
      missingConfig: ['CLOUDFLARE_R2_BUCKET'],
    });
    // #542: the config snapshot rides along so an admin can see which parts of
    // the R2 config did reach the container.
    expect(res.body.diagnostics).toBeDefined();
    expect(mockInitializeGymBucket).not.toHaveBeenCalled();

    // Row must be left untouched.
    const { rows } = await db.query('SELECT storage_folder_prefix, storage_initialized_at FROM gyms WHERE id = ?', [gymId]);
    expect(rows[0].storage_folder_prefix).toBeNull();
    expect(rows[0].storage_initialized_at).toBeNull();
  });
});

// ─── initializeGymBucket failure ───────────────────────────────────────────────

describe('bucket initialization failure', () => {
  it('returns 502 with an error message when initializeGymBucket throws, and leaves the row untouched', async () => {
    const id = await createTestGym('Bucket Failure Gym');
    mockInitializeGymBucket.mockRejectedValueOnce(new Error('R2 network timeout'));

    const res = await initStorage(id);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/R2 network timeout/);

    const { rows } = await db.query('SELECT storage_folder_prefix, storage_initialized_at FROM gyms WHERE id = ?', [id]);
    expect(rows[0].storage_folder_prefix).toBeNull();
    expect(rows[0].storage_initialized_at).toBeNull();
  });

  // #542: a one-line toast could not distinguish a wrong endpoint from a wrong
  // bucket from a bad key, so the 502 now carries structured detail.
  it('returns the StorageOperationError details verbatim, plus the deployment diagnostics', async () => {
    const id = await createTestGym('Bucket Detail Gym');
    const details = {
      operation: 'initializeGymBucket',
      message: 'The specified bucket does not exist',
      name: 'NoSuchBucket',
      code: 'NoSuchBucket',
      httpStatusCode: 404,
      requestId: 'req-abc-123',
      attempts: 3,
      key: 'gym-Nutrition/',
      bucket: 'gymdesk',
      causes: [],
    };
    mockInitializeGymBucket.mockRejectedValueOnce(
      new StorageOperationError(details, new Error('underlying')),
    );

    const res = await initStorage(id);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Failed to initialize Cloudflare storage: The specified bucket does not exist');
    expect(res.body.details).toEqual(details);
    expect(res.body.diagnostics).toMatchObject({
      missingConfig: expect.any(Array),
      accessKeyIdLength: expect.any(Number),
      secretAccessKeyLength: expect.any(Number),
    });

    const { rows } = await db.query('SELECT storage_folder_prefix, storage_initialized_at FROM gyms WHERE id = ?', [id]);
    expect(rows[0].storage_folder_prefix).toBeNull();
    expect(rows[0].storage_initialized_at).toBeNull();
  });

  it('never leaks the access key or the secret into the 502 body', async () => {
    const id = await createTestGym('Bucket Secret Leak Gym');
    const previous = {
      key: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
      secret: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    };
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'leak-canary-access-key';
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'leak-canary-secret-value';
    mockInitializeGymBucket.mockRejectedValueOnce(new Error('SignatureDoesNotMatch'));

    try {
      const res = await initStorage(id);
      expect(res.status).toBe(502);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('leak-canary-access-key');
      expect(body).not.toContain('leak-canary-secret-value');
    } finally {
      if (previous.key === undefined) delete process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
      else process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = previous.key;
      if (previous.secret === undefined) delete process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
      else process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = previous.secret;
    }
  });

  it('falls back to describeStorageError for a plain Error, still returning details', async () => {
    const id = await createTestGym('Bucket Plain Error Gym');
    mockInitializeGymBucket.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));

    const res = await initStorage(id);
    expect(res.status).toBe(502);
    expect(res.body.details).toMatchObject({
      operation: 'initializeGymBucket',
      message: 'connect ETIMEDOUT',
      name: 'Error',
      httpStatusCode: null,
    });
  });
});

// ─── Happy path ─────────────────────────────────────────────────────────────────

describe('happy path', () => {
  it('initializes storage, persists the folder prefix, and returns the updated gym', async () => {
    const id = await createTestGym('Happy Path Storage Gym');
    const expectedPrefix = buildGymFolderPrefix(id, 'Happy Path Storage Gym');

    const res = await initStorage(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      storage_configured: true,
      storage_folder_prefix: expectedPrefix,
    });
    expect(res.body.storage_initialized_at).not.toBeNull();

    expect(mockInitializeGymBucket).toHaveBeenCalledTimes(1);
    expect(mockInitializeGymBucket).toHaveBeenCalledWith(expectedPrefix);

    const { rows } = await db.query(
      'SELECT storage_folder_prefix, storage_initialized_at FROM gyms WHERE id = ?',
      [id],
    );
    expect(rows[0].storage_folder_prefix).toBe(expectedPrefix);
    expect(rows[0].storage_initialized_at).not.toBeNull();
  });

  it('every gym response includes storage_configured computed from env, even without initializing', async () => {
    mockIsStorageConfigured.mockReturnValue(false);
    const res = await request
      .get(`/platform/gyms/${gymId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.storage_configured).toBe(false);
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('reuses the existing storage_folder_prefix on re-init instead of recomputing it after a rename', async () => {
    const id = await createTestGym('Original Name Before Rename');

    const first = await initStorage(id);
    expect(first.status).toBe(200);
    const originalPrefix = first.body.storage_folder_prefix as string;
    expect(originalPrefix).toBe(buildGymFolderPrefix(id, 'Original Name Before Rename'));

    // Rename the gym — the prefix must NOT be recomputed from the new name.
    const renameRes = await request
      .put(`/platform/gyms/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: 'Renamed After Init' });
    expect(renameRes.status).toBe(200);

    const second = await initStorage(id);
    expect(second.status).toBe(200);
    expect(second.body.storage_folder_prefix).toBe(originalPrefix);
    expect(second.body.storage_folder_prefix).not.toBe(
      buildGymFolderPrefix(id, 'Renamed After Init'),
    );
    // storage_initialized_at is refreshed, not left untouched.
    expect(second.body.storage_initialized_at).not.toBeNull();

    // initializeGymBucket is still invoked (and with the original prefix) on
    // re-init, even though the row already had a prefix stored.
    expect(mockInitializeGymBucket).toHaveBeenCalledWith(originalPrefix);

    const { rows } = await db.query('SELECT storage_folder_prefix FROM gyms WHERE id = ?', [id]);
    expect(rows[0].storage_folder_prefix).toBe(originalPrefix);
  });

  // #735 §"Existing Gym Support": a gym initialized before the gym-level
  // `Themes/` folder existed receives it by re-running the same action — the
  // endpoint re-writes the whole marker set under the prefix already captured,
  // so nothing about the row has to be migrated. Which markers that set holds
  // (Themes/ among them) is pinned by the unit tests in storage.test.ts, since
  // initializeGymBucket is mocked here.
  it('re-initializes a gym whose storage was provisioned before Themes/ existed, using its stored prefix', async () => {
    const id = await createTestGym('Gym Initialized Before Themes');
    const legacyPrefix = buildGymFolderPrefix(id, 'Gym Initialized Before Themes');
    await db.query(
      `UPDATE gyms SET storage_folder_prefix = ?, storage_initialized_at = UTC_TIMESTAMP() WHERE id = ?`,
      [legacyPrefix, id],
    );

    const res = await initStorage(id);
    expect(res.status).toBe(200);
    expect(mockInitializeGymBucket).toHaveBeenCalledWith(legacyPrefix);
    expect(res.body.storage_folder_prefix).toBe(legacyPrefix);
  });
});
