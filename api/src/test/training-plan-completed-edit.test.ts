import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { gymToday } from '../domain/workoutProgress';
import { previousDay } from '../domain/trainingPlanVersioning';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

// #3547: Edit on a Completed Assigned Training Plan creates (or resumes) an independent Draft
// copy; the Completed record and its logs are never touched, and activating the copy replaces
// the member's active plan atomically.

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('editing a Completed Assigned Training Plan through a Draft copy (#3547)', () => {
  let gymId: string;
  let otherGymId: string;
  let memberId: number;
  let completedId: number;
  let activeId: number;
  let logId: number;
  const base = () => `/members/${memberId}/training-plans`;
  const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
  const today = () => gymToday(new Date(), 'Europe/Madrid');

  beforeAll(async () => {
    gymId = await createTestGym('Completed Edit Gym');
    otherGymId = await createTestGym('Completed Edit Other Gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');
    const m = await db.query(`INSERT INTO members (gym_id, name, email) VALUES (?, 'C Member', ?)`, [gymId, `c-${Date.now()}@test.com`]);
    memberId = m.insertId;

    // A plan that ran and was completed, with content and an execution log.
    const c = await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date) VALUES (?, ?, 'Hypertrophy', 'active', CURRENT_DATE - INTERVAL 60 DAY)`,
      [gymId, memberId],
    );
    completedId = c.insertId;
    const w = await auth(request.post(`${base()}/${completedId}/workouts`)).send({ name: 'Day 1' });
    expect(w.status).toBe(201);
    const b = await auth(request.post(`${base()}/${completedId}/workouts/${w.body.id}/blocks`)).send({ name: 'Main', type: 'Standard' });
    expect(b.status).toBe(201);
    const l = await db.query(
      `INSERT INTO workout_block_logs (gym_id, member_id, workout_block_id, logged_date) VALUES (?, ?, ?, CURRENT_DATE - INTERVAL 40 DAY)`,
      [gymId, memberId, b.body.id],
    );
    logId = l.insertId;
    const done = await auth(request.post(`${base()}/${completedId}/complete`)).send({ end_date: null });
    expect(done.status).toBe(200);
    await db.query(
      "UPDATE training_plans SET name = 'Hypertrophy [2026-01-01 - 2026-02-01]', end_date = CURRENT_DATE - INTERVAL 30 DAY WHERE id = ?",
      [completedId],
    );

    // The member's current active plan.
    const a = await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date) VALUES (?, ?, 'Current', 'active', CURRENT_DATE - INTERVAL 20 DAY)`,
      [gymId, memberId],
    );
    activeId = a.insertId;
    await db.query(
      `INSERT INTO member_training_plans (gym_id, member_id, training_plan_id, name, status, valid_from) VALUES (?, ?, ?, 'Current', 'active', CURRENT_DATE - INTERVAL 20 DAY)`,
      [gymId, memberId, activeId],
    );
  });

  async function completedSnapshot() {
    const { rows } = await db.query(
      "SELECT name, status, DATE_FORMAT(start_date, '%Y-%m-%d') AS s, DATE_FORMAT(end_date, '%Y-%m-%d') AS e, modified_at FROM training_plans WHERE id = ?",
      [completedId],
    );
    return rows[0];
  }

  it('creates a Draft copy with the content; the Completed plan stays as it was', async () => {
    const before = await completedSnapshot();
    const res = await auth(request.post(`${base()}/${completedId}/edit-draft`));
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(completedId);
    expect(res.body.status).toBe('draft');
    expect(res.body.name).toBe('Hypertrophy');
    expect(res.body.draft_of_plan_id).toBe(completedId);
    expect(res.body.workouts).toHaveLength(1);
    expect(res.body.workouts[0].blocks).toHaveLength(1);
    expect(await completedSnapshot()).toEqual(before);
  });

  it('resumes the same Draft instead of creating another one', async () => {
    const again = await auth(request.post(`${base()}/${completedId}/edit-draft`));
    expect(again.status).toBe(200);
    const { rows } = await db.query("SELECT COUNT(*) AS n FROM training_plans WHERE draft_of_plan_id = ? AND status = 'draft'", [completedId]);
    expect(Number(rows[0].n)).toBe(1);
    expect(again.body.id).toBe((await db.query('SELECT id FROM training_plans WHERE draft_of_plan_id = ?', [completedId])).rows[0].id);
  });

  it('the Completed plan itself stays read-only', async () => {
    const put = await auth(request.put(`${base()}/${completedId}`)).send({ name: 'Changed' });
    expect(put.status).toBe(403);
  });

  it('Save Draft keeps the copy a Draft and the active plan unchanged', async () => {
    const { rows } = await db.query('SELECT id FROM training_plans WHERE draft_of_plan_id = ?', [completedId]);
    const put = await auth(request.put(`${base()}/${rows[0].id}`)).send({ name: 'Hypertrophy v2', description: 'tweaked' });
    expect(put.status).toBe(200);
    expect(put.body.status).toBe('draft');
    const { rows: act } = await db.query('SELECT status, end_date FROM training_plans WHERE id = ?', [activeId]);
    expect(act[0].status).toBe('active');
    expect(act[0].end_date).toBeNull();
  });

  it('the activation preview names the active plan the copy replaces', async () => {
    const { rows } = await db.query('SELECT id FROM training_plans WHERE draft_of_plan_id = ?', [completedId]);
    const res = await auth(request.get(`${base()}/${rows[0].id}/activation`));
    expect(res.status).toBe(200);
    expect(res.body.current_plan).toEqual({ id: activeId, name: 'Current' });
    expect(res.body.start_date).toBe(today());
    expect(res.body.version_draft).toBe(false);
  });

  it('a failed activation leaves the active plan and the Draft as they were', async () => {
    const { rows } = await db.query('SELECT id FROM training_plans WHERE draft_of_plan_id = ?', [completedId]);
    const draftId = rows[0].id;
    await db.query('UPDATE training_plans SET end_date = CURRENT_DATE - INTERVAL 5 DAY WHERE id = ?', [draftId]);
    const res = await auth(request.post(`${base()}/${draftId}/activate`));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('end_before_start');
    const { rows: after } = await db.query('SELECT id, status FROM training_plans WHERE id IN (?, ?) ORDER BY id', [activeId, draftId]);
    expect(after.find((r: any) => r.id === activeId).status).toBe('active');
    expect(after.find((r: any) => r.id === draftId).status).toBe('draft');
    await db.query('UPDATE training_plans SET end_date = NULL WHERE id = ?', [draftId]);
  });

  it('Save & Activate activates the copy, completes the active plan the day before, and keeps history', async () => {
    const before = await completedSnapshot();
    const { rows } = await db.query('SELECT id FROM training_plans WHERE draft_of_plan_id = ?', [completedId]);
    const draftId = rows[0].id;
    const res = await auth(request.post(`${base()}/${draftId}/activate`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.draft_of_plan_id).toBeNull();
    expect(res.body.previous_plan_id).toBe(activeId);

    const { rows: plans } = await db.query(
      "SELECT id, status, DATE_FORMAT(start_date, '%Y-%m-%d') AS s, DATE_FORMAT(end_date, '%Y-%m-%d') AS e FROM training_plans WHERE id IN (?, ?)",
      [draftId, activeId],
    );
    const activated = plans.find((p: any) => p.id === draftId);
    const previous = plans.find((p: any) => p.id === activeId);
    expect(activated.s).toBe(today());
    expect(previous.status).toBe('completed');
    expect(previous.e).toBe(previousDay(today()));
    const { rows: actives } = await db.query("SELECT id FROM training_plans WHERE member_id = ? AND status = 'active'", [memberId]);
    expect(actives.map((r: any) => r.id)).toEqual([draftId]);
    const { rows: mtp } = await db.query(
      "SELECT training_plan_id FROM member_training_plans WHERE member_id = ? AND status = 'active'", [memberId]);
    expect(mtp.map((r: any) => r.training_plan_id)).toEqual([draftId]);

    // The source Completed plan and its execution log are untouched.
    expect(await completedSnapshot()).toEqual(before);
    const { rows: logs } = await db.query(
      'SELECT wb.workout_id, w.training_plan_id FROM workout_block_logs l JOIN workout_blocks wb ON wb.id = l.workout_block_id JOIN workouts w ON w.id = wb.workout_id WHERE l.id = ?',
      [logId],
    );
    expect(logs[0].training_plan_id).toBe(completedId);
  });

  it('refuses a deleted or draft source and is tenant scoped', async () => {
    const d = await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date) VALUES (?, ?, 'Draft', 'draft', CURRENT_DATE)`,
      [gymId, memberId],
    );
    expect((await auth(request.post(`${base()}/${d.insertId}/edit-draft`))).status).toBe(409);
    expect((await auth(request.post(`${base()}/${completedId}/edit-draft`), otherGymId)).status).toBe(404);
    expect((await request.post(`${base()}/${completedId}/edit-draft`)).status).toBe(401);
  });
});
