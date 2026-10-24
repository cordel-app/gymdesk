// Tests for platform-nutrition-plan-templates.ts router — the Base Nutrition
// Plan Templates administered from Cordel.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, request, syncLegacySystemFoodsToBase } from './helpers';

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

// ---------------------------------------------------------------------------
// A Base template's goal illustration can be changed after creation (#932)
// ---------------------------------------------------------------------------

describe('PUT /platform/nutrition-plan-templates/:id/goals/:gid', () => {
  const auth = { Authorization: TEST_AUTH_HEADER };
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let systemFoodId: number;
  let gymFoodId: number;
  let gymId: string;

  async function baseTemplateWithGoal(): Promise<{ tplId: number; goalId: number }> {
    const tpl = await request.post('/platform/nutrition-plan-templates').set(auth).send({ name: `PGI Base ${uniq}-${Math.random()}` });
    expect(tpl.status).toBe(201);
    const goal = await request.post(`/platform/nutrition-plan-templates/${tpl.body.id}/goals`).set(auth)
      .send({ item_name: 'water', quantity: 2, unit: 'l' });
    expect(goal.status).toBe(201);
    return { tplId: tpl.body.id, goalId: goal.body.id };
  }
  const put = (tplId: number, goalId: number, body: Record<string, unknown>) =>
    request.put(`/platform/nutrition-plan-templates/${tplId}/goals/${goalId}`).set(auth).send(body);

  it('sets and clears the System food that illustrates the goal', async () => {
    const { createTestGym } = await import('./helpers');
    gymId = await createTestGym('PGI Gym');
    const sys = await db.query(
      "INSERT INTO nutrition_library_items (gym_id, name, status, image_url) VALUES (NULL, ?, 'active', 'https://cdn.example/pgi/system.png')",
      [`PGI System ${uniq}`],
    );
    systemFoodId = sys.insertId;
    await syncLegacySystemFoodsToBase();
    const gymFood = await db.query(
      "INSERT INTO nutrition_library_items (gym_id, name, status) VALUES (?, ?, 'active')",
      [gymId, `PGI Gym Food ${uniq}`],
    );
    gymFoodId = gymFood.insertId;

    const { tplId, goalId } = await baseTemplateWithGoal();
    const set = await put(tplId, goalId, { nutrition_library_item_id: systemFoodId });
    expect(set.status).toBe(200);
    expect(set.body.nutrition_library_item_id).toBe(systemFoodId);
    expect(set.body.illustration_image_url).toBe('https://cdn.example/pgi/system.png');

    const cleared = await put(tplId, goalId, { nutrition_library_item_id: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.nutrition_library_item_id).toBeNull();

    await db.query('DELETE FROM nutrition_plan_templates WHERE id = ?', [tplId]);
  });

  it('refuses a gym-owned food, a body naming no food and an unknown goal', async () => {
    const { tplId, goalId } = await baseTemplateWithGoal();
    expect((await put(tplId, goalId, { nutrition_library_item_id: gymFoodId })).status).toBe(400);
    expect((await put(tplId, goalId, {})).status).toBe(400);
    expect((await put(tplId, 999999999, { nutrition_library_item_id: null })).status).toBe(404);
    await db.query('DELETE FROM nutrition_plan_templates WHERE id = ?', [tplId]);
  });

  it('requires auth and a superadmin', async () => {
    const anon = await request.put('/platform/nutrition-plan-templates/1/goals/1').send({ nutrition_library_item_id: null });
    expect(anon.status).toBe(401);
    mockGetUser.mockResolvedValueOnce({
      publicMetadata: {},
      fullName: 'Regular User',
      firstName: 'Regular',
      lastName: 'User',
    });
    const res = await put(1, 1, { nutrition_library_item_id: null });
    expect(res.status).toBe(403);
  });

  afterAll(async () => {
    if (systemFoodId) await db.query('DELETE FROM nutrition_library_items WHERE id = ?', [systemFoodId]);
  });
});
