// #3328 stage 2: the nutrition plans' meals reference a Base Meal.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, request } from './helpers';

// A superadmin is an admin of every gym (tenantContext) and may write Cordel's Base Meals.
vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockResolvedValue({
          publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
        }),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: { createInvitation: vi.fn(), revokeInvitation: vi.fn() },
      emailAddresses: { getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 'test@example.com' }) },
    })),
  };
});

const H = { Authorization: TEST_AUTH_HEADER };
const MEAL_NAME = `Test Base Meal 3328s2 ${Date.now()}`;
let gymId: string;
let memberId: number;
let mealId: number;
let tplId: number;
let dayId: number;

const gym = () => ({ ...H, 'x-gym-id': gymId });

beforeAll(async () => {
  gymId = await createTestGym('Base Meal Ref Gym');
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'BM Member', ?)`,
    [gymId, `bm-member-${Date.now()}@test.com`],
  );
  memberId = insertId;

  const meal = await request.post('/platform/base-meals').set(H).send({
    name: MEAL_NAME, description: 'Pre-workout bowl',
    translations: { es: { name: `${MEAL_NAME} ES`, description: 'Bol previo' } },
  });
  expect(meal.status).toBe(201);
  mealId = meal.body.id;

  const tpl = await request.post('/nutrition-plan-templates').set(gym()).send({ name: `BM Template ${Date.now()}` });
  tplId = tpl.body.id;
  const day = await request.post(`/nutrition-plan-templates/${tplId}/days`).set(gym()).send({ weekday: 1 });
  dayId = day.body.id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.query('DELETE FROM base_meals WHERE name LIKE ?', ['Test Base Meal 3328s2%']);
  await db.end();
});

describe('nutrition plan meals reference Base Meals (#3328 stage 2)', () => {
  it('serves the live Base Meals as the picker list, localized, on all three routers', async () => {
    const res = await request.get('/nutrition-plan-templates/base-meals').set(gym()).set('x-locale', 'es');
    expect(res.status).toBe(200);
    expect(res.body.find((m: any) => m.slug === 'breakfast').display_name).toBe('Desayuno');
    expect(res.body.find((m: any) => m.id === mealId).display_name).toBe(`${MEAL_NAME} ES`);
    expect((await request.get('/member-nutrition-plans/base-meals').set(gym())).status).toBe(200);
    expect((await request.get('/platform/nutrition-plan-templates/base-meals').set(H)).status).toBe(200);
  });

  it('adds a meal by base_meal_id and reads its Base Meal back', async () => {
    const res = await request.post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set(gym()).set('x-locale', 'es').send({ base_meal_id: mealId });
    expect(res.status).toBe(201);
    expect(res.body.base_meal_id).toBe(mealId);
    expect(res.body.meal_name).toBe(`${MEAL_NAME} ES`);
    expect(res.body.meal_description).toBe('Bol previo');
    expect(typeof res.body.meal_type).toBe('string'); // the slug, kept for older readers
  });

  it('still accepts the legacy meal_type slug, resolved to its Base Meal', async () => {
    const res = await request.post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set(gym()).send({ meal_type: 'breakfast' });
    expect(res.status).toBe(201);
    const { rows } = await db.query<any>("SELECT id FROM base_meals WHERE slug = 'breakfast'");
    expect(res.body.base_meal_id).toBe(rows[0].id);
    expect(res.body.meal_name).toBe('Breakfast');
  });

  it('refuses an unknown meal, a missing one and a soft-deleted one', async () => {
    const url = `/nutrition-plan-templates/${tplId}/days/${dayId}/meals`;
    expect((await request.post(url).set(gym()).send({ base_meal_id: 99999999 })).status).toBe(400);
    expect((await request.post(url).set(gym()).send({ meal_type: 'brunch' })).status).toBe(400);
    expect((await request.post(url).set(gym()).send({})).status).toBe(400);
    const gone = await request.post('/platform/base-meals').set(H).send({ name: `${MEAL_NAME} gone` });
    expect((await request.delete(`/platform/base-meals/${gone.body.id}`).set(H)).status).toBe(204);
    expect((await request.post(url).set(gym()).send({ base_meal_id: gone.body.id })).status).toBe(400);
  });

  it('changes a meal’s Base Meal through PUT', async () => {
    const created = await request.post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set(gym()).send({ meal_type: 'lunch' });
    const res = await request.put(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${created.body.id}`)
      .set(gym()).send({ base_meal_id: mealId });
    expect(res.status).toBe(200);
    expect(res.body.base_meal_id).toBe(mealId);
    expect(res.body.meal_name).toBe(MEAL_NAME);
  });

  it('an assigned plan created from the template keeps the reference, and the member reads it', async () => {
    const plan = await request.post('/member-nutrition-plans').set(gym())
      .send({ confirm: true, member_id: memberId, template_id: tplId, start_date: '2026-01-01' });
    expect(plan.status).toBe(201);
    const hier = await request.get(`/member-nutrition-plans/${plan.body.id}/hierarchy`).set(gym());
    const meals = hier.body.days[0].meals;
    expect(meals.filter((m: any) => m.base_meal_id === mealId).length).toBeGreaterThan(0);
    expect(meals.every((m: any) => m.base_meal_id != null)).toBe(true);
  });

  it('a Base Meal a plan uses cannot be deleted; once unused it can', async () => {
    const refused = await request.delete(`/platform/base-meals/${mealId}`).set(H);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('base_meal_in_use');

    await db.query('DELETE FROM member_nutrition_plan_meals WHERE base_meal_id = ?', [mealId]);
    await db.query('DELETE FROM nutrition_plan_template_meals WHERE base_meal_id = ?', [mealId]);
    expect((await request.delete(`/platform/base-meals/${mealId}`).set(H)).status).toBe(204);
  });
});
