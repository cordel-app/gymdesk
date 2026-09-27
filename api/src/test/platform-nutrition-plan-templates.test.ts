// Tests for platform-nutrition-plan-templates.ts router — the Base Nutrition
// Plan Templates administered from Cordel.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, request } from './helpers';

// Override the default @clerk/backend mock: make test-user-id a superadmin.
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

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ---------------------------------------------------------------------------
// Food Type options (#812)
// ---------------------------------------------------------------------------

describe('GET /platform/nutrition-plan-templates/component-types', () => {
  it('returns the seven types a template meal item accepts', async () => {
    const res = await request
      .get('/platform/nutrition-plan-templates/component-types')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.component_types).toEqual([
      'main_dish', 'side', 'sauce', 'drink', 'dessert', 'other', 'additional',
    ]);
  });

  it('requires auth', async () => {
    const res = await request.get('/platform/nutrition-plan-templates/component-types');
    expect(res.status).toBe(401);
  });

  it('requires superadmin', async () => {
    mockGetUser.mockResolvedValueOnce({
      publicMetadata: {},
      fullName: 'Regular User',
      firstName: 'Regular',
      lastName: 'User',
    });
    const res = await request
      .get('/platform/nutrition-plan-templates/component-types')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(403);
  });

  it('is not shadowed by GET /:id — `component-types` is not read as an id', async () => {
    // Registered before `/:id`; if that order is ever lost this returns the
    // 400/404 of an id lookup instead of the options.
    const res = await request
      .get('/platform/nutrition-plan-templates/component-types')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.component_types)).toBe(true);
  });
});
