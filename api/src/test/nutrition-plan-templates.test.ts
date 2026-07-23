// Tests for nutrition-plan-templates.ts and meals-catalog.ts routers

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

beforeAll(async () => {
  gymId = await createTestGym();
  await createTestMembership(gymId, 'admin');
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

  it('returns 401 without auth on GET /dishes', async () => {
    const res = await request.get('/dishes');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('returns 403 on GET /nutrition-plan-templates when user has no membership in this gym', async () => {
    const otherId = await createTestGym('Other Gym Nutrition');
    const res = await request
      .get('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherId);
    expect(res.status).toBe(403);
  });

  it('returns 404 when fetching a template that belongs to another gym', async () => {
    const gymA = await createTestGym('Gym A Nutrition');
    await createTestMembership(gymA, 'admin');
    const gymB = await createTestGym('Gym B Nutrition');
    await createTestMembership(gymB, 'admin');

    // Create template in gymA
    const createRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ name: 'Template In Gym A' });
    expect(createRes.status).toBe(201);
    const templateId = createRes.body.id;

    // Access with gymB's x-gym-id
    const res = await request
      .get(`/nutrition-plan-templates/${templateId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Role guard
// ---------------------------------------------------------------------------

describe('role guard', () => {
  it('returns 403 when a member tries to create a template', async () => {
    const memberGymId = await createTestGym('Member Role Gym Nutrition');
    await createTestMembership(memberGymId, 'member');

    const res = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', memberGymId)
      .send({ name: 'Should Fail' });
    expect(res.status).toBe(403);
  });

  it('returns 403 when a member tries to create a dish', async () => {
    const memberGymId = await createTestGym('Member Role Gym Dishes');
    await createTestMembership(memberGymId, 'member');

    const res = await request
      .post('/dishes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', memberGymId)
      .send({ name: 'Forbidden Dish' });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Dishes (meals catalog) — happy path and FK constraint
// ---------------------------------------------------------------------------

describe('dishes catalog', () => {
  it('creates a dish', async () => {
    const res = await request
      .post('/dishes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Grilled Chicken', calories: 300, protein: 40 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Grilled Chicken');
    expect(parseFloat(res.body.calories)).toBe(300); // MySQL DECIMAL returns as string
  });

  it('soft-deletes a dish (204) even when it is referenced by a template', async () => {
    // Create dish
    const dishRes = await request
      .post('/dishes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Protected Dish' });
    expect(dishRes.status).toBe(201);
    const dishId = dishRes.body.id;

    // Create template
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Template For Dish FK Test' });
    expect(tplRes.status).toBe(201);
    const tplId = tplRes.body.id;

    // Add day
    const dayRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 0 });
    expect(dayRes.status).toBe(201);
    const dayId = dayRes.body.id;

    // Add meal
    const mealRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Lunch' });
    expect(mealRes.status).toBe(201);
    const mealId = mealRes.body.id;

    // Add dish to meal
    const addDishRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}/dishes`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ dish_id: dishId });
    expect(addDishRes.status).toBe(201);

    // Soft-delete the dish — succeeds even when referenced (data is kept, just marked deleted)
    const deleteRes = await request
      .delete(`/dishes/${dishId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(deleteRes.status).toBe(204);
  });

  it('lists dishes', async () => {
    const res = await request
      .get('/dishes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('updates a dish', async () => {
    const createRes = await request
      .post('/dishes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Updatable Dish' });
    expect(createRes.status).toBe(201);
    const dishId = createRes.body.id;

    const res = await request
      .put(`/dishes/${dishId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Updated Dish Name', calories: 500 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Dish Name');
  });

  it('deletes a dish that is not referenced', async () => {
    const createRes = await request
      .post('/dishes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Deletable Dish' });
    expect(createRes.status).toBe(201);
    const dishId = createRes.body.id;

    const res = await request
      .delete(`/dishes/${dishId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Sides catalog
// ---------------------------------------------------------------------------

describe('sides catalog', () => {
  it('creates a side', async () => {
    const res = await request
      .post('/sides')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Brown Rice' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Brown Rice');
  });

  it('lists sides', async () => {
    const res = await request
      .get('/sides')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('deletes a side', async () => {
    const createRes = await request
      .post('/sides')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Quinoa To Delete' });
    expect(createRes.status).toBe(201);

    const res = await request
      .delete(`/sides/${createRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Sauces catalog
// ---------------------------------------------------------------------------

describe('sauces catalog', () => {
  it('creates a sauce', async () => {
    const res = await request
      .post('/sauces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Tomato Sauce' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Tomato Sauce');
  });

  it('lists sauces', async () => {
    const res = await request
      .get('/sauces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('deletes a sauce', async () => {
    const createRes = await request
      .post('/sauces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Sauce To Delete' });
    expect(createRes.status).toBe(201);

    const res = await request
      .delete(`/sauces/${createRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Nutrition plan templates — CRUD happy path
// ---------------------------------------------------------------------------

describe('nutrition plan templates CRUD', () => {
  let tplId: string;

  it('creates a template', async () => {
    const res = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'My Test Plan', description: 'Test desc', status: 'active' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'My Test Plan', status: 'active' });
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
      .send({ name: 'Updated Plan Name' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Plan Name');
  });

  it('soft-deletes a template and hides it from list', async () => {
    const createRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Plan To Delete' });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id;

    const delRes = await request
      .delete(`/nutrition-plan-templates/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(delRes.status).toBe(204);

    // Should not appear in list
    const listRes = await request
      .get('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(listRes.body.items.find((t: any) => t.id === id)).toBeUndefined();

    // Should return 404 when fetched directly
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
      .send({ name: 'Plan For Days Tests' });
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
    // Weekday 2 first time
    const first = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 2 });
    expect(first.status).toBe(201);

    // Weekday 2 second time
    const second = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 2 });
    expect(second.status).toBe(409);
  });

  it('returns 400 for invalid weekday', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 7 });
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
    // Ensure at least two days exist (weekdays 3 and 4)
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
// Meals
// ---------------------------------------------------------------------------

describe('meals', () => {
  let tplId: string;
  let dayId: string;

  beforeAll(async () => {
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Plan For Meals Tests' });
    tplId = tplRes.body.id;

    const dayRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 0 });
    dayId = dayRes.body.id;
  });

  it('adds a meal to a day', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Breakfast' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Breakfast');
  });

  it('returns 400 when adding a meal without a name', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(400);
  });

  it('deletes a meal', async () => {
    const addRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Meal To Delete' });
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
      .send({ name: 'Meal Reorder 1' });
    const m2 = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Meal Reorder 2' });

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
// Full happy path: create template → add day → add meal → add dish → fetch hierarchy
// ---------------------------------------------------------------------------

describe('full hierarchy happy path', () => {
  it('builds a template hierarchy and returns it correctly', async () => {
    // Create dish
    const dishRes = await request
      .post('/dishes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Hierarchy Test Dish', calories: 200, protein: 25 });
    expect(dishRes.status).toBe(201);
    const dishId = dishRes.body.id;

    // Create template
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Hierarchy Test Plan' });
    expect(tplRes.status).toBe(201);
    const tplId = tplRes.body.id;

    // Add day
    const dayRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 6 });
    expect(dayRes.status).toBe(201);
    const dayId = dayRes.body.id;

    // Add meal
    const mealRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Dinner' });
    expect(mealRes.status).toBe(201);
    const mealId = mealRes.body.id;

    // Add dish to meal
    const addDishRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}/dishes`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ dish_id: dishId });
    expect(addDishRes.status).toBe(201);
    expect(addDishRes.body.dish_name).toBe('Hierarchy Test Dish');

    // Fetch hierarchy
    const hierRes = await request
      .get(`/nutrition-plan-templates/${tplId}/hierarchy`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(hierRes.status).toBe(200);
    expect(hierRes.body.id).toBe(tplId);
    expect(Array.isArray(hierRes.body.days)).toBe(true);
    expect(hierRes.body.days).toHaveLength(1);
    expect(Array.isArray(hierRes.body.days[0].meals)).toBe(true);
    expect(hierRes.body.days[0].meals).toHaveLength(1);
    expect(Array.isArray(hierRes.body.days[0].meals[0].dishes)).toBe(true);
    expect(hierRes.body.days[0].meals[0].dishes).toHaveLength(1);
    expect(hierRes.body.days[0].meals[0].dishes[0].dish_name).toBe('Hierarchy Test Dish');
  });
});

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

describe('duplicate', () => {
  it('creates a deep copy of a template including days, meals, and dishes', async () => {
    // Create a dish to use
    const dishRes = await request
      .post('/dishes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Duplicate Test Dish' });
    expect(dishRes.status).toBe(201);
    const dishId = dishRes.body.id;

    // Create source template
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Source Plan For Duplication' });
    expect(tplRes.status).toBe(201);
    const tplId = tplRes.body.id;

    // Add day, meal, dish
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
      .send({ name: 'Breakfast' });
    const mealId = mealRes.body.id;

    await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}/dishes`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ dish_id: dishId });

    // Duplicate
    const dupRes = await request
      .post(`/nutrition-plan-templates/${tplId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dupRes.status).toBe(201);
    expect(dupRes.body.name).toContain('Source Plan For Duplication');
    expect(dupRes.body.name).toContain('Copy');
    expect(Number(dupRes.body.day_count)).toBe(1);

    // Verify deep copy via hierarchy
    const hierRes = await request
      .get(`/nutrition-plan-templates/${dupRes.body.id}/hierarchy`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(hierRes.status).toBe(200);
    expect(hierRes.body.days).toHaveLength(1);
    expect(hierRes.body.days[0].meals).toHaveLength(1);
    expect(hierRes.body.days[0].meals[0].dishes).toHaveLength(1);
  });

  it('returns 404 when duplicating a non-existent template', async () => {
    const res = await request
      .post('/nutrition-plan-templates/non-existent/duplicate')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
