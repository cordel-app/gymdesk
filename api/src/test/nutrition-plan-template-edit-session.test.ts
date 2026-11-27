// #3482: Cancel discards every change of a Nutrition Plan Template's edit session.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let foodId: number;

const as = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });
const api = {
  post: (path: string, gym = gymId) => request.post(path).set(as(gym)),
  put: (path: string, gym = gymId) => request.put(path).set(as(gym)),
  del: (path: string, gym = gymId) => request.delete(path).set(as(gym)),
  get: (path: string, gym = gymId) => request.get(path).set(as(gym)),
};

async function createTemplate(name: string): Promise<number> {
  const res = await api.post('/nutrition-plan-templates').send({ name });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** The content as a comparable shape, ids left out (a restore re-inserts rows). */
async function content(tplId: number) {
  const res = await api.get(`/nutrition-plan-templates/${tplId}/hierarchy`);
  expect(res.status).toBe(200);
  return {
    days: res.body.days.map((d: any) => ({
      weekday: d.weekday,
      meals: d.meals.map((m: any) => ({
        meal_type: m.meal_type,
        notes: m.notes ?? null,
        items: m.items.map((i: any) => ({ component_type: i.component_type, quantity: Number(i.quantity), unit: i.unit })),
      })),
    })),
    restrictions: res.body.restrictions.length,
    goals: res.body.goals.map((g: any) => ({ item_name: g.item_name, quantity: Number(g.quantity) })),
  };
}

beforeAll(async () => {
  gymId = await createTestGym('NPT Edit Session Gym');
  await createTestMembership(gymId, 'admin');
  const { rows } = await db.query<{ id: number }>('SELECT id FROM base_nutrition_library_items LIMIT 1', []);
  foodId = rows[0].id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('edit session', () => {
  it('Cancel restores the content exactly as it was when Edit mode was entered', async () => {
    const tplId = await createTemplate('Edit Session Cancel');
    const day = await api.post(`/nutrition-plan-templates/${tplId}/days`).send({ weekday: 1 });
    const meal = await api.post(`/nutrition-plan-templates/${tplId}/days/${day.body.id}/meals`).send({ meal_type: 'breakfast' });
    const mealBase = `/nutrition-plan-templates/${tplId}/days/${day.body.id}/meals/${meal.body.id}`;
    await api.put(mealBase).send({ notes: 'Original notes' });
    await api.post(`${mealBase}/items`).send({ nutrition_library_item_id: foodId, component_type: 'main_dish', quantity: 200, unit: 'g' });
    await api.post(`/nutrition-plan-templates/${tplId}/restrictions`).send({ nutrition_library_item_id: foodId, applies_all_days: 1 });
    const goal = await api.post(`/nutrition-plan-templates/${tplId}/goals`).send({ item_name: 'protein', quantity: 150, unit: 'g', frequency: 'daily' });
    const before = await content(tplId);

    expect((await api.post(`/nutrition-plan-templates/${tplId}/edit-session`)).status).toBe(204);

    // Every kind of change: an edit, additions and removals.
    await api.put(mealBase).send({ notes: 'Changed notes' });
    await api.post(`/nutrition-plan-templates/${tplId}/days`).send({ weekday: 3 });
    await api.put(`/nutrition-plan-templates/${tplId}/goals/${goal.body.id}`).send({ quantity: 999 });
    const { rows: restrictions } = await db.query<{ id: number }>(
      'SELECT id FROM nutrition_plan_template_restrictions WHERE nutrition_plan_template_id = ?', [tplId]);
    await api.del(`/nutrition-plan-templates/${tplId}/restrictions/${restrictions[0].id}`);
    expect(await content(tplId)).not.toEqual(before);

    expect((await api.post(`/nutrition-plan-templates/${tplId}/edit-session/cancel`)).status).toBe(204);
    expect(await content(tplId)).toEqual(before);

    // The checkpoint is gone: a second Cancel has nothing to undo.
    const again = await api.post(`/nutrition-plan-templates/${tplId}/edit-session/cancel`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('no_edit_session');
  });

  it('Save keeps the changes and drops the checkpoint', async () => {
    const tplId = await createTemplate('Edit Session Save');
    await api.post(`/nutrition-plan-templates/${tplId}/edit-session`);
    await api.post(`/nutrition-plan-templates/${tplId}/days`).send({ weekday: 2 });
    expect((await api.del(`/nutrition-plan-templates/${tplId}/edit-session`)).status).toBe(204);

    const cancel = await api.post(`/nutrition-plan-templates/${tplId}/edit-session/cancel`);
    expect(cancel.status).toBe(409);
    expect((await content(tplId)).days).toHaveLength(1);
  });

  it('re-entering Edit mode replaces the checkpoint', async () => {
    const tplId = await createTemplate('Edit Session Reentry');
    await api.post(`/nutrition-plan-templates/${tplId}/edit-session`);
    await api.post(`/nutrition-plan-templates/${tplId}/days`).send({ weekday: 4 });
    await api.post(`/nutrition-plan-templates/${tplId}/edit-session`);
    await api.post(`/nutrition-plan-templates/${tplId}/days`).send({ weekday: 5 });
    await api.post(`/nutrition-plan-templates/${tplId}/edit-session/cancel`);
    expect((await content(tplId)).days.map((d: any) => d.weekday)).toEqual([4]);
  });

  it('is tenant-scoped and needs write access', async () => {
    const tplId = await createTemplate('Edit Session Tenant');
    const otherGym = await createTestGym('NPT Edit Session Other');
    await createTestMembership(otherGym, 'admin');
    expect((await api.post(`/nutrition-plan-templates/${tplId}/edit-session`, otherGym)).status).toBe(404);
    expect((await api.post(`/nutrition-plan-templates/${tplId}/edit-session/cancel`, otherGym)).status).toBe(404);
    expect((await api.del(`/nutrition-plan-templates/${tplId}/edit-session`, otherGym)).status).toBe(404);

    const accountantGym = await createTestGym('NPT Edit Session Accountant');
    await createTestMembership(accountantGym, 'accountant');
    expect((await api.post(`/nutrition-plan-templates/${tplId}/edit-session`, accountantGym)).status).toBe(403);

    expect((await request.post(`/nutrition-plan-templates/${tplId}/edit-session`)).status).toBe(401);
  });
});
