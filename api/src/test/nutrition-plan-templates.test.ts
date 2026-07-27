// Tests for nutrition-plan-templates.ts router

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
// Seeded library item — global (no gym_id), cleaned up manually in afterAll.
let libraryItemId: number;

beforeAll(async () => {
  gymId = await createTestGym('NPT Test Gym');
  await createTestMembership(gymId, 'admin');

  const { insertId } = await db.query(
    "INSERT INTO nutrition_library_items (name, category) VALUES ('NPT Test Protein', 'main_dish')",
    [],
  );
  libraryItemId = insertId;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.query('DELETE FROM nutrition_library_items WHERE id = ?', [libraryItemId]);
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

    // Must not appear in the list
    const listRes = await request
      .get('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(listRes.body.items.find((t: any) => t.id === id)).toBeUndefined();

    // Must return 404 when fetched directly
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
      .send({ name: 'NPT Plan For Meals Tests' });
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

  it('adds a meal with a main_dish_id from nutrition_library_items', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Lunch With Protein', main_dish_id: libraryItemId });
    expect(res.status).toBe(201);
    expect(res.body.main_dish_id).toBe(libraryItemId);
    expect(res.body.main_dish_name).toBe('NPT Test Protein');
  });

  it('returns 400 when adding a meal without a name', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(400);
  });

  it('updates a meal with library FK fields', async () => {
    const addRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Dinner' });
    expect(addRes.status).toBe(201);
    const mealId = addRes.body.id;

    const res = await request
      .put(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${mealId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Updated Dinner', main_dish_id: libraryItemId });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Dinner');
    expect(res.body.main_dish_id).toBe(libraryItemId);
    expect(res.body.main_dish_name).toBe('NPT Test Protein');
  });

  it('deletes a meal', async () => {
    const addRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Meal To Delete NPT' });
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
      .send({ name: 'Meal Reorder A' });
    const m2 = await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Meal Reorder B' });

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
// Hierarchy — verify shape: { id, name, status, days, restrictions, goals }
// ---------------------------------------------------------------------------

describe('hierarchy', () => {
  it('returns template with days (meals with library names), restrictions, and goals', async () => {
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'NPT Hierarchy Test Plan' });
    expect(tplRes.status).toBe(201);
    const tplId = tplRes.body.id;

    // Add a day with a meal that references a library item
    const dayRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 6 });
    expect(dayRes.status).toBe(201);
    const dayId = dayRes.body.id;

    await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Dinner', main_dish_id: libraryItemId });

    // Add a restriction
    await request
      .post(`/nutrition-plan-templates/${tplId}/restrictions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, applies_all_days: 1 });

    // Add a goal
    await request
      .post(`/nutrition-plan-templates/${tplId}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ item_name: 'Protein', quantity: 150, unit: 'g', frequency: 'daily' });

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
    // Library FK columns must be present on the meal
    expect(hierRes.body.days[0].meals[0].main_dish_id).toBe(libraryItemId);
    expect(hierRes.body.days[0].meals[0].main_dish_name).toBe('NPT Test Protein');
    expect(Array.isArray(hierRes.body.restrictions)).toBe(true);
    expect(hierRes.body.restrictions).toHaveLength(1);
    expect(hierRes.body.restrictions[0].nutrition_library_item_id).toBe(libraryItemId);
    expect(Array.isArray(hierRes.body.goals)).toBe(true);
    expect(hierRes.body.goals).toHaveLength(1);
    expect(hierRes.body.goals[0].item_name).toBe('Protein');
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
    expect(res.body.item_name).toBe('NPT Test Protein');
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
// Goals
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

  it('posts a goal and returns 201', async () => {
    const res = await request
      .post(`/nutrition-plan-templates/${tplId}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ item_name: 'Protein', quantity: 150, unit: 'g', frequency: 'daily' });
    expect(res.status).toBe(201);
    expect(res.body.item_name).toBe('Protein');
    expect(Number(res.body.quantity)).toBe(150);
    expect(res.body.unit).toBe('g');
    expect(res.body.frequency).toBe('daily');
  });

  it('deletes a goal', async () => {
    const createRes = await request
      .post(`/nutrition-plan-templates/${tplId}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ item_name: 'Carbs', quantity: 200, unit: 'g' });
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
});

// ---------------------------------------------------------------------------
// Duplicate — deep copy including days, meals, restrictions, and goals
// ---------------------------------------------------------------------------

describe('duplicate', () => {
  it('creates a deep copy including days, meals, restrictions, and goals', async () => {
    // Create source template
    const tplRes = await request
      .post('/nutrition-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'NPT Source Plan For Duplication', status: 'active' });
    expect(tplRes.status).toBe(201);
    const tplId = tplRes.body.id;

    // Add day + meal with a library item
    const dayRes = await request
      .post(`/nutrition-plan-templates/${tplId}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 0 });
    const dayId = dayRes.body.id;

    await request
      .post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Breakfast', main_dish_id: libraryItemId });

    // Add restriction
    await request
      .post(`/nutrition-plan-templates/${tplId}/restrictions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, applies_all_days: 1 });

    // Add goal
    await request
      .post(`/nutrition-plan-templates/${tplId}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ item_name: 'Protein', quantity: 150, unit: 'g' });

    // Duplicate
    const dupRes = await request
      .post(`/nutrition-plan-templates/${tplId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dupRes.status).toBe(201);
    expect(dupRes.body.name).toContain('NPT Source Plan For Duplication');
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
    expect(hierRes.body.days[0].meals[0].main_dish_id).toBe(libraryItemId);
    expect(hierRes.body.restrictions).toHaveLength(1);
    expect(hierRes.body.restrictions[0].nutrition_library_item_id).toBe(libraryItemId);
    expect(hierRes.body.goals).toHaveLength(1);
    expect(hierRes.body.goals[0].item_name).toBe('Protein');
  });

  it('returns 404 when duplicating a non-existent template', async () => {
    const res = await request
      .post('/nutrition-plan-templates/non-existent/duplicate')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
