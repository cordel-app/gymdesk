// Tests for nutrition-plan-templates.ts router
// Schema: meals use display_name/meal_type/notes + meal_items junction table.
// Goals use a predefined item_name whitelist (lowercase).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
// Use an existing seeded library item rather than inserting to avoid dup-entry errors.
let libraryItemId: number;

beforeAll(async () => {
  gymId = await createTestGym('NPT Test Gym');
  await createTestMembership(gymId, 'admin');

  // Pick the first seeded global library item (migration 078 seeds 32 items).
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM nutrition_library_items LIMIT 1',
    [],
  );
  libraryItemId = rows[0].id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

describe('auth guard', () => {
  it('returns 401 without auth on GET /nutrition-plan-templates', async () => {
    const res = await request.get('/nutrition-plan-templates');
    expect(res.status).toBe(401);
  });

  it('returns 401 without auth on POST /nutrition-plan-templates', async () => {
    const res = await request.post('/nutrition-plan-templates').send({ name: 'X' });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('returns 403 on GET when user has no membership in this gym', async () => {
    const otherId = await createTestGym('NPT Other Gym');
    const res = await request
      .get('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherId);
    expect(res.status).toBe(403);
  });

  it('returns 404 when fetching a template that belongs to another gym', async () => {
    const gymA = await createTestGym('NPT Gym A');
    await createTestMembership(gymA, 'admin');
    const gymB = await createTestGym('NPT Gym B');
    await createTestMembership(gymB, 'admin');

    const createRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ name: 'Template In Gym A' });
    expect(createRes.status).toBe(201);
    const templateId = createRes.body.id;

    const res = await request
      .get(`/nutrition-plan-templates/${templateId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Role guard — accountant has NONE on NUTRITION
// ---------------------------------------------------------------------------

describe('role guard', () => {
  it('returns 403 when accountant tries to POST /nutrition-plan-templates', async () => {
    const accountantGymId = await createTestGym('NPT Accountant Gym');
    await createTestMembership(accountantGymId, 'accountant');

    const res = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', accountantGymId)
      .send({ name: 'Should Fail' });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// CRUD happy path
// ---------------------------------------------------------------------------

describe('nutrition plan templates CRUD', () => {
  let tplId: string;

  it('creates a template', async () => {
    const res = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'My Test Plan NPT', description: 'Test desc', status: 'active' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'My Test Plan NPT', status: 'active' });
    tplId = res.body.id;
  });

  it('lists templates with pagination envelope', async () => {
    const res = await request
      .get('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('gets a single template by id', async () => {
    const res = await request
      .get(`/nutrition-plan-templates/${tplId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(tplId);
  });

  it('returns 404 for a non-existent template', async () => {
    const res = await request
      .get('/nutrition-plan-templates/non-existent-id')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('updates a template', async () => {
    const res = await request
      .put(`/nutrition-plan-templates/${tplId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Updated NPT Plan Name' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated NPT Plan Name');
  });

  it('soft-deletes a template and hides it from list', async () => {
    const createRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'NPT Plan To Delete' });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id;

    const delRes = await request
      .delete(`/nutrition-plan-templates/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(delRes.status).toBe(204);

    const listRes = await request
      .get('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(listRes.body.items.find((t: any) => t.id === id)).toBeUndefined();

    const getRes = await request
      .get(`/nutrition-plan-templates/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(getRes.status).toBe(404);
  });

  it('returns 400 when creating a template without a name', async () => {
    const res = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ description: 'No name here' });
    expect(res.status).toBe(400);
  });

  it('returns created-by-options as an array', async () => {
    const res = await request
      .get('/nutrition-plan-templates/created-by-options')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

describe('days', () => {
  let tplId: string;

  beforeAll(async () => {
    const res = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'NPT Plan For Days Tests' });
    tplId = res.body.id;
  });

  it('adds a day to a template', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 1 });
    expect(res.status).toBe(201);
    expect(res.body.weekday).toBe(1);
  });

  it('returns 409 when adding the same weekday twice', async () => {
    const first = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 2 });
    expect(first.status).toBe(201);

    const second = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 2 });
    expect(second.status).toBe(409);
  });

  it('accepts weekday 7 (All Days) as valid', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 7 });
    expect(res.status).toBe(201);
    expect(res.body.weekday).toBe(7);
  });

  it('returns 400 for weekday 8 (out of valid range)', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 8 });
    expect(res.status).toBe(400);
  });

  it('deletes a day', async () => {
    const addRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 5 });
    expect(addRes.status).toBe(201);
    const dayId = addRes.body.id;

    const delRes = await request
      .delete(`/nutrition-plan-templates/${tplId}/days/${dayId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(delRes.status).toBe(204);
  });

  it('reorders days', async () => {
    const d3 = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 3 });
    const d4 = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 4 });

    const res = await request
      .put(`/nutrition-plan-templates/${tplId}/days/reorder`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ order: [d4.body.id, d3.body.id] });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Meals — use meal_type (required) + optional display_name / notes
// ---------------------------------------------------------------------------

describe('meals', () => {
  let tplId: string;
  let dayId: string;

  beforeAll(async () => {
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'NPT Plan For Meals Tests' });
    tplId = tplRes.body.id;

    const dayRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 0 });
    dayId = dayRes.body.id;
  });

  it('adds a meal with meal_type and returns display_name + empty items[]', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'breakfast' });
    expect(res.status).toBe(201);
    expect(res.body.meal_type).toBe('breakfast');
    expect(res.body.display_name).toBe('breakfast'); // defaults to meal_type
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('respects an explicit display_name', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'lunch', display_name: 'Power Lunch' });
    expect(res.status).toBe(201);
    expect(res.body.display_name).toBe('Power Lunch');
  });

  it('returns 400 when meal_type is missing', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when meal_type is invalid', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'brunch' });
    expect(res.status).toBe(400);
  });

  it('updates a meal display_name and notes', async () => {
    const addRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'dinner' });
    expect(addRes.status).toBe(201);
    const mealId = addRes.body.id;

    const res = await request
      .put(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ display_name: 'Updated Dinner', notes: 'Avoid carbs' });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Updated Dinner');
    expect(res.body.notes).toBe('Avoid carbs');
  });

  it('deletes a meal', async () => {
    const addRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'snack' });
    expect(addRes.status).toBe(201);

    const res = await request
      .delete(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${addRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('reorders meals', async () => {
    const m1 = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'recien_levantado' });
    const m2 = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'antes_de_dormir' });

    const res = await request
      .put(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/reorder`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ order: [m2.body.id, m1.body.id] });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Meal Items — junction table for ingredients per meal
// ---------------------------------------------------------------------------

describe('meal items', () => {
  let tplId: string;
  let dayId: string;
  let mealId: string;

  beforeAll(async () => {
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'NPT Plan For Meal Items Tests' });
    tplId = tplRes.body.id;

    const dayRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 0 });
    dayId = dayRes.body.id;

    const mealRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'lunch' });
    mealId = mealRes.body.id;
  });

  it('adds a meal item and returns 201 with item_name', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}/items`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, component_type: 'main_dish', quantity: 200, unit: 'g' });
    expect(res.status).toBe(201);
    expect(res.body.nutrition_library_item_id).toBe(libraryItemId);
    expect(res.body.component_type).toBe('main_dish');
    expect(Number(res.body.quantity)).toBe(200);
    expect(res.body.unit).toBe('g');
    expect(typeof res.body.item_name).toBe('string');
  });

  it('lists items for a meal', async () => {
    const res = await request
      .get(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}/items`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('updates a meal item', async () => {
    const addRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}/items`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, component_type: 'side', quantity: 100, unit: 'g' });
    expect(addRes.status).toBe(201);
    const itemId = addRes.body.id;

    const res = await request
      .put(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}/items/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ quantity: 150, unit: 'ml' });
    expect(res.status).toBe(200);
    expect(Number(res.body.quantity)).toBe(150);
    expect(res.body.unit).toBe('ml');
  });

  it('deletes a meal item', async () => {
    const addRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}/items`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, component_type: 'sauce' });
    expect(addRes.status).toBe(201);

    const delRes = await request
      .delete(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}/items/${addRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(delRes.status).toBe(204);
  });

  it('returns 400 when nutrition_library_item_id is missing', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}/items`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ component_type: 'main_dish' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when component_type is invalid', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}/items`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, component_type: 'drink' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for item from a different meal', async () => {
    const otherMealRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'dinner' });
    const otherMealId = otherMealRes.body.id;

    const addRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}/items`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, component_type: 'main_dish' });
    expect(addRes.status).toBe(201);
    const itemId = addRes.body.id;

    const res = await request
      .delete(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${otherMealId}/items/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Hierarchy — meals now carry items[] instead of FK columns
// ---------------------------------------------------------------------------

describe('hierarchy', () => {
  it('returns days with meals.items[] and restrictions and goals', async () => {
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'NPT Hierarchy Test Plan' });
    expect(tplRes.status).toBe(201);
    const tplId = tplRes.body.id;

    const dayRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 6 });
    const dayId = dayRes.body.id;

    const mealRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'dinner', display_name: 'Dinner', notes: 'Light meal' });
    const mealId = mealRes.body.id;

    await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}/items`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, component_type: 'main_dish', quantity: 200, unit: 'g' });

    await request
      .post(`/nutrition-plan-templates/${tplId}/restrictions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, applies_all_days: 1 });

    await request
      .post(`/nutrition-plan-templates/${tplId}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ item_name: 'protein', quantity: 150, unit: 'g', frequency: 'daily' });

    const hierRes = await request
      .get(`/nutrition-plan-templates/${tplId}/hierarchy`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(hierRes.status).toBe(200);
    expect(hierRes.body.id).toBe(tplId);
    expect(Array.isArray(hierRes.body.days)).toBe(true);
    expect(hierRes.body.days).toHaveLength(1);

    const meal = hierRes.body.days[0].meals[0];
    expect(meal.display_name).toBe('Dinner');
    expect(meal.meal_type).toBe('dinner');
    expect(meal.notes).toBe('Light meal');
    expect(Array.isArray(meal.items)).toBe(true);
    expect(meal.items).toHaveLength(1);
    expect(meal.items[0].nutrition_library_item_id).toBe(libraryItemId);
    expect(meal.items[0].component_type).toBe('main_dish');
    expect(Number(meal.items[0].quantity)).toBe(200);

    expect(Array.isArray(hierRes.body.restrictions)).toBe(true);
    expect(hierRes.body.restrictions).toHaveLength(1);
    expect(hierRes.body.restrictions[0].nutrition_library_item_id).toBe(libraryItemId);

    expect(Array.isArray(hierRes.body.goals)).toBe(true);
    expect(hierRes.body.goals).toHaveLength(1);
    expect(hierRes.body.goals[0].item_name).toBe('protein');
  });

  it('returns 404 for a non-existent template', async () => {
    const res = await request
      .get('/nutrition-plan-templates/non-existent/hierarchy')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Restrictions
// ---------------------------------------------------------------------------

describe('restrictions', () => {
  let tplId: string;

  beforeAll(async () => {
    const res = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'NPT Plan For Restrictions Tests' });
    tplId = res.body.id;
  });

  it('posts a restriction and returns 201 with item_name', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/restrictions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, applies_all_days: 0 });
    expect(res.status).toBe(201);
    expect(res.body.nutrition_library_item_id).toBe(libraryItemId);
    expect(typeof res.body.item_name).toBe('string');
  });

  it('deletes a restriction', async () => {
    const createRes = await request
      .post(`/nutrition-plan-templates/${tplId}/restrictions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, applies_all_days: 1 });
    expect(createRes.status).toBe(201);
    const rid = createRes.body.id;

    const delRes = await request
      .delete(`/nutrition-plan-templates/${tplId}/restrictions/${rid}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(delRes.status).toBe(204);
  });

  it('returns 400 when nutrition_library_item_id is missing', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/restrictions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ applies_all_days: 1 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Goals — item_name must be from the predefined whitelist (lowercase)
// ---------------------------------------------------------------------------

describe('goals', () => {
  let tplId: string;

  beforeAll(async () => {
    const res = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'NPT Plan For Goals Tests' });
    tplId = res.body.id;
  });

  it('posts a goal with valid item_name and returns 201', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ item_name: 'protein', quantity: 150, unit: 'g', frequency: 'daily' });
    expect(res.status).toBe(201);
    expect(res.body.item_name).toBe('protein');
    expect(Number(res.body.quantity)).toBe(150);
    expect(res.body.unit).toBe('g');
    expect(res.body.frequency).toBe('daily');
  });

  it('deletes a goal', async () => {
    const createRes = await request
      .post(`/nutrition-plan-templates/${tplId}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ item_name: 'carbohydrates', quantity: 200, unit: 'g' });
    expect(createRes.status).toBe(201);
    const gid = createRes.body.id;

    const delRes = await request
      .delete(`/nutrition-plan-templates/${tplId}/goals/${gid}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(delRes.status).toBe(204);
  });

  it('returns 400 when item_name is missing', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ quantity: 100, unit: 'g' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when item_name is not in the whitelist', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ item_name: 'sugar', quantity: 50, unit: 'g' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when quantity is missing', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ item_name: 'calories', unit: 'kcal' });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Duplicate — deep copy including days, meals (with items), restrictions, goals
// ---------------------------------------------------------------------------

describe('duplicate', () => {
  it('creates a deep copy including days, meals with items, restrictions, and goals', async () => {
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'NPT Source Plan For Duplication', status: 'active' });
    expect(tplRes.status).toBe(201);
    const tplId = tplRes.body.id;

    const dayRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 0 });
    const dayId = dayRes.body.id;

    const mealRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'breakfast', display_name: 'Morning Meal' });
    const mealId = mealRes.body.id;

    await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}/items`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, component_type: 'main_dish', quantity: 150, unit: 'g' });

    await request
      .post(`/nutrition-plan-templates/${tplId}/restrictions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, applies_all_days: 1 });

    await request
      .post(`/nutrition-plan-templates/${tplId}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ item_name: 'protein', quantity: 150, unit: 'g' });

    const dupRes = await request
      .post(`/nutrition-plan-templates/${tplId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dupRes.status).toBe(201);
    expect(dupRes.body.name).toContain('NPT Source Plan For Duplication');
    expect(dupRes.body.name).toContain('Copy');
    expect(Number(dupRes.body.day_count)).toBe(1);

    const hierRes = await request
      .get(`/nutrition-plan-templates/${dupRes.body.id}/hierarchy`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(hierRes.status).toBe(200);
    expect(hierRes.body.days).toHaveLength(1);
    expect(hierRes.body.days[0].meals).toHaveLength(1);

    const meal = hierRes.body.days[0].meals[0];
    expect(meal.display_name).toBe('Morning Meal');
    expect(meal.meal_type).toBe('breakfast');
    expect(Array.isArray(meal.items)).toBe(true);
    expect(meal.items).toHaveLength(1);
    expect(meal.items[0].nutrition_library_item_id).toBe(libraryItemId);

    expect(hierRes.body.restrictions).toHaveLength(1);
    expect(hierRes.body.goals).toHaveLength(1);
    expect(hierRes.body.goals[0].item_name).toBe('protein');
  });

  it('returns 404 when duplicating a non-existent template', async () => {
    const res = await request
      .post('/nutrition-plan-templates/non-existent/duplicate')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Type filter — ?type=base and ?type=gym
// ---------------------------------------------------------------------------

describe('type filter', () => {
  let baseTemplateId: number;

  beforeAll(async () => {
    // Insert a global base template (gym_id IS NULL) directly.
    const { insertId } = await db.query(
      "INSERT INTO nutrition_plan_templates (gym_id, name, status) VALUES (NULL, 'NPT Base Template Type Filter', 'active')",
      [],
    );
    baseTemplateId = insertId;
  });

  afterAll(async () => {
    // Base templates have gym_id IS NULL so cleanupTestGyms won't remove them.
    await db.query('DELETE FROM nutrition_plan_templates WHERE id = ?', [baseTemplateId]);
  });

  it('?type=base returns only base templates (owner_type=base)', async () => {
    const res = await request
      .get('/nutrition-plan-templates?type=base')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    const found = res.body.items.find((t: any) => t.id === baseTemplateId);
    expect(found).toBeDefined();
    for (const item of res.body.items) {
      expect(item.owner_type).toBe('base');
    }
  });

  it('?type=base excludes gym-owned templates', async () => {
    // Create a gym-owned template
    const createRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `NPT Gym Owned For TypeFilter ${Date.now()}` });
    expect(createRes.status).toBe(201);
    const gymOwnedId = createRes.body.id;

    const res = await request
      .get('/nutrition-plan-templates?type=base')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const found = res.body.items.find((t: any) => t.id === gymOwnedId);
    expect(found).toBeUndefined();
  });

  it('?type=gym returns only gym-owned templates (owner_type=gym)', async () => {
    const res = await request
      .get('/nutrition-plan-templates?type=gym')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    const found = res.body.items.find((t: any) => t.id === baseTemplateId);
    expect(found).toBeUndefined();
    for (const item of res.body.items) {
      expect(item.owner_type).toBe('gym');
    }
  });

  it('default list (no ?type) includes both base and gym-owned templates', async () => {
    const res = await request
      .get('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ownerTypes = res.body.items.map((t: any) => t.owner_type);
    expect(ownerTypes).toContain('base');
    expect(ownerTypes).toContain('gym');
  });
});

// ---------------------------------------------------------------------------
// Clone — deep-copies a base or gym-owned template into a new gym-owned copy
// ---------------------------------------------------------------------------

describe('clone', () => {
  let baseTemplateId: number;

  beforeAll(async () => {
    // Insert a global base template with a day so the deep copy is exercised.
    const { insertId } = await db.query(
      "INSERT INTO nutrition_plan_templates (gym_id, name, status) VALUES (NULL, 'NPT Clone Source Base', 'active')",
      [],
    );
    baseTemplateId = insertId;
    await db.query(
      'INSERT INTO nutrition_plan_template_days (gym_id, nutrition_plan_template_id, weekday, position) VALUES (NULL, ?, 1, 0)',
      [baseTemplateId],
    );
  });

  afterAll(async () => {
    await db.query('DELETE FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ?', [baseTemplateId]);
    await db.query('DELETE FROM nutrition_plan_templates WHERE id = ?', [baseTemplateId]);
  });

  it('clones a gym-owned template into a new gym-owned copy with cloned_from_id set', async () => {
    const createRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `NPT Clone Source Gym ${Date.now()}` });
    expect(createRes.status).toBe(201);
    const sourceId = createRes.body.id;

    const cloneRes = await request
      .post(`/nutrition-plan-templates/${sourceId}/clone`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(cloneRes.status).toBe(201);
    expect(cloneRes.body.name).toContain('Copy');
    expect(cloneRes.body.owner_type).toBe('gym');
    expect(Number(cloneRes.body.cloned_from_id)).toBe(Number(sourceId));
  });

  it('clones a base template into a gym-owned copy with cloned_from_id set', async () => {
    const cloneRes = await request
      .post(`/nutrition-plan-templates/${baseTemplateId}/clone`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(cloneRes.status).toBe(201);
    expect(cloneRes.body.owner_type).toBe('gym');
    expect(Number(cloneRes.body.cloned_from_id)).toBe(baseTemplateId);
  });

  it('accepts an explicit name for the cloned template', async () => {
    const createRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `NPT Clone Named Source ${Date.now()}` });
    expect(createRes.status).toBe(201);

    const explicitName = `NPT Explicit Clone Name ${Date.now()}`;
    const cloneRes = await request
      .post(`/nutrition-plan-templates/${createRes.body.id}/clone`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: explicitName });
    expect(cloneRes.status).toBe(201);
    expect(cloneRes.body.name).toBe(explicitName);
  });

  it('returns 404 when cloning a non-existent template', async () => {
    const res = await request
      .post('/nutrition-plan-templates/non-existent/clone')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 409 when the cloned default name conflicts with an existing gym template', async () => {
    const sourceName = `NPT Conflict Source ${Date.now()}`;
    const createRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: sourceName });
    expect(createRes.status).toBe(201);
    const sourceId = createRes.body.id;

    // First clone creates "<sourceName> (Copy)"
    const firstClone = await request
      .post(`/nutrition-plan-templates/${sourceId}/clone`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(firstClone.status).toBe(201);

    // Second clone with same default name → 409
    const secondClone = await request
      .post(`/nutrition-plan-templates/${sourceId}/clone`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(secondClone.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Assign — deep-clones a template into a member_nutrition_plans row
// ---------------------------------------------------------------------------

describe('assign', () => {
  let testMemberId: number;

  beforeAll(async () => {
    const { insertId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'NPT Assign Member', ?)`,
      [gymId, `npt-assign-${Date.now()}@test.com`],
    );
    testMemberId = insertId;
  });

  it('assigns a template to a member and returns 201 with the new member_nutrition_plan', async () => {
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `NPT Assign Test ${Date.now()}` });
    expect(tplRes.status).toBe(201);

    const assignRes = await request
      .post(`/nutrition-plan-templates/${tplRes.body.id}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: testMemberId });
    expect(assignRes.status).toBe(201);
    expect(Number(assignRes.body.member_id)).toBe(testMemberId);
    expect(Number(assignRes.body.template_id)).toBe(Number(tplRes.body.id));
    expect(assignRes.body.status).toBe('active');
  });

  it('deep-copies template days into the member plan', async () => {
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `NPT Assign Days Test ${Date.now()}` });
    expect(tplRes.status).toBe(201);
    const tplId = tplRes.body.id;

    await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 1 });

    const assignRes = await request
      .post(`/nutrition-plan-templates/${tplId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: testMemberId });
    expect(assignRes.status).toBe(201);

    // Verify the day was copied into the member plan
    const { rows } = await db.query(
      'SELECT * FROM member_nutrition_plan_days WHERE member_nutrition_plan_id = ?',
      [assignRes.body.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].weekday).toBe(1);
  });

  it('accepts an optional start_date', async () => {
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `NPT Assign StartDate ${Date.now()}` });
    expect(tplRes.status).toBe(201);

    const assignRes = await request
      .post(`/nutrition-plan-templates/${tplRes.body.id}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: testMemberId, start_date: '2026-01-01' });
    expect(assignRes.status).toBe(201);
    expect(assignRes.body.start_date).toBeTruthy();
  });

  it('returns 400 when member_id is missing', async () => {
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `NPT Assign NoMember ${Date.now()}` });
    expect(tplRes.status).toBe(201);

    const res = await request
      .post(`/nutrition-plan-templates/${tplRes.body.id}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when member_id does not belong to this gym', async () => {
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `NPT Assign WrongMember ${Date.now()}` });
    expect(tplRes.status).toBe(201);

    const res = await request
      .post(`/nutrition-plan-templates/${tplRes.body.id}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: 999999 });
    expect(res.status).toBe(404);
  });

  it('returns 404 when template does not exist', async () => {
    const res = await request
      .post('/nutrition-plan-templates/non-existent/assign')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: testMemberId });
    expect(res.status).toBe(404);
  });
});
