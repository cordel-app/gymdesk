// #3403: Assigned Nutrition Plans and Assigned Training Plans always carry a
// start date, an ended plan carries an end date, and the Training Plans list
// reports the plan's days.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const backfill = require('../infra/migrations/487_assigned_plan_dates_backfill.js');
const knexLike = { raw: (sql: string) => db.query(sql) };

let gymId: string;
let memberId: number;

beforeAll(async () => {
  gymId = await createTestGym('Assigned Plan Dates Gym');
  await createTestMembership(gymId, 'admin');
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Dates Member', ?)`,
    [gymId, `dates-${Date.now()}@test.com`],
  );
  memberId = insertId;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function insertNutritionPlan(status: string, startDate: string | null, endDate: string | null, modifiedAt: string | null) {
  const { insertId } = await db.query(
    `INSERT INTO member_nutrition_plans (gym_id, member_id, name, start_date, end_date, status, created_by, created_at, modified_at)
     VALUES (?, ?, 'Plan', ?, ?, ?, 'test', '2026-01-10 09:00:00', ?)`,
    [gymId, memberId, startDate, endDate, status, modifiedAt],
  );
  return insertId as number;
}

describe('PUT /member-nutrition-plans/:id start_date', () => {
  it('refuses clearing the start date and keeps the stored one', async () => {
    const id = await insertNutritionPlan('active', '2026-02-01', null, null);
    const res = await request.put(`/member-nutrition-plans/${id}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ start_date: null });
    expect(res.status).toBe(400);
    const { rows } = await db.query<any>('SELECT DATE_FORMAT(start_date, "%Y-%m-%d") AS d FROM member_nutrition_plans WHERE id = ?', [id]);
    expect(rows[0].d).toBe('2026-02-01');
  });

  it('accepts a new start date', async () => {
    // #3405: only a plan not yet effective before today is edited in place.
    const id = await insertNutritionPlan('active', '2099-02-01', null, null);
    const res = await request.put(`/member-nutrition-plans/${id}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ start_date: '2099-03-05' });
    expect(res.status).toBe(200);
    const { rows } = await db.query<any>('SELECT DATE_FORMAT(start_date, "%Y-%m-%d") AS d FROM member_nutrition_plans WHERE id = ?', [id]);
    expect(rows[0].d).toBe('2099-03-05');
  });
});

describe('GET /training-plans', () => {
  it('reports day_count and sorts by end_date', async () => {
    const { insertId: a } = await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date, end_date, created_by)
       VALUES (?, ?, 'Ended A', 'completed', '2026-01-01', '2026-02-01', 'test')`, [gymId, memberId]);
    const { insertId: b } = await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date, end_date, created_by)
       VALUES (?, ?, 'Ended B', 'completed', '2026-01-01', '2026-03-01', 'test')`, [gymId, memberId]);
    for (const day of [1, 3]) {
      await db.query(
        'INSERT INTO workouts (gym_id, training_plan_id, name, position, scheduled_weekday) VALUES (?, ?, ?, ?, ?)',
        [gymId, b, `W${day}`, day, day],
      );
    }
    const res = await request.get('/training-plans?sort=end_date&dir=desc&status=completed')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((r: any) => r.id);
    expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(a));
    const rowB = res.body.items.find((r: any) => r.id === b);
    const rowA = res.body.items.find((r: any) => r.id === a);
    expect(Number(rowB.day_count)).toBe(2);
    expect(Number(rowA.day_count)).toBe(0);
  });
});

describe('migration 487 backfill', () => {
  it('gives every plan a start date and every ended plan an end date, and leaves running plans open-ended', async () => {
    const noStart = await insertNutritionPlan('active', null, null, null);
    const completed = await insertNutritionPlan('completed', '2026-01-10', null, '2026-04-02 12:00:00');
    const active = await insertNutritionPlan('active', '2026-01-10', null, '2026-04-02 12:00:00');
    const { insertId: expired } = await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date, end_date, created_by, modified_at)
       VALUES (?, ?, 'Expired', 'expired', '2026-05-01', NULL, 'test', '2026-04-20 10:00:00')`, [gymId, memberId]);
    const { insertId: running } = await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date, created_by)
       VALUES (?, ?, 'Running', 'active', '2026-05-01', 'test')`, [gymId, memberId]);

    await backfill.up(knexLike);
    await backfill.up(knexLike); // idempotent

    const nut = async (id: number) => (await db.query<any>(
      'SELECT DATE_FORMAT(start_date, "%Y-%m-%d") AS s, DATE_FORMAT(end_date, "%Y-%m-%d") AS e FROM member_nutrition_plans WHERE id = ?', [id])).rows[0];
    const tp = async (id: number) => (await db.query<any>(
      'SELECT DATE_FORMAT(end_date, "%Y-%m-%d") AS e FROM training_plans WHERE id = ?', [id])).rows[0];

    expect(await nut(noStart)).toEqual({ s: '2026-01-10', e: null });
    expect(await nut(completed)).toEqual({ s: '2026-01-10', e: '2026-04-02' });
    expect(await nut(active)).toEqual({ s: '2026-01-10', e: null });
    // Never before its own start.
    expect((await tp(expired)).e).toBe('2026-05-01');
    expect((await tp(running)).e).toBeNull();
  });
});
