// #932 — a Nutrition Goal illustrated by a Nutrition Library food.
//
// A goal is a slug, not a food, so its picture is the food staff pick to
// illustrate it (`nutrition_library_item_id`, migration 233). What this file
// pins down: the value is judged in one place (absent/null keeps the fallback,
// an id must be a food the caller may use), it travels template → member plan
// when a plan is created from a template, and `GET /me/nutrition-plan` carries
// that food's own `image_url` beside the goal — the one image source My
// Nutrition has (§3).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { verifyToken } from '@clerk/backend';
import {
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
  TEST_AUTH_HEADER,
} from './helpers';

let gymId: string;
let otherGymId: string;
let foodId: number;
let systemFoodId: number;
let deletedFoodId: number;
let foreignFoodId: number;

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const h = (gid = gymId) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gid });

async function createFood(gid: string | null, opts: { status?: string; imageUrl?: string | null } = {}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO nutrition_library_items (gym_id, name, status, image_url) VALUES (?, ?, ?, ?)`,
    [gid, `NGI Food ${uniq()}`, opts.status ?? 'active', opts.imageUrl ?? null],
  );
  return insertId;
}

async function createTemplate(): Promise<number> {
  const res = await request.post('/nutrition-plan-templates').set(h()).send({ name: `NGI Template ${uniq()}` });
  expect(res.status).toBe(201);
  return res.body.id;
}

const postGoal = (tplId: number, body: Record<string, unknown>) =>
  request.post(`/nutrition-plan-templates/${tplId}/goals`).set(h()).send({ item_name: 'protein', quantity: 150, unit: 'g', ...body });

beforeAll(async () => {
  gymId = await createTestGym('NGI Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('NGI Other Gym');
  foodId = await createFood(gymId, { imageUrl: 'https://cdn.example/ngi/protein.png' });
  systemFoodId = await createFood(null, { imageUrl: 'https://cdn.example/ngi/system.png' });
  deletedFoodId = await createFood(gymId, { status: 'deleted' });
  foreignFoodId = await createFood(otherGymId);
});

afterAll(async () => {
  // System rows are not covered by cleanupTestGyms (gym_id IS NULL).
  await db.query('DELETE FROM nutrition_library_items WHERE id = ?', [systemFoodId]);
  await cleanupTestGyms();
  await db.end();
});

describe('illustrating a template goal', () => {
  it('stores the food and reports its name and image beside the goal', async () => {
    const tplId = await createTemplate();
    const res = await postGoal(tplId, { nutrition_library_item_id: foodId });
    expect(res.status).toBe(201);
    expect(res.body.nutrition_library_item_id).toBe(foodId);
    expect(res.body.illustration_image_url).toBe('https://cdn.example/ngi/protein.png');
    expect(typeof res.body.illustration_name).toBe('string');

    const hier = await request.get(`/nutrition-plan-templates/${tplId}/hierarchy`).set(h());
    expect(hier.body.goals[0].illustration_image_url).toBe('https://cdn.example/ngi/protein.png');
  });

  it('a goal with no food carries null, never a guessed image', async () => {
    const tplId = await createTemplate();
    const res = await postGoal(tplId, { item_name: 'water', unit: 'l', quantity: 2 });
    expect(res.status).toBe(201);
    expect(res.body.nutrition_library_item_id).toBeNull();
    expect(res.body.illustration_image_url).toBeNull();
  });

  it('accepts a System food, and refuses a deleted one, another gym\'s and a malformed id', async () => {
    const tplId = await createTemplate();
    expect((await postGoal(tplId, { nutrition_library_item_id: systemFoodId })).status).toBe(201);
    expect((await postGoal(tplId, { nutrition_library_item_id: deletedFoodId })).status).toBe(400);
    expect((await postGoal(tplId, { nutrition_library_item_id: foreignFoodId })).status).toBe(400);
    expect((await postGoal(tplId, { nutrition_library_item_id: 'x' })).status).toBe(400);
  });

  it('PUT: absent keeps, null clears, an id replaces', async () => {
    const tplId = await createTemplate();
    const goal = (await postGoal(tplId, { nutrition_library_item_id: foodId })).body;
    const put = (body: Record<string, unknown>) =>
      request.put(`/nutrition-plan-templates/${tplId}/goals/${goal.id}`).set(h()).send(body);
    expect((await put({ quantity: 200 })).body.nutrition_library_item_id).toBe(foodId);
    expect((await put({ nutrition_library_item_id: null })).body.nutrition_library_item_id).toBeNull();
    expect((await put({ nutrition_library_item_id: systemFoodId })).body.nutrition_library_item_id).toBe(systemFoodId);
    expect((await put({ nutrition_library_item_id: foreignFoodId })).status).toBe(400);
  });
});

describe('the illustration follows the goal', () => {
  it('is copied by Duplicate and into a member plan created from the template, and reaches the member with the image', async () => {
    const tplId = await createTemplate();
    await postGoal(tplId, { nutrition_library_item_id: foodId });

    const dup = await request.post(`/nutrition-plan-templates/${tplId}/duplicate`).set(h());
    expect(dup.status).toBe(201);
    const dupHier = await request.get(`/nutrition-plan-templates/${dup.body.id}/hierarchy`).set(h());
    expect(dupHier.body.goals[0].nutrition_library_item_id).toBe(foodId);

    const memberUserId = `ngi-member-${uniq()}`;
    const { insertId: memberId } = await db.query(
      `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'NGI Member', ?, ?)`,
      [gymId, `${memberUserId}@test.com`, memberUserId],
    );
    const planRes = await request.post('/member-nutrition-plans').set(h())
      .send({ member_id: memberId, template_id: tplId, start_date: new Date().toISOString().slice(0, 10) });
    expect(planRes.status).toBe(201);
    const planHier = await request.get(`/member-nutrition-plans/${planRes.body.id}/hierarchy`).set(h());
    expect(planHier.body.goals[0].nutrition_library_item_id).toBe(foodId);
    expect(planHier.body.goals[0].illustration_image_url).toBe('https://cdn.example/ngi/protein.png');

    await createTestMembership(gymId, 'member', memberUserId);
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: memberUserId } as any);
    const me = await request.get('/me/nutrition-plan').set(h());
    expect(me.status).toBe(200);
    expect(me.body.plan.goals[0].image_url).toBe('https://cdn.example/ngi/protein.png');
  });
});
