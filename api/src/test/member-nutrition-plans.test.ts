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
