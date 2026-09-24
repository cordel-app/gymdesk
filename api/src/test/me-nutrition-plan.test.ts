// Tests for me.ts router — GET /me/nutrition-plan (#361)
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
let memberId: number;
let libraryItemId: number;

beforeAll(async () => {
  gymId = await createTestGym('Me Nutrition Plan Gym');
  await createTestMembership(gymId, 'member');

  const email = `me-nutrition-${Date.now()}@test.com`;
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id)
     VALUES (?, 'Test Member', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, email, TEST_USER_ID],
  );
  const { rows: mRows } = await db.query<{ id: number }>(
    'SELECT id FROM members WHERE clerk_user_id = ?',
    [TEST_USER_ID],
  );
  memberId = mRows[0].id;

  const { insertId } = await db.query(
    `INSERT INTO nutrition_library_items (gym_id, name, status)
     VALUES (NULL, 'Grilled Chicken', 'active')`,
  );
  libraryItemId = insertId;
  const { rows: catRows } = await db.query<{ id: number }>(
    "SELECT id FROM nutrition_library_categories WHERE slug = 'main_dish'",
  );
  await db.query(
    'INSERT INTO nutrition_library_item_categories (item_id, category_id) VALUES (?, ?)',
    [libraryItemId, catRows[0].id],
  );
});

/** Library items created by a single describe block — dropped after the gyms. */
const extraLibraryItemIds: number[] = [];

afterAll(async () => {
  await cleanupTestGyms();
  // The meal items referencing these are gone with the gyms above; the FK to
  // nutrition_library_items is ON DELETE RESTRICT, so the order matters.
  for (const id of [libraryItemId, ...extraLibraryItemIds]) {
    await db.query('DELETE FROM nutrition_library_items WHERE id = ?', [id]);
  }
  await db.end();
});

/** Insert an active member_nutrition_plan with one day/meal/item and one goal. */
async function insertActivePlan(gid: string, mid: number, weekday: number) {
  const { insertId: planId } = await db.query(
    `INSERT INTO member_nutrition_plans (gym_id, member_id, name, status)
     VALUES (?, ?, 'Test Plan', 'active')`,
    [gid, mid],
  );
  const { insertId: dayId } = await db.query(
    `INSERT INTO member_nutrition_plan_days (gym_id, member_nutrition_plan_id, weekday, position)
     VALUES (?, ?, ?, 1)`,
    [gid, planId, weekday],
  );
  const { insertId: mealId } = await db.query(
    `INSERT INTO member_nutrition_plan_meals (gym_id, member_nutrition_plan_day_id, meal_type, display_name, position)
     VALUES (?, ?, 'lunch', 'Lunch', 1)`,
    [gid, dayId],
  );
  await db.query(
    `INSERT INTO member_nutrition_plan_meal_items (gym_id, meal_id, nutrition_library_item_id, component_type, quantity, unit, position)
     VALUES (?, ?, ?, 'main_dish', 150, 'g', 1)`,
    [gid, mealId, libraryItemId],
  );
  await db.query(
    `INSERT INTO member_nutrition_plan_goals (gym_id, member_nutrition_plan_id, item_name, quantity, unit, frequency)
     VALUES (?, ?, 'Protein', 140, 'g', 'daily')`,
    [gid, planId],
  );
  return planId;
}

describe('GET /me/nutrition-plan', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/me/nutrition-plan').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in this gym', async () => {
    const otherId = await createTestGym('Other Nutrition Gym');
    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherId);
    expect(res.status).toBe(403);
  });

  it('returns 403 when user has a non-member gym role', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'nutrition-admin-user' } as any);
    const roleGymId = await createTestGym('Nutrition Role Guard Gym');
    await createTestMembership(roleGymId, 'admin', 'nutrition-admin-user');
    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', roleGymId);
    expect(res.status).toBe(403);
  });

  it('returns { plan: null } when the member has no active plan', async () => {
    // A distinct clerk id — must NOT reuse TEST_USER_ID here: clerk_user_id is
    // globally unique on `members`, so upserting TEST_USER_ID into another gym
    // would move the shared test member (and its plan) out of `gymId`, breaking
    // every later test in this file that still expects it there.
    const noPlanClerkId = `no-plan-clerk-${Date.now()}`;
    const emptyGymId = await createTestGym('No Plan Gym');
    await createTestMembership(emptyGymId, 'member', noPlanClerkId);
    await db.query(
      `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'No Plan Member', ?, ?)`,
      [emptyGymId, `no-plan-${Date.now()}@test.com`, noPlanClerkId],
    );

    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: noPlanClerkId } as any);
    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', emptyGymId);
    expect(res.status).toBe(200);
    expect(res.body.plan).toBeNull();
  });

  it('returns the active plan with full days/meals/items/goals for the caller', async () => {
    await insertActivePlan(gymId, memberId, 2);

    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.plan).not.toBeNull();
    expect(res.body.plan.name).toBe('Test Plan');
    expect(Array.isArray(res.body.plan.days)).toBe(true);
    expect(res.body.plan.days.length).toBeGreaterThan(0);

    const day = res.body.plan.days.find((d: any) => d.weekday === 2);
    expect(day).toBeDefined();
    expect(day.meals.length).toBe(1);
    expect(day.meals[0].display_name).toBe('Lunch');
    expect(day.meals[0].items[0].item_name).toBe('Grilled Chicken');

    expect(Array.isArray(res.body.plan.goals)).toBe(true);
    expect(res.body.plan.goals[0].item_name).toBe('Protein');
  });

  it('does not return a different member\'s plan from the same gym', async () => {
    // A second, unlinked member in the same gym with their own active plan.
    const { insertId: otherMemberId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Other Member', ?)`,
      [gymId, `other-member-${Date.now()}@test.com`],
    );
    await insertActivePlan(gymId, otherMemberId, 3);

    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    // Still resolves to the caller's own plan (inserted earlier in this file), never the other member's.
    expect(res.body.plan.name).toBe('Test Plan');
    expect(res.body.plan.days.some((d: any) => d.weekday === 3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Translated library names in the member app (#643)
// ---------------------------------------------------------------------------

describe('GET /me/nutrition-plan — translated item names', () => {
  beforeAll(async () => {
    // The translation row cascades away with the item in afterAll.
    await db.query(
      `INSERT INTO nutrition_library_item_translations (item_id, locale, name)
       VALUES (?, 'ca', 'Pollastre a la Graella'), (?, 'es', 'Pollo a la Parrilla')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [libraryItemId, libraryItemId],
    );
    await insertActivePlan(gymId, memberId, 4);
  });

  it('renders meal item names in the locale the member app requests', async () => {
    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('x-locale', 'ca');
    expect(res.status).toBe(200);
    const names = res.body.plan.days.flatMap((d: any) => d.meals.flatMap((m: any) => m.items.map((i: any) => i.item_name)));
    expect(names).toContain('Pollastre a la Graella');
    expect(names).not.toContain('Grilled Chicken');
  });

  it('negotiates Accept-Language when no x-locale header is sent', async () => {
    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('Accept-Language', 'es-ES,es;q=0.9');
    expect(res.status).toBe(200);
    const names = res.body.plan.days.flatMap((d: any) => d.meals.flatMap((m: any) => m.items.map((i: any) => i.item_name)));
    expect(names).toContain('Pollo a la Parrilla');
  });

  it('serves the base English name when the locale is unsupported', async () => {
    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('x-locale', 'de');
    expect(res.status).toBe(200);
    const names = res.body.plan.days.flatMap((d: any) => d.meals.flatMap((m: any) => m.items.map((i: any) => i.item_name)));
    expect(names).toContain('Grilled Chicken');
  });
});

// ---------------------------------------------------------------------------
// Food card data for the member app's nutrition carousel (#722)
// ---------------------------------------------------------------------------

describe('GET /me/nutrition-plan — food image and nutritional qualities', () => {
  // Its own gym and member: this block asserts on *the* returned plan, and the
  // shared member above already owns several.
  const clerkId = `carousel-clerk-${Date.now()}`;
  let carouselGymId: string;
  let imagedItemId: number;

  beforeAll(async () => {
    carouselGymId = await createTestGym('Nutrition Carousel Gym');
    await createTestMembership(carouselGymId, 'member', clerkId);
    const { insertId: carouselMemberId } = await db.query(
      `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'Carousel Member', ?, ?)`,
      [carouselGymId, `carousel-${Date.now()}@test.com`, clerkId],
    );

    const { insertId } = await db.query(
      `INSERT INTO nutrition_library_items (gym_id, name, status, image_url)
       VALUES (NULL, ?, 'active', 'https://cdn.example.test/nutrition/salmon.png')`,
      [`Carousel Salmon ${Date.now()}`],
    );
    imagedItemId = insertId;
    extraLibraryItemIds.push(imagedItemId);

    const { rows: qualityRows } = await db.query<{ id: number }>(
      "SELECT id FROM nutritional_qualities WHERE slug IN ('protein', 'fat') ORDER BY id",
    );
    for (const quality of qualityRows) {
      await db.query(
        'INSERT INTO nutrition_library_item_qualities (item_id, quality_id) VALUES (?, ?)',
        [imagedItemId, quality.id],
      );
    }

    // One meal holding both foods: the imaged, classified one and the plain
    // 'Grilled Chicken' from the top of this file (no image, no qualities).
    await insertActivePlan(carouselGymId, carouselMemberId, 1);
    const { rows: mealRows } = await db.query<{ id: number }>(
      `SELECT m.id FROM member_nutrition_plan_meals m
       JOIN member_nutrition_plan_days d ON d.id = m.member_nutrition_plan_day_id
       WHERE m.gym_id = ?`,
      [carouselGymId],
    );
    await db.query(
      `INSERT INTO member_nutrition_plan_meal_items (gym_id, meal_id, nutrition_library_item_id, component_type, quantity, unit, position)
       VALUES (?, ?, ?, 'side', 200, 'g', 2)`,
      [carouselGymId, mealRows[0].id, imagedItemId],
    );
  });

  async function fetchItems() {
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerkId } as any);
    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', carouselGymId);
    expect(res.status).toBe(200);
    return res.body.plan.days.flatMap((d: any) => d.meals.flatMap((m: any) => m.items));
  }

  it('exposes the library item image so the card can render it', async () => {
    const items = await fetchItems();
    const imaged = items.find((i: any) => i.nutrition_library_item_id === imagedItemId);
    expect(imaged.image_url).toBe('https://cdn.example.test/nutrition/salmon.png');
  });

  it('exposes the nutritional qualities of each food', async () => {
    const items = await fetchItems();
    const imaged = items.find((i: any) => i.nutrition_library_item_id === imagedItemId);
    expect(imaged.qualities.map((q: any) => q.slug).sort()).toEqual(['fat', 'protein']);
    expect(imaged.qualities.every((q: any) => typeof q.id === 'number')).toBe(true);
  });

  it('handles a food with neither image nor qualities gracefully', async () => {
    const items = await fetchItems();
    const plain = items.find((i: any) => i.nutrition_library_item_id === libraryItemId);
    expect(plain.image_url).toBeNull();
    expect(plain.qualities).toEqual([]);
  });

  it('still returns the quantity, unit and role each card renders', async () => {
    const items = await fetchItems();
    const imaged = items.find((i: any) => i.nutrition_library_item_id === imagedItemId);
    expect(Number(imaged.quantity)).toBe(200);
    expect(imaged.unit).toBe('g');
    expect(imaged.component_type).toBe('side');
  });
});
