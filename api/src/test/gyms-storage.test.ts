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
const mockInitializeGymBucket = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../infra/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/storage')>();
  return {
    ...actual,
    isStorageConfigured: mockIsStorageConfigured,
    initializeGymBucket: mockInitializeGymBucket,
  };
});

// Imported after the mock is declared — buildGymFolderPrefix is the real
// (unmocked) implementation, so tests can compute the expected prefix.
import { buildGymFolderPrefix } from '../infra/storage';

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
  it('returns 503 when isStorageConfigured() is false', async () => {
    mockIsStorageConfigured.mockReturnValue(false);

    const res = await initStorage(gymId);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'Cloudflare storage has not been configured for this deployment',
    });
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
});
