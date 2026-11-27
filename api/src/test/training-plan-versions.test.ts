import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { gymToday } from '../domain/workoutProgress';
import { previousDay } from '../domain/trainingPlanVersioning';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('assigned training plan versions (#1969)', () => {
  let gymId: string;
  let otherGymId: string;
  let memberId: number;
  let planId: number;
  const base = () => `/members/${memberId}/training-plans`;
  const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

  beforeAll(async () => {
    gymId = await createTestGym('Plan Versions Gym');
    otherGymId = await createTestGym('Plan Versions Other Gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');
    const m = await db.query(`INSERT INTO members (gym_id, name, email) VALUES (?, 'V Member', ?)`, [gymId, `v-${Date.now()}@test.com`]);
    memberId = m.insertId;
    const ins = await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date) VALUES (?, ?, 'Strength', 'active', CURRENT_DATE - INTERVAL 10 DAY)`,
      [gymId, memberId],
    );
    planId = ins.insertId;
    await db.query(
      `INSERT INTO member_training_plans (gym_id, member_id, training_plan_id, name, status, valid_from) VALUES (?, ?, ?, 'Strength', 'active', CURRENT_DATE - INTERVAL 10 DAY)`,
      [gymId, memberId, planId],
    );
    const w = await auth(request.post(`${base()}/${planId}/workouts`)).send({ name: 'Day 1' });
    expect(w.status).toBe(201);
  });

  it('edit-draft copies the plan and leaves the original untouched; repeating returns the same draft', async () => {
    const res = await auth(request.post(`${base()}/${planId}/edit-draft`));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.name).toBe('Strength');
    expect(res.body.workouts).toHaveLength(1);
    const again = await auth(request.post(`${base()}/${planId}/edit-draft`));
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(res.body.id);
    const orig = await auth(request.get(`${base()}/${planId}`));
    expect(orig.body.status).toBe('active');
    expect(orig.body.name).toBe('Strength');
  });

  it('saving the header of a version draft keeps it a draft; only publish activates it (#1969 stage 2)', async () => {
    const { rows } = await db.query("SELECT id FROM training_plans WHERE draft_of_plan_id = ?", [planId]);
    const draftId = rows[0].id;
    const put = await auth(request.put(`${base()}/${draftId}`)).send({ name: 'Strength', description: 'edited' });
    expect(put.status).toBe(200);
    expect(put.body.status).toBe('draft');
    const bad = await auth(request.put(`${base()}/${draftId}`)).send({ status: 'active' });
    expect(bad.status).toBe(400); // #3477: status is never edited through PUT
    const list = await auth(request.get('/training-plans?limit=50'));
    const row = list.body.items.find((r: any) => r.id === draftId);
    expect(row.draft_of_plan_id).toBe(planId);
  });

  it('is tenant scoped and unauthenticated requests are refused', async () => {
    expect((await auth(request.post(`${base()}/${planId}/edit-draft`), otherGymId)).status).toBe(404);
    expect((await request.post(`${base()}/${planId}/edit-draft`)).status).toBe(401);
  });

  it('publish-version ends the old version and activates the draft once', async () => {
    const { rows } = await db.query("SELECT id FROM training_plans WHERE draft_of_plan_id = ?", [planId]);
    const draftId = rows[0].id;
    const res = await auth(request.post(`${base()}/${draftId}/publish-version`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.end_date).toBeNull();
    const { rows: dates } = await db.query(
      "SELECT DATE_FORMAT(start_date, '%Y-%m-%d') AS s, (SELECT DATE_FORMAT(end_date, '%Y-%m-%d') FROM training_plans WHERE id = ?) AS prev_end FROM training_plans WHERE id = ?",
      [planId, draftId],
    );
    // "Today" is the gym's day (Europe/Madrid by default), not the database's: between 23:00 and
    // 24:00 UTC the two differ, which made this assertion fail for an hour every night.
    const today = gymToday(new Date(), 'Europe/Madrid');
    expect(dates[0].s).toBe(today);
    expect(dates[0].prev_end).toBe(previousDay(today));
    expect(res.body.name).toMatch(/^Strength \[\d{4}-\d{2}-\d{2} - Open End\]$/);
    const orig = await auth(request.get(`${base()}/${planId}`));
    expect(orig.body.status).toBe('completed');
    expect(orig.body.name).toMatch(/^Strength \[\d{4}-\d{2}-\d{2} - \d{4}-\d{2}-\d{2}\]$/);
    expect((await auth(request.post(`${base()}/${draftId}/publish-version`))).status).toBe(409);
    // #3547: the completed version is edited through a Draft copy, never reopened.
    expect((await auth(request.post(`${base()}/${planId}/edit-draft`))).status).toBe(201);
  });
});

describe('same-day edit of an assigned training plan (#3409)', () => {
  let gymId: string;
  let memberId: number;
  const base = () => `/members/${memberId}/training-plans`;
  const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

  beforeAll(async () => {
    gymId = await createTestGym('Same Day Edit Gym');
    await createTestMembership(gymId, 'admin');
    const m = await db.query(`INSERT INTO members (gym_id, name, email) VALUES (?, 'S Member', ?)`, [gymId, `s-${Date.now()}@test.com`]);
    memberId = m.insertId;
  });

  async function activePlan(startDate: string): Promise<number> {
    const ins = await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date) VALUES (?, ?, 'Today Plan', 'active', ?)`,
      [gymId, memberId, startDate],
    );
    return ins.insertId;
  }

  it('edits a plan that started on the gym\'s today in place: no draft, nothing ended or renamed', async () => {
    const { rows: g } = await db.query('SELECT time_zone FROM gyms WHERE id = ?', [gymId]);
    const today = gymToday(new Date(), g[0].time_zone ?? 'Europe/Madrid');
    const planId = await activePlan(today);
    const res = await auth(request.post(`${base()}/${planId}/edit-draft`));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(planId);
    expect(res.body.status).toBe('active');
    expect(res.body.draft_of_plan_id ?? null).toBeNull();
    const { rows: drafts } = await db.query('SELECT id FROM training_plans WHERE draft_of_plan_id = ?', [planId]);
    expect(drafts).toHaveLength(0);

    // Saving goes through the ordinary PUT and keeps the plan the same active version.
    const put = await auth(request.put(`${base()}/${planId}`)).send({ name: 'Today Plan', description: 'tweaked', status: 'active' });
    expect(put.status).toBe(200);
    const { rows } = await db.query(
      "SELECT status, name, description, end_date, DATE_FORMAT(start_date, '%Y-%m-%d') AS s FROM training_plans WHERE id = ?",
      [planId],
    );
    expect(rows[0]).toMatchObject({ status: 'active', name: 'Today Plan', description: 'tweaked', end_date: null, s: today });
  });

  it('keeps the draft workflow for a plan that started yesterday in the gym\'s time zone', async () => {
    const { rows: g } = await db.query('SELECT time_zone FROM gyms WHERE id = ?', [gymId]);
    const yesterday = previousDay(gymToday(new Date(), g[0].time_zone ?? 'Europe/Madrid'));
    const planId = await activePlan(yesterday);
    const res = await auth(request.post(`${base()}/${planId}/edit-draft`));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.draft_of_plan_id).toBe(planId);
  });
});
