import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('assigned nutrition plan versions (#1970)', () => {
  let gymId: string;
  let otherGymId: string;
  let memberId: number;
  let planId: number;
  const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

  beforeAll(async () => {
    gymId = await createTestGym('Nutrition Versions Gym');
    otherGymId = await createTestGym('Nutrition Versions Other Gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');
    const m = await db.query(`INSERT INTO members (gym_id, name, email) VALUES (?, 'N Member', ?)`, [gymId, `nv-${Date.now()}@test.com`]);
    memberId = m.insertId;
    const ins = await db.query(
      `INSERT INTO member_nutrition_plans (gym_id, member_id, name, status, start_date) VALUES (?, ?, 'Cut', 'active', CURRENT_DATE)`,
      [gymId, memberId],
    );
    planId = ins.insertId;
    await db.query(`INSERT INTO member_nutrition_plan_days (gym_id, member_nutrition_plan_id, weekday, position) VALUES (?, ?, 1, 0)`, [gymId, planId]);
  });

  it('edit-draft copies the plan and leaves the original untouched; repeating returns the same draft', async () => {
    const res = await auth(request.post(`/member-nutrition-plans/${planId}/edit-draft`));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.name).toBe('Cut');
    expect(Number(res.body.day_count)).toBe(1);
    const again = await auth(request.post(`/member-nutrition-plans/${planId}/edit-draft`));
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(res.body.id);
    const orig = await auth(request.get(`/member-nutrition-plans/${planId}`));
    expect(orig.body.status).toBe('active');
    expect(orig.body.name).toBe('Cut');
    expect((await auth(request.post(`/member-nutrition-plans/${res.body.id}/complete`))).status).toBe(409);
  });

  it('is tenant scoped and unauthenticated requests are refused', async () => {
    expect((await auth(request.post(`/member-nutrition-plans/${planId}/edit-draft`), otherGymId)).status).toBe(404);
    expect((await request.post(`/member-nutrition-plans/${planId}/edit-draft`)).status).toBe(401);
  });

  it('publish-version ends the old version and activates the draft once', async () => {
    const { rows } = await db.query('SELECT id FROM member_nutrition_plans WHERE draft_of_plan_id = ?', [planId]);
    const draftId = rows[0].id;
    const res = await auth(request.post(`/member-nutrition-plans/${draftId}/publish-version`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.end_date).toBeNull();
    expect(res.body.name).toMatch(/^Cut \[\d{4}-\d{2}-\d{2} - Open End\]$/);
    const orig = await auth(request.get(`/member-nutrition-plans/${planId}`));
    expect(orig.body.status).toBe('completed');
    expect(orig.body.name).toMatch(/^Cut \[\d{4}-\d{2}-\d{2} - \d{4}-\d{2}-\d{2}\]$/);
    expect((await auth(request.post(`/member-nutrition-plans/${draftId}/publish-version`))).status).toBe(409);
    expect((await auth(request.post(`/member-nutrition-plans/${planId}/edit-draft`))).status).toBe(409);
  });

  it('cancelling a draft (DELETE) leaves the original unchanged', async () => {
    const ins = await db.query(
      `INSERT INTO member_nutrition_plans (gym_id, member_id, name, status, start_date) VALUES (?, ?, 'Bulk', 'active', CURRENT_DATE)`,
      [gymId, memberId],
    );
    const d = await auth(request.post(`/member-nutrition-plans/${ins.insertId}/edit-draft`));
    expect((await auth(request.delete(`/member-nutrition-plans/${d.body.id}`))).status).toBe(204);
    const orig = await auth(request.get(`/member-nutrition-plans/${ins.insertId}`));
    expect(orig.body.status).toBe('active');
    expect(orig.body.name).toBe('Bulk');
  });
});
