// #3484: Convert to Template on an Assigned Nutrition Plan — a working copy that
// Save turns into a gym template and Cancel hard-deletes, never touching the plan.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let otherGymId: string;
let memberId: number;
let foodId: number;

const as = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });
const api = {
  post: (path: string, gym = gymId) => request.post(path).set(as(gym)),
  put: (path: string, gym = gymId) => request.put(path).set(as(gym)),
  del: (path: string, gym = gymId) => request.delete(path).set(as(gym)),
  get: (path: string, gym = gymId) => request.get(path).set(as(gym)),
};

/** An assigned plan with a day, a meal with a food, a restriction and a goal. */
async function createPlan(name: string, status: 'active' | 'draft' | 'completed' = 'active'): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO member_nutrition_plans (gym_id, member_id, name, description, member_notes, start_date, status, created_by)
     VALUES (?, ?, ?, 'Plan description', 'Drink water', '2026-01-01', ?, 'Test')`,
    [gymId, memberId, name, status],
  ) as any;
  const { insertId: dayId } = await db.query(
    'INSERT INTO member_nutrition_plan_days (gym_id, member_nutrition_plan_id, weekday, position) VALUES (?, ?, 1, 1)',
    [gymId, planId],
  ) as any;
  const { insertId: mealId } = await db.query(
    "INSERT INTO member_nutrition_plan_meals (gym_id, member_nutrition_plan_day_id, meal_type, base_meal_id, display_name, notes, position) VALUES (?, ?, 'breakfast', (SELECT id FROM base_meals WHERE slug = 'breakfast'), 'Breakfast', 'Slowly', 1)",
    [gymId, dayId],
  ) as any;
  await db.query(
    "INSERT INTO member_nutrition_plan_meal_items (gym_id, meal_id, base_nutrition_library_item_id, component_type, quantity, unit, position) VALUES (?, ?, ?, 'main_dish', 150, 'g', 1)",
    [gymId, mealId, foodId],
  );
  await db.query(
    'INSERT INTO member_nutrition_plan_restrictions (gym_id, member_nutrition_plan_id, base_nutrition_library_item_id, applies_all_days, position) VALUES (?, ?, ?, 1, 1)',
    [gymId, planId, foodId],
  );
  await db.query(
    "INSERT INTO member_nutrition_plan_goals (gym_id, member_nutrition_plan_id, item_name, quantity, unit, frequency, applies_all_days, position) VALUES (?, ?, 'water', 2, 'l', 'daily', 1, 1)",
    [gymId, planId],
  );
  return planId;
}

async function planSnapshot(planId: number) {
  const res = await api.get(`/member-nutrition-plans/${planId}/hierarchy`);
  expect(res.status).toBe(200);
  const { rows } = await db.query('SELECT name, status, description, member_notes FROM member_nutrition_plans WHERE id = ?', [planId]);
  return { plan: rows[0], hierarchy: res.body };
}

beforeAll(async () => {
  gymId = await createTestGym('NPT Conversion Gym');
  otherGymId = await createTestGym('NPT Conversion Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  const { insertId } = await db.query(
    "INSERT INTO members (gym_id, name, email, created_by) VALUES (?, 'Conversion Member', ?, 'Test')",
    [gymId, `conversion-${Date.now()}@example.com`],
  ) as any;
  memberId = insertId;
  const { rows } = await db.query<{ id: number }>('SELECT id FROM base_nutrition_library_items LIMIT 1', []);
  foodId = rows[0].id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('convert to template', () => {
  it('creates a pending working copy carrying the plan content', async () => {
    const planId = await createPlan('Cut Plan');
    const res = await api.post(`/member-nutrition-plans/${planId}/convert-to-template`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      gym_id: gymId, name: 'Cut Plan', description: 'Plan description', member_notes: 'Drink water',
      status: 'draft', num_days: 1, cloned_from_id: null,
    });
    expect(res.body.conversion_pending_at).not.toBeNull();

    const tree = await api.get(`/nutrition-plan-templates/${res.body.id}/hierarchy`);
    expect(tree.status).toBe(200);
    expect(tree.body.days).toHaveLength(1);
    expect(tree.body.days[0].weekday).toBe(1);
    expect(tree.body.days[0].meals[0]).toMatchObject({ meal_type: 'breakfast', notes: 'Slowly' });
    expect(tree.body.days[0].meals[0].items[0]).toMatchObject({ nutrition_library_item_id: foodId, component_type: 'main_dish', unit: 'g' });
    expect(tree.body.restrictions).toHaveLength(1);
    expect(tree.body.goals[0]).toMatchObject({ item_name: 'water', unit: 'l', frequency: 'daily' });
  });

  it('is offered for a plan in any status, and names around a taken template name', async () => {
    const planId = await createPlan('Done Plan', 'completed');
    const first = await api.post(`/member-nutrition-plans/${planId}/convert-to-template`);
    expect(first.status).toBe(201);
    expect(first.body.name).toBe('Done Plan');
    const second = await api.post(`/member-nutrition-plans/${planId}/convert-to-template`);
    expect(second.body.name).toBe('Done Plan (Copy)');
    const draftPlan = await createPlan('Draft Plan', 'draft');
    expect((await api.post(`/member-nutrition-plans/${draftPlan}/convert-to-template`)).status).toBe(201);
  });

  it('Save makes it a created template and leaves the plan untouched', async () => {
    const planId = await createPlan('Save Plan');
    const before = await planSnapshot(planId);
    const conv = await api.post(`/member-nutrition-plans/${planId}/convert-to-template`);
    const tplId = conv.body.id;
    // Edited before saving, through the template's own routes.
    expect((await api.put(`/nutrition-plan-templates/${tplId}`).send({ name: 'Cut Template', status: 'active' })).status).toBe(200);
    const day = await api.post(`/nutrition-plan-templates/${tplId}/days`).send({ weekday: 3 });
    expect(day.status).toBe(201);

    const done = await api.post(`/nutrition-plan-templates/${tplId}/conversion/complete`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ name: 'Cut Template', status: 'active', conversion_pending_at: null });
    // Once saved it is an ordinary template: Cancel's hard delete no longer applies.
    expect((await api.del(`/nutrition-plan-templates/${tplId}/conversion`)).status).toBe(409);
    expect((await api.post(`/nutrition-plan-templates/${tplId}/conversion/complete`)).status).toBe(409);
    expect(await planSnapshot(planId)).toEqual(before);
  });

  it('Cancel hard-deletes the working copy and leaves the plan untouched', async () => {
    const planId = await createPlan('Cancel Plan');
    const before = await planSnapshot(planId);
    const conv = await api.post(`/member-nutrition-plans/${planId}/convert-to-template`);
    const tplId = conv.body.id;
    expect((await api.post(`/nutrition-plan-templates/${tplId}/edit-session`)).status).toBe(204);

    const res = await api.del(`/nutrition-plan-templates/${tplId}/conversion`);
    expect(res.status).toBe(204);
    const { rows } = await db.query('SELECT id FROM nutrition_plan_templates WHERE id = ?', [tplId]);
    expect(rows).toHaveLength(0);
    const { rows: days } = await db.query('SELECT id FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ?', [tplId]);
    expect(days).toHaveLength(0);
    expect(await planSnapshot(planId)).toEqual(before);
  });

  it('never hard-deletes a template that is not a pending conversion', async () => {
    const created = await api.post('/nutrition-plan-templates').send({ name: 'Ordinary Template' });
    expect((await api.del(`/nutrition-plan-templates/${created.body.id}/conversion`)).status).toBe(409);
    const { rows } = await db.query('SELECT id FROM nutrition_plan_templates WHERE id = ?', [created.body.id]);
    expect(rows).toHaveLength(1);
  });

  it('is tenant-isolated and requires auth', async () => {
    const planId = await createPlan('Isolated Plan');
    expect((await api.post(`/member-nutrition-plans/${planId}/convert-to-template`, otherGymId)).status).toBe(404);
    const conv = await api.post(`/member-nutrition-plans/${planId}/convert-to-template`);
    expect((await api.del(`/nutrition-plan-templates/${conv.body.id}/conversion`, otherGymId)).status).toBe(404);
    expect((await api.post(`/nutrition-plan-templates/${conv.body.id}/conversion/complete`, otherGymId)).status).toBe(404);
    expect((await request.post(`/member-nutrition-plans/${planId}/convert-to-template`).set('x-gym-id', gymId)).status).toBe(401);
  });
});
