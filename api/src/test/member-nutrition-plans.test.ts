// Tests for member-nutrition-plans.ts router

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
let memberId: number;
// Use an existing seeded library item rather than inserting to avoid dup-entry errors.
let libraryItemId: number;

beforeAll(async () => {
  gymId = await createTestGym('MNP Test Gym');
  await createTestMembership(gymId, 'admin');

  // Insert a test member so assign endpoint has a valid target.
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'MNP Test Member', ?)`,
    [gymId, `mnp-member-${Date.now()}@test.com`],
  );
  memberId = insertId;

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

// Helper: create a template and assign it to memberId, returns the created plan body.
async function createTestPlan(): Promise<any> {
  const tplRes = await request
    .post('/nutrition-plan-templates')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ name: `MNP Plan ${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  expect(tplRes.status).toBe(201);

  const assignRes = await request
    .post(`/nutrition-plan-templates/${tplRes.body.id}/assign`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ member_id: memberId });
  expect(assignRes.status).toBe(201);
  return assignRes.body;
}

// Helper: create a template (no assignment) in the given gym, returns the created template body.
async function createTestTemplate(targetGymId = gymId): Promise<any> {
  const res = await request
    .post('/nutrition-plan-templates')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', targetGymId)
    .send({ name: `MNP Template ${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  expect(res.status).toBe(201);
  return res.body;
}

// Helper: create a template with a full hierarchy (1 day, 1 meal with 1 item,
// 1 restriction, 1 goal) so cloning via POST /member-nutrition-plans can be
// verified against known counts.
async function createTestTemplateWithHierarchy(): Promise<any> {
  const tpl = await createTestTemplate();

  const dayRes = await request
    .post(`/nutrition-plan-templates/${tpl.id}/days`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ weekday: 1 });
  expect(dayRes.status).toBe(201);
  const dayId = dayRes.body.id;

  const mealRes = await request
    .post(`/nutrition-plan-templates/${tpl.id}/days/${dayId}/meals`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ meal_type: 'breakfast', display_name: 'Morning Meal' });
  expect(mealRes.status).toBe(201);
  const mealId = mealRes.body.id;

  const itemRes = await request
    .post(`/nutrition-plan-templates/${tpl.id}/days/${dayId}/meals/${mealId}/items`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ nutrition_library_item_id: libraryItemId, component_type: 'main_dish', quantity: 200, unit: 'g' });
  expect(itemRes.status).toBe(201);

  const restrictionRes = await request
    .post(`/nutrition-plan-templates/${tpl.id}/restrictions`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ nutrition_library_item_id: libraryItemId, applies_all_days: 1 });
  expect(restrictionRes.status).toBe(201);

  const goalRes = await request
    .post(`/nutrition-plan-templates/${tpl.id}/goals`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ item_name: 'protein', quantity: 150, unit: 'g', frequency: 'daily' });
  expect(goalRes.status).toBe(201);

  return tpl;
}

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

describe('auth guard', () => {
  it('returns 401 without auth on GET /member-nutrition-plans', async () => {
    const res = await request.get('/member-nutrition-plans');
    expect(res.status).toBe(401);
  });

  it('returns 401 without auth on GET /member-nutrition-plans/:id', async () => {
    const res = await request.get('/member-nutrition-plans/1');
    expect(res.status).toBe(401);
  });

  it('returns 401 without auth on DELETE /member-nutrition-plans/:id', async () => {
    const res = await request.delete('/member-nutrition-plans/1');
    expect(res.status).toBe(401);
  });

  it('returns 401 without auth on POST /member-nutrition-plans', async () => {
    const res = await request.post('/member-nutrition-plans').send({ member_id: memberId, name: 'X', start_date: '2026-01-01' });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('returns 403 when user has no membership in this gym', async () => {
    const otherId = await createTestGym('MNP Other Gym');
    const res = await request
      .get('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherId);
    expect(res.status).toBe(403);
  });

  it('returns 404 when accessing a plan that belongs to another gym', async () => {
    const plan = await createTestPlan();

    const gymB = await createTestGym('MNP Gym B');
    await createTestMembership(gymB, 'admin');

    const res = await request
      .get(`/member-nutrition-plans/${plan.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });

  it('returns 404 on hierarchy for a plan that belongs to another gym', async () => {
    const plan = await createTestPlan();

    const gymC = await createTestGym('MNP Gym C');
    await createTestMembership(gymC, 'admin');

    const res = await request
      .get(`/member-nutrition-plans/${plan.id}/hierarchy`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymC);
    expect(res.status).toBe(404);
  });

  it('returns 404 on POST when template_id belongs to another gym', async () => {
    const gymD = await createTestGym('MNP Gym D');
    await createTestMembership(gymD, 'admin');
    const otherGymTemplate = await createTestTemplate(gymD);

    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, template_id: otherGymTemplate.id, start_date: '2026-01-01' });
    expect(res.status).toBe(404);
  });

  it('returns 404 on POST when member_id belongs to another gym', async () => {
    const gymE = await createTestGym('MNP Gym E');
    await createTestMembership(gymE, 'admin');
    const { insertId: otherGymMemberId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'MNP Other Gym Member', ?)`,
      [gymE, `mnp-other-member-${Date.now()}@test.com`],
    );

    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: otherGymMemberId, name: 'Cross Gym Plan', start_date: '2026-01-01' });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Module access guard — accountant has NONE on NUTRITION
// ---------------------------------------------------------------------------

describe('module access guard', () => {
  it('returns 403 for accountant role on GET /member-nutrition-plans', async () => {
    const accountantGymId = await createTestGym('MNP Accountant Gym');
    await createTestMembership(accountantGymId, 'accountant');

    const res = await request
      .get('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', accountantGymId);
    expect(res.status).toBe(403);
  });

  it('returns 403 for accountant role on POST /member-nutrition-plans', async () => {
    const accountantGymId = await createTestGym('MNP Accountant POST Gym');
    await createTestMembership(accountantGymId, 'accountant');
    const { insertId: accountantGymMemberId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'MNP Accountant Gym Member', ?)`,
      [accountantGymId, `mnp-accountant-member-${Date.now()}@test.com`],
    );

    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', accountantGymId)
      .send({ member_id: accountantGymMemberId, name: 'Should Fail', start_date: '2026-01-01' });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('member nutrition plans happy path', () => {
  let plan: any;

  beforeAll(async () => {
    plan = await createTestPlan();
  });

  it('lists plans for the gym as an array', async () => {
    const res = await request
      .get('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((p: any) => p.id === plan.id);
    expect(found).toBeDefined();
    expect(found.member_name).toBe('MNP Test Member');
  });

  it('filters plans by ?member_id=', async () => {
    const res = await request
      .get(`/member-nutrition-plans?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const p of res.body) {
      expect(Number(p.member_id)).toBe(memberId);
    }
  });

  it('returns 400 for a non-integer ?member_id', async () => {
    const res = await request
      .get('/member-nutrition-plans?member_id=abc')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('gets a single plan by id', async () => {
    const res = await request
      .get(`/member-nutrition-plans/${plan.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(plan.id);
    expect(res.body.member_name).toBe('MNP Test Member');
  });

  it('returns 404 for a non-existent plan', async () => {
    const res = await request
      .get('/member-nutrition-plans/999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('gets the full hierarchy for a plan', async () => {
    const res = await request
      .get(`/member-nutrition-plans/${plan.id}/hierarchy`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(plan.id);
    expect(Array.isArray(res.body.days)).toBe(true);
    expect(Array.isArray(res.body.restrictions)).toBe(true);
    expect(Array.isArray(res.body.goals)).toBe(true);
  });

  it('returns 404 on hierarchy for a non-existent plan', async () => {
    const res = await request
      .get('/member-nutrition-plans/999999/hierarchy')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('soft-deletes a plan and hides it from the list and get', async () => {
    const planToDelete = await createTestPlan();

    const delRes = await request
      .delete(`/member-nutrition-plans/${planToDelete.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(delRes.status).toBe(204);

    const listRes = await request
      .get('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(listRes.status).toBe(200);
    const found = listRes.body.find((p: any) => p.id === planToDelete.id);
    expect(found).toBeUndefined();

    const getRes = await request
      .get(`/member-nutrition-plans/${planToDelete.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(getRes.status).toBe(404);
  });

  it('returns 404 when deleting a non-existent plan', async () => {
    const res = await request
      .delete('/member-nutrition-plans/999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST / — create a nutrition plan (from scratch or by cloning a template)
// #443
// ---------------------------------------------------------------------------

describe('create plan — validation', () => {
  it('returns 400 when member_id is missing', async () => {
    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'No Member', start_date: '2026-01-01' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when start_date is missing', async () => {
    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, name: 'No Start Date' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when start_date does not match YYYY-MM-DD', async () => {
    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, name: 'Bad Start Date', start_date: '01/01/2026' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is missing and template_id is omitted (from scratch)', async () => {
    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, start_date: '2026-01-01' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when template_id is not an integer', async () => {
    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, template_id: 'abc', start_date: '2026-01-01' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when member_id is not an integer', async () => {
    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: 'abc', name: 'Bad Member', start_date: '2026-01-01' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent member_id', async () => {
    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: 999999, name: 'Ghost Member', start_date: '2026-01-01' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent template_id', async () => {
    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, template_id: 999999, start_date: '2026-01-01' });
    expect(res.status).toBe(404);
  });
});

describe('create plan — from scratch (no template_id)', () => {
  it('creates a plan with template_id null, using the given name verbatim', async () => {
    const planName = `MNP From Scratch ${Date.now()}`;
    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, name: planName, description: 'Built without a template', start_date: '2026-01-01' });
    expect(res.status).toBe(201);
    expect(res.body.template_id).toBeNull();
    expect(res.body.name).toBe(planName);
    expect(res.body.member_name).toBe('MNP Test Member');
    expect(Number(res.body.member_id)).toBe(memberId);

    // No hierarchy should have been created for a from-scratch plan.
    const hierRes = await request
      .get(`/member-nutrition-plans/${res.body.id}/hierarchy`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(hierRes.status).toBe(200);
    expect(hierRes.body.days).toHaveLength(0);
  });
});

describe('create plan — from a template (template_id set)', () => {
  it('creates a plan cloning the full template hierarchy and sets template_id', async () => {
    const tpl = await createTestTemplateWithHierarchy();

    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, template_id: tpl.id, start_date: '2026-01-01' });
    expect(res.status).toBe(201);
    expect(Number(res.body.template_id)).toBe(Number(tpl.id));
    expect(res.body.member_name).toBe('MNP Test Member');

    const hierRes = await request
      .get(`/member-nutrition-plans/${res.body.id}/hierarchy`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(hierRes.status).toBe(200);
    expect(Array.isArray(hierRes.body.days)).toBe(true);
    expect(hierRes.body.days).toHaveLength(1);

    const meal = hierRes.body.days[0].meals[0];
    expect(meal.display_name).toBe('Morning Meal');
    expect(meal.meal_type).toBe('breakfast');
    expect(Array.isArray(meal.items)).toBe(true);
    expect(meal.items).toHaveLength(1);
    expect(meal.items[0].nutrition_library_item_id).toBe(libraryItemId);

    expect(Array.isArray(hierRes.body.restrictions)).toBe(true);
    expect(hierRes.body.restrictions).toHaveLength(1);
    expect(hierRes.body.restrictions[0].nutrition_library_item_id).toBe(libraryItemId);

    expect(Array.isArray(hierRes.body.goals)).toBe(true);
    expect(hierRes.body.goals).toHaveLength(1);
    expect(hierRes.body.goals[0].item_name).toBe('protein');
  });

  it('inherits the template name when no name is given', async () => {
    const tpl = await createTestTemplate();

    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, template_id: tpl.id, start_date: '2026-01-01' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(tpl.name);
  });

  it('uses a custom name when provided alongside template_id', async () => {
    const tpl = await createTestTemplate();
    const customName = `MNP Custom Cloned Name ${Date.now()}`;

    const res = await request
      .post('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, template_id: tpl.id, name: customName, start_date: '2026-01-01' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(customName);
  });
});

// ---------------------------------------------------------------------------
// #441 — Edit / Duplicate / Details / Complete + day/meal/item/restriction/goal CRUD
// ---------------------------------------------------------------------------

describe('module write guard', () => {
  it('returns 403 for accountant role on PUT /member-nutrition-plans/:id', async () => {
    const accountantGymId = await createTestGym('MNP Accountant Write Gym');
    await createTestMembership(accountantGymId, 'accountant');

    const res = await request
      .put('/member-nutrition-plans/1')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', accountantGymId)
      .send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Edit — PUT /:id
// ---------------------------------------------------------------------------

describe('edit plan', () => {
  it('updates name, description and start_date', async () => {
    const plan = await createTestPlan();
    const res = await request
      .put(`/member-nutrition-plans/${plan.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Updated Plan Name', description: 'Updated description', start_date: '2026-01-01' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Plan Name');
    expect(res.body.description).toBe('Updated description');
  });

  it('returns 400 when name is present but empty', async () => {
    const plan = await createTestPlan();
    const res = await request
      .put(`/member-nutrition-plans/${plan.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a plan in another gym', async () => {
    const plan = await createTestPlan();
    const gymB = await createTestGym('MNP Edit Gym B');
    await createTestMembership(gymB, 'admin');

    const res = await request
      .put(`/member-nutrition-plans/${plan.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ name: 'Should not apply' });
    expect(res.status).toBe(404);
  });

  it('returns 403 when the plan is not active (e.g. completed)', async () => {
    const plan = await createTestPlan();
    const completeRes = await request
      .post(`/member-nutrition-plans/${plan.id}/complete`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(completeRes.status).toBe(200);

    const res = await request
      .put(`/member-nutrition-plans/${plan.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Should not apply' });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Complete — POST /:id/complete
// ---------------------------------------------------------------------------

describe('complete plan', () => {
  it('sets status to completed', async () => {
    const plan = await createTestPlan();
    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/complete`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  });

  it('returns 404 for a non-existent plan', async () => {
    const res = await request
      .post('/member-nutrition-plans/999999/complete')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a plan in another gym', async () => {
    const plan = await createTestPlan();
    const gymB = await createTestGym('MNP Complete Gym B');
    await createTestMembership(gymB, 'admin');

    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/complete`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });

  it('returns 403 when called a second time (already completed)', async () => {
    const plan = await createTestPlan();
    const first = await request
      .post(`/member-nutrition-plans/${plan.id}/complete`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(first.status).toBe(200);

    const second = await request
      .post(`/member-nutrition-plans/${plan.id}/complete`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(second.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Duplicate — POST /:id/duplicate (deep clone)
// ---------------------------------------------------------------------------

describe('duplicate plan', () => {
  it('deep-clones days/meals/items/restrictions/goals into a new active plan', async () => {
    const plan = await createTestPlan();

    // Build out a day -> meal -> item, plus a restriction and a goal.
    const dayRes = await request
      .post(`/member-nutrition-plans/${plan.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 1 });
    expect(dayRes.status).toBe(201);
    const dayId = dayRes.body.id;

    const mealRes = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'lunch' });
    expect(mealRes.status).toBe(201);
    const mealId = mealRes.body.id;

    const itemRes = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals/${mealId}/items`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, component_type: 'main_dish', quantity: 200, unit: 'g' });
    expect(itemRes.status).toBe(201);

    const restrictionRes = await request
      .post(`/member-nutrition-plans/${plan.id}/restrictions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, applies_all_days: 1 });
    expect(restrictionRes.status).toBe(201);

    const goalRes = await request
      .post(`/member-nutrition-plans/${plan.id}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ item_name: 'protein', quantity: 150, unit: 'g' });
    expect(goalRes.status).toBe(201);

    const srcHierarchy = await request
      .get(`/member-nutrition-plans/${plan.id}/hierarchy`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(srcHierarchy.status).toBe(200);

    const dupRes = await request
      .post(`/member-nutrition-plans/${plan.id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dupRes.status).toBe(201);
    expect(dupRes.body.id).not.toBe(plan.id);
    expect(dupRes.body.name).toBe(`${plan.name} (Copy)`);
    expect(dupRes.body.status).toBe('active');
    expect(dupRes.body.member_id).toBe(plan.member_id);

    const dupHierarchy = await request
      .get(`/member-nutrition-plans/${dupRes.body.id}/hierarchy`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dupHierarchy.status).toBe(200);
    expect(dupHierarchy.body.days.length).toBe(srcHierarchy.body.days.length);
    expect(dupHierarchy.body.days[0].meals.length).toBe(srcHierarchy.body.days[0].meals.length);
    expect(dupHierarchy.body.days[0].meals[0].items.length).toBe(srcHierarchy.body.days[0].meals[0].items.length);
    expect(dupHierarchy.body.restrictions.length).toBe(srcHierarchy.body.restrictions.length);
    expect(dupHierarchy.body.goals.length).toBe(srcHierarchy.body.goals.length);
  });

  it('returns 404 for a non-existent plan', async () => {
    const res = await request
      .post('/member-nutrition-plans/999999/duplicate')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a plan in another gym', async () => {
    const plan = await createTestPlan();
    const gymB = await createTestGym('MNP Duplicate Gym B');
    await createTestMembership(gymB, 'admin');

    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Days — POST /:id/days, PUT /:id/days/reorder, DELETE /:id/days/:dayId
// ---------------------------------------------------------------------------

describe('days', () => {
  it('adds a day', async () => {
    const plan = await createTestPlan();
    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 2 });
    expect(res.status).toBe(201);
    expect(res.body.weekday).toBe(2);
  });

  it('returns 400 for an invalid weekday', async () => {
    const plan = await createTestPlan();
    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 8 });
    expect(res.status).toBe(400);
  });

  it('returns 409 for a duplicate weekday on the same plan', async () => {
    const plan = await createTestPlan();
    const first = await request
      .post(`/member-nutrition-plans/${plan.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 3 });
    expect(first.status).toBe(201);

    const second = await request
      .post(`/member-nutrition-plans/${plan.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 3 });
    expect(second.status).toBe(409);
  });

  it('returns 404 for a plan in another gym', async () => {
    const plan = await createTestPlan();
    const gymB = await createTestGym('MNP Days Gym B');
    await createTestMembership(gymB, 'admin');

    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ weekday: 0 });
    expect(res.status).toBe(404);
  });

  it('returns 403 when the plan is not active', async () => {
    const plan = await createTestPlan();
    await request
      .post(`/member-nutrition-plans/${plan.id}/complete`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 0 });
    expect(res.status).toBe(403);
  });

  it('reorders days', async () => {
    const plan = await createTestPlan();
    const d1 = await request
      .post(`/member-nutrition-plans/${plan.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 0 });
    const d2 = await request
      .post(`/member-nutrition-plans/${plan.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 1 });

    const res = await request
      .put(`/member-nutrition-plans/${plan.id}/days/reorder`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ order: [d2.body.id, d1.body.id] });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe(d2.body.id);
  });

  it('returns 403 when reordering days on a plan that is not active', async () => {
    const plan = await createTestPlan();
    const d1 = await request
      .post(`/member-nutrition-plans/${plan.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 0 });
    await request
      .post(`/member-nutrition-plans/${plan.id}/complete`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const res = await request
      .put(`/member-nutrition-plans/${plan.id}/days/reorder`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ order: [d1.body.id] });
    expect(res.status).toBe(403);
  });

  it('deletes a day', async () => {
    const plan = await createTestPlan();
    const dayRes = await request
      .post(`/member-nutrition-plans/${plan.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 4 });

    const res = await request
      .delete(`/member-nutrition-plans/${plan.id}/days/${dayRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('returns 404 when deleting a dayId belonging to a different plan', async () => {
    const planA = await createTestPlan();
    const planB = await createTestPlan();
    const dayRes = await request
      .post(`/member-nutrition-plans/${planA.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 5 });

    const res = await request
      .delete(`/member-nutrition-plans/${planB.id}/days/${dayRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 403 when deleting a day on a plan that is not active', async () => {
    const plan = await createTestPlan();
    const dayRes = await request
      .post(`/member-nutrition-plans/${plan.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 6 });
    await request
      .post(`/member-nutrition-plans/${plan.id}/complete`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const res = await request
      .delete(`/member-nutrition-plans/${plan.id}/days/${dayRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Meals — POST/PUT/DELETE under a day
// ---------------------------------------------------------------------------

describe('meals', () => {
  let plan: any;
  let dayId: number;

  beforeAll(async () => {
    plan = await createTestPlan();
    const dayRes = await request
      .post(`/member-nutrition-plans/${plan.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 0 });
    dayId = dayRes.body.id;
  });

  it('adds a meal', async () => {
    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'breakfast' });
    expect(res.status).toBe(201);
    expect(res.body.meal_type).toBe('breakfast');
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('returns 400 for an invalid meal_type', async () => {
    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'brunch' });
    expect(res.status).toBe(400);
  });

  it('updates a meal', async () => {
    const addRes = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'snack' });
    expect(addRes.status).toBe(201);

    const res = await request
      .put(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals/${addRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ display_name: 'Afternoon Snack', notes: 'Low sugar', meal_type: 'media_manana' });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Afternoon Snack');
    expect(res.body.notes).toBe('Low sugar');
    expect(res.body.meal_type).toBe('media_manana');
  });

  it('reorders meals', async () => {
    const m1 = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'recien_levantado' });
    const m2 = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'antes_de_dormir' });

    const res = await request
      .put(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals/reorder`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ order: [m2.body.id, m1.body.id] });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('deletes a meal', async () => {
    const addRes = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'dinner' });
    expect(addRes.status).toBe(201);

    const res = await request
      .delete(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals/${addRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('returns 404 for a plan in another gym', async () => {
    const gymB = await createTestGym('MNP Meals Gym B');
    await createTestMembership(gymB, 'admin');

    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ meal_type: 'lunch' });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Meal Items — POST/PUT/DELETE under a meal
// ---------------------------------------------------------------------------

describe('meal items', () => {
  let plan: any;
  let dayId: number;
  let mealId: number;

  beforeAll(async () => {
    plan = await createTestPlan();
    const dayRes = await request
      .post(`/member-nutrition-plans/${plan.id}/days`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ weekday: 0 });
    dayId = dayRes.body.id;

    const mealRes = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ meal_type: 'lunch' });
    mealId = mealRes.body.id;
  });

  it('adds a meal item with a valid component_type', async () => {
    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals/${mealId}/items`)
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

  it('returns 400 for a component_type not in the narrower member-plan list (e.g. drink)', async () => {
    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals/${mealId}/items`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, component_type: 'drink' });
    expect(res.status).toBe(400);
  });

  it('updates a meal item', async () => {
    const addRes = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals/${mealId}/items`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, component_type: 'side', quantity: 100, unit: 'g' });
    expect(addRes.status).toBe(201);

    const res = await request
      .put(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals/${mealId}/items/${addRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ quantity: 150, unit: 'ml' });
    expect(res.status).toBe(200);
    expect(Number(res.body.quantity)).toBe(150);
    expect(res.body.unit).toBe('ml');
  });

  it('deletes a meal item', async () => {
    const addRes = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals/${mealId}/items`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, component_type: 'sauce' });
    expect(addRes.status).toBe(201);

    const res = await request
      .delete(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals/${mealId}/items/${addRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('returns 404 for a plan in another gym', async () => {
    const gymB = await createTestGym('MNP Meal Items Gym B');
    await createTestMembership(gymB, 'admin');

    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/days/${dayId}/meals/${mealId}/items`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ nutrition_library_item_id: libraryItemId, component_type: 'additional' });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Restrictions — POST /:id/restrictions, DELETE /:id/restrictions/:rid
// ---------------------------------------------------------------------------

describe('restrictions', () => {
  it('adds a restriction', async () => {
    const plan = await createTestPlan();
    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/restrictions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, applies_all_days: 1 });
    expect(res.status).toBe(201);
    expect(res.body.nutrition_library_item_id).toBe(libraryItemId);
    expect(typeof res.body.item_name).toBe('string');
  });

  it('deletes a restriction', async () => {
    const plan = await createTestPlan();
    const addRes = await request
      .post(`/member-nutrition-plans/${plan.id}/restrictions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ nutrition_library_item_id: libraryItemId, applies_all_days: 0 });
    expect(addRes.status).toBe(201);

    const res = await request
      .delete(`/member-nutrition-plans/${plan.id}/restrictions/${addRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('returns 404 for a plan in another gym', async () => {
    const plan = await createTestPlan();
    const gymB = await createTestGym('MNP Restrictions Gym B');
    await createTestMembership(gymB, 'admin');

    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/restrictions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ nutrition_library_item_id: libraryItemId });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Goals — POST /:id/goals, DELETE /:id/goals/:gid
// ---------------------------------------------------------------------------

describe('goals', () => {
  it('adds a goal with a valid item_name', async () => {
    const plan = await createTestPlan();
    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ item_name: 'calories', quantity: 2200, unit: 'kcal' });
    expect(res.status).toBe(201);
    expect(res.body.item_name).toBe('calories');
    expect(Number(res.body.quantity)).toBe(2200);
    expect(res.body.unit).toBe('kcal');
  });

  it('returns 400 for an item_name not in NUTRITION_GOALS', async () => {
    const plan = await createTestPlan();
    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ item_name: 'sleep', quantity: 8, unit: 'hours' });
    expect(res.status).toBe(400);
  });

  it('deletes a goal', async () => {
    const plan = await createTestPlan();
    const addRes = await request
      .post(`/member-nutrition-plans/${plan.id}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ item_name: 'water', quantity: 2, unit: 'L' });
    expect(addRes.status).toBe(201);

    const res = await request
      .delete(`/member-nutrition-plans/${plan.id}/goals/${addRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('returns 404 for a plan in another gym', async () => {
    const plan = await createTestPlan();
    const gymB = await createTestGym('MNP Goals Gym B');
    await createTestMembership(gymB, 'admin');

    const res = await request
      .post(`/member-nutrition-plans/${plan.id}/goals`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ item_name: 'fiber', quantity: 30, unit: 'g' });
    expect(res.status).toBe(404);
  });
});
