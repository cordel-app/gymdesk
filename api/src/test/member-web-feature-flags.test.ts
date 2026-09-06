// Tests for #367 — member_web.* feature flag gating on /me/* routes.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { invalidateFeatureFlagsCache } from '../infra/featureFlags';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// Default mock = superadmin, so toggling flags via /platform/feature-flags needs no
// per-test override. Individual /me/* calls made "as the member" override this once
// with mockGetUser.mockResolvedValueOnce to simulate the actual (non-superadmin) caller.
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

let gymId: string;
let memberId: number;

function asRegularMember() {
  mockGetUser.mockResolvedValueOnce({
    publicMetadata: {},
    fullName: 'Flag Test Member',
    firstName: 'Flag',
    lastName: 'Test',
  });
}

async function setFlag(key: string, enabled: boolean) {
  const res = await request
    .put(`/platform/feature-flags/${encodeURIComponent(key)}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .send({ enabled });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  gymId = await createTestGym('Member Web Flags Gym');
  await createTestMembership(gymId, 'member');

  const email = `member-web-flags-${Date.now()}@test.com`;
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'Flag Test Member', ?, ?)`,
    [gymId, email, TEST_USER_ID],
  );
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM members WHERE clerk_user_id = ?',
    [TEST_USER_ID],
  );
  memberId = rows[0].id;
});

afterAll(async () => {
  // Safety net: re-enable any flags a failed assertion may have left disabled.
  await db.query(`UPDATE feature_flags SET enabled = 1 WHERE feature_key LIKE 'member\\_web.%'`);
  await db.query(`DELETE FROM feature_flags WHERE feature_key = 'member_web'`);
  invalidateFeatureFlagsCache();
  await cleanupTestGyms();
  await db.end();
});

describe('member_web.* flags gate /me/* routes for regular members', () => {
  it('returns 403 on GET /me/nutrition-plan when member_web.my_nutrition is disabled', async () => {
    await setFlag('member_web.my_nutrition', false);

    asRegularMember();
    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);

    await setFlag('member_web.my_nutrition', true);
  });

  it('returns 200 on GET /me/nutrition-plan once member_web.my_nutrition is re-enabled', async () => {
    asRegularMember();
    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
  });

  it('returns 403 on GET /me/training-plans when member_web.my_training_plan is disabled', async () => {
    await setFlag('member_web.my_training_plan', false);

    asRegularMember();
    const res = await request
      .get('/me/training-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);

    await setFlag('member_web.my_training_plan', true);
  });

  it('returns 403 on GET /me/bookings when member_web.my_bookings is disabled', async () => {
    await setFlag('member_web.my_bookings', false);

    asRegularMember();
    const res = await request
      .get('/me/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);

    await setFlag('member_web.my_bookings', true);
  });

  it('returns 403 on GET /me/upcoming when member_web.my_bookings is disabled', async () => {
    await setFlag('member_web.my_bookings', false);

    asRegularMember();
    const res = await request
      .get('/me/upcoming')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);

    await setFlag('member_web.my_bookings', true);
  });

  it('returns 403 on GET /me/membership when member_web.my_membership is disabled', async () => {
    await setFlag('member_web.my_membership', false);

    asRegularMember();
    const res = await request
      .get('/me/membership')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);

    await setFlag('member_web.my_membership', true);
  });

  it('returns 403 on GET /me/nutrition-plan when the ancestor member_web flag is disabled', async () => {
    // The 'member_web' root has no seeded row by default; requireFeatureEnabled's
    // ancestor-cascade check still must honor one if it exists (mirrors the
    // membership/membership.members cascade test in platform-feature-flags.test.ts).
    await db.query(
      "INSERT INTO feature_flags (feature_key, enabled) VALUES ('member_web', 0) ON DUPLICATE KEY UPDATE enabled = 0",
    );
    invalidateFeatureFlagsCache();

    asRegularMember();
    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);

    await db.query("UPDATE feature_flags SET enabled = 1 WHERE feature_key = 'member_web'");
    invalidateFeatureFlagsCache();
  });
});

describe('superadmin bypasses member_web feature flags while impersonating a member', () => {
  it('returns 200 on GET /me/nutrition-plan for a superadmin impersonating a member, even when disabled', async () => {
    await setFlag('member_web.my_nutrition', false);

    // Default mock (no mockResolvedValueOnce override) = superadmin.
    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('x-impersonate-as', `member:${memberId}`);
    expect(res.status).toBe(200);

    await setFlag('member_web.my_nutrition', true);
  });
});
