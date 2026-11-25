// #3334 stage 1: System Training Plan Templates imported into a gym, resynced,
// the gym list scoped to the gym's own templates, and num_days (0..7).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let otherGymId: string;
let roGymId: string;
let baseId: number;
let secondBaseId: number;
let inactiveBaseId: number;
let baseWorkoutId: number;
const baseIds: number[] = [];
const stamp = Date.now();

const as = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });

async function insertBase(name: string, status = 'active', numDays = 3): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO training_plan_templates (gym_id, name, description, num_days, status) VALUES (NULL, ?, ?, ?, ?)',
    [name, `${name} description`, numDays, status],
  );
  baseIds.push(insertId);
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('TPT Import Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('TPT Import Other Gym');
  await createTestMembership(otherGymId, 'admin');
  roGymId = await createTestGym('TPT Import Read-only Gym');
  await createTestMembership(roGymId, 'front_desk');

  baseId = await insertBase(`TPT Import Base ${stamp}`);
  secondBaseId = await insertBase(`TPT Import Base Two ${stamp}`, 'active', 5);
  inactiveBaseId = await insertBase(`TPT Import Inactive ${stamp}`, 'inactive');

  const { insertId: wt } = await db.query(
    "INSERT INTO workout_templates (gym_id, name, status) VALUES (NULL, ?, 'active')",
    [`TPT Import Workout ${stamp}`],
  );
  baseWorkoutId = wt;
  await db.query(
    `INSERT INTO training_plan_template_workouts (gym_id, training_plan_template_id, workout_template_id, position, scheduled_weekday)
     VALUES (NULL, ?, ?, 1, 1), (NULL, ?, ?, 2, 3)`,
    [baseId, baseWorkoutId, baseId, baseWorkoutId],
  );
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.query(
    `DELETE FROM training_plan_template_workouts WHERE training_plan_template_id IN (${baseIds.map(() => '?').join(',')})`,
    baseIds,
  );
  await db.query(`DELETE FROM training_plan_templates WHERE id IN (${baseIds.map(() => '?').join(',')})`, baseIds);
  await db.query('DELETE FROM workout_templates WHERE id = ?', [baseWorkoutId]);
  await db.end();
});

describe('GET /training-plan-templates/base', () => {
  it('lists active System templates with their import state', async () => {
    const res = await request.get('/training-plan-templates/base').set(as(gymId));
    expect(res.status).toBe(200);
    const row = res.body.find((t: any) => t.id === baseId);
    expect(row).toMatchObject({ name: `TPT Import Base ${stamp}`, num_days: 3, imported_template_id: null });
    expect(Number(row.workout_count)).toBe(2);
    expect(res.body.find((t: any) => t.id === inactiveBaseId)).toBeUndefined();
  });

  it('narrows by name for the Import modal search (#3334 stage 2)', async () => {
    const res = await request.get(`/training-plan-templates/base?name=${encodeURIComponent(`Base Two ${stamp}`)}`).set(as(gymId));
    expect(res.status).toBe(200);
    expect(res.body.map((t: any) => t.id)).toEqual([secondBaseId]);
  });

  it('requires auth', async () => {
    expect((await request.get('/training-plan-templates/base')).status).toBe(401);
  });
});

describe('POST /training-plan-templates/import', () => {
  let copyId: number;

  it('refuses an empty list, a bad id and a non-importable id', async () => {
    expect((await request.post('/training-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: [] })).status).toBe(400);
    expect((await request.post('/training-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: ['x'] })).status).toBe(400);
    const res = await request.post('/training-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: [baseId, inactiveBaseId] });
    expect(res.status).toBe(400);
    expect(res.body.invalid_ids).toEqual([inactiveBaseId]);
    const own = await request.post('/training-plan-templates').set(as(gymId)).send({ name: `TPT Own ${stamp}` });
    const r2 = await request.post('/training-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: [own.body.id] });
    expect(r2.status).toBe(400);
    // Nothing was imported by the refused batch.
    const { rows } = await db.query('SELECT 1 FROM training_plan_templates WHERE gym_id = ? AND cloned_from_id = ?', [gymId, baseId]);
    expect(rows).toHaveLength(0);
  });

  it('refuses a read-only role', async () => {
    const res = await request.post('/training-plan-templates/import').set(as(roGymId)).send({ baseTemplateIds: [baseId] });
    expect(res.status).toBe(403);
  });

  it('creates an active gym copy that records its System source, workouts included', async () => {
    const res = await request.post('/training-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: [baseId] });
    expect(res.status).toBe(201);
    expect(res.body.skipped).toEqual([]);
    expect(res.body.imported).toHaveLength(1);
    copyId = res.body.imported[0];
    const { rows } = await db.query<any>('SELECT * FROM training_plan_templates WHERE id = ?', [copyId]);
    expect(rows[0]).toMatchObject({ gym_id: gymId, name: `TPT Import Base ${stamp}`, status: 'active', num_days: 3, cloned_from_id: baseId });
    const { rows: links } = await db.query<any>(
      'SELECT gym_id, workout_template_id, position, scheduled_weekday FROM training_plan_template_workouts WHERE training_plan_template_id = ? ORDER BY position',
      [copyId],
    );
    // #3337: the import cascades, so the links name the gym's own copy of the
    // System Workout Template, never the System one.
    const gymWorkoutId = res.body.workout_templates.created[0];
    const { rows: wt } = await db.query<any>('SELECT gym_id, cloned_from_id FROM workout_templates WHERE id = ?', [gymWorkoutId]);
    expect(wt[0]).toMatchObject({ gym_id: gymId, cloned_from_id: baseWorkoutId });
    expect(links).toEqual([
      { gym_id: gymId, workout_template_id: gymWorkoutId, position: 1, scheduled_weekday: 1 },
      { gym_id: gymId, workout_template_id: gymWorkoutId, position: 2, scheduled_weekday: 3 },
    ]);
  });

  it('skips a template the gym already has, and the base list reports the copy', async () => {
    const res = await request.post('/training-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: [baseId, secondBaseId] });
    expect(res.status).toBe(201);
    expect(res.body.skipped).toEqual([baseId]);
    expect(res.body.imported).toHaveLength(1);
    const base = await request.get('/training-plan-templates/base').set(as(gymId));
    expect(base.body.find((t: any) => t.id === baseId).imported_template_id).toBe(copyId);
    // Another gym's import state is its own.
    const other = await request.get('/training-plan-templates/base').set(as(otherGymId));
    expect(other.body.find((t: any) => t.id === baseId).imported_template_id).toBeNull();
  });

  it('lists only the gym\'s own templates, each with a derived source', async () => {
    const res = await request.get('/training-plan-templates?limit=100').set(as(gymId));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.id);
    expect(ids).not.toContain(baseId);
    expect(res.body.items.every((t: any) => t.gym_id === gymId)).toBe(true);
    expect(res.body.items.find((t: any) => t.id === copyId).source).toBe('system');
    expect(res.body.items.find((t: any) => t.name === `TPT Own ${stamp}`).source).toBe('custom');
  });

  describe('POST /:id/resync-with-system', () => {
    it('moves name, description and num_days and keeps the workouts', async () => {
      await db.query(
        "UPDATE training_plan_templates SET name = ?, description = 'Updated', num_days = 4 WHERE id = ?",
        [`TPT Import Base Renamed ${stamp}`, baseId],
      );
      await db.query('DELETE FROM training_plan_template_workouts WHERE training_plan_template_id = ? AND position = 2', [baseId]);
      const res = await request.post(`/training-plan-templates/${copyId}/resync-with-system`).set(as(gymId));
      expect(res.status).toBe(200);
      expect(res.body.updated.sort()).toEqual(['description', 'name', 'num_days']);
      expect(res.body.template).toMatchObject({ name: `TPT Import Base Renamed ${stamp}`, description: 'Updated', num_days: 4, source: 'system' });
      const { rows } = await db.query('SELECT 1 FROM training_plan_template_workouts WHERE training_plan_template_id = ?', [copyId]);
      expect(rows).toHaveLength(2);
      const again = await request.post(`/training-plan-templates/${copyId}/resync-with-system`).set(as(gymId));
      expect(again.body).toEqual({ updated: [], message: 'up_to_date' });
    });

    it('refuses a custom template, a taken name and a missing System template', async () => {
      const own = await request.get('/training-plan-templates?limit=100').set(as(gymId));
      const ownId = own.body.items.find((t: any) => t.name === `TPT Own ${stamp}`).id;
      const r1 = await request.post(`/training-plan-templates/${ownId}/resync-with-system`).set(as(gymId));
      expect(r1.status).toBe(400);
      expect(r1.body.code).toBe('no_base_template');

      await db.query('UPDATE training_plan_templates SET name = ? WHERE id = ?', [`TPT Own ${stamp}`, baseId]);
      const r2 = await request.post(`/training-plan-templates/${copyId}/resync-with-system`).set(as(gymId));
      expect(r2.status).toBe(409);
      expect(r2.body.code).toBe('name_taken');

      await db.query("UPDATE training_plan_templates SET status = 'deleted' WHERE id = ?", [baseId]);
      const r3 = await request.post(`/training-plan-templates/${copyId}/resync-with-system`).set(as(gymId));
      expect(r3.status).toBe(409);
      expect(r3.body.code).toBe('base_unavailable');
    });

    it('answers 404 for another gym\'s copy', async () => {
      const res = await request.post(`/training-plan-templates/${copyId}/resync-with-system`).set(as(otherGymId));
      expect(res.status).toBe(404);
    });
  });
});

describe('num_days', () => {
  it('is validated on create and update, and an absent value keeps the stored one', async () => {
    for (const bad of [8, -1, 2.5, '3', null]) {
      const r = await request.post('/training-plan-templates').set(as(gymId)).send({ name: `TPT Days bad ${stamp}`, num_days: bad });
      expect(r.status).toBe(400);
    }
    const created = await request.post('/training-plan-templates').set(as(gymId)).send({ name: `TPT Days ${stamp}`, num_days: 7 });
    expect(created.status).toBe(201);
    expect(created.body.num_days).toBe(7);
    const kept = await request.put(`/training-plan-templates/${created.body.id}`).set(as(gymId)).send({ description: 'x' });
    expect(kept.body.num_days).toBe(7);
    const changed = await request.put(`/training-plan-templates/${created.body.id}`).set(as(gymId)).send({ num_days: 0 });
    expect(changed.body.num_days).toBe(0);
    expect((await request.put(`/training-plan-templates/${created.body.id}`).set(as(gymId)).send({ num_days: 9 })).status).toBe(400);
    const dup = await request.post(`/training-plan-templates/${created.body.id}/duplicate`).set(as(gymId));
    expect(dup.status).toBe(201);
    expect(dup.body).toMatchObject({ num_days: 0, source: 'custom' });
  });

  it('is held to 0..7 by the database', async () => {
    await expect(
      db.query('INSERT INTO training_plan_templates (gym_id, name, num_days) VALUES (?, ?, 8)', [gymId, `TPT Days DB ${stamp}`]),
    ).rejects.toThrow();
  });

});
