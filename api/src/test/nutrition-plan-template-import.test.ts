// #3333 stage 1: System Nutrition Plan Templates imported into a gym, resynced,
// and the template's num_days (0..7).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let otherGymId: string;
let baseId: number;
let secondBaseId: number;
let inactiveBaseId: number;
const baseIds: number[] = [];
const stamp = Date.now();

const as = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });

async function insertBase(name: string, status = 'active', numDays = 3): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO nutrition_plan_templates (gym_id, name, description, num_days, status) VALUES (NULL, ?, ?, ?, ?)',
    [name, `${name} description`, numDays, status],
  );
  baseIds.push(insertId);
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('NPT Import Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('NPT Import Other Gym');
  await createTestMembership(otherGymId, 'admin');

  baseId = await insertBase(`NPT Import Base ${stamp}`);
  secondBaseId = await insertBase(`NPT Import Base Two ${stamp}`, 'active', 5);
  inactiveBaseId = await insertBase(`NPT Import Inactive ${stamp}`, 'inactive');

  // Content on the System template so the deep copy is exercised.
  const { insertId: dayId } = await db.query(
    'INSERT INTO nutrition_plan_template_days (gym_id, nutrition_plan_template_id, weekday, position) VALUES (NULL, ?, 1, 1)',
    [baseId],
  );
  const { rows: meal } = await db.query<{ id: number; slug: string }>('SELECT id, slug FROM base_meals ORDER BY id LIMIT 1');
  await db.query(
    'INSERT INTO nutrition_plan_template_meals (gym_id, nutrition_plan_template_day_id, meal_type, base_meal_id, display_name, position) VALUES (NULL, ?, ?, ?, ?, 1)',
    [dayId, meal[0].slug, meal[0].id, 'Breakfast'],
  );
  await db.query(
    "INSERT INTO nutrition_plan_template_goals (gym_id, nutrition_plan_template_id, item_name, quantity, unit, frequency, applies_all_days, position) VALUES (NULL, ?, 'water', 2, 'l', 'daily', 1, 1)",
    [baseId],
  );
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.query(
    `DELETE FROM nutrition_plan_templates WHERE id IN (${baseIds.map(() => '?').join(',')})`,
    baseIds,
  );
  await db.end();
});

describe('GET /nutrition-plan-templates/base', () => {
  it('lists active System templates with their import state', async () => {
    const res = await request.get('/nutrition-plan-templates/base').set(as(gymId));
    expect(res.status).toBe(200);
    const row = res.body.find((t: any) => t.id === baseId);
    expect(row).toMatchObject({ name: `NPT Import Base ${stamp}`, num_days: 3, imported_template_id: null });
    expect(res.body.find((t: any) => t.id === inactiveBaseId)).toBeUndefined();
  });

  it('requires auth', async () => {
    expect((await request.get('/nutrition-plan-templates/base')).status).toBe(401);
  });
});

describe('POST /nutrition-plan-templates/import', () => {
  let copyId: number;

  it('refuses an empty list, a bad id, and a non-importable id', async () => {
    expect((await request.post('/nutrition-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: [] })).status).toBe(400);
    expect((await request.post('/nutrition-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: ['x'] })).status).toBe(400);
    const res = await request.post('/nutrition-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: [baseId, inactiveBaseId] });
    expect(res.status).toBe(400);
    expect(res.body.invalid_ids).toEqual([inactiveBaseId]);
    // A gym's own template is not importable either.
    const own = await request.post('/nutrition-plan-templates').set(as(gymId)).send({ name: `NPT Own ${stamp}` });
    const r2 = await request.post('/nutrition-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: [own.body.id] });
    expect(r2.status).toBe(400);
  });

  it('creates a gym-owned deep copy that records its System source', async () => {
    const res = await request.post('/nutrition-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: [baseId] });
    expect(res.status).toBe(201);
    expect(res.body.skipped).toEqual([]);
    expect(res.body.imported).toHaveLength(1);
    const copy = res.body.imported[0];
    copyId = copy.id;
    expect(copy).toMatchObject({
      gym_id: gymId, name: `NPT Import Base ${stamp}`, num_days: 3, status: 'active',
      cloned_from_id: baseId, source: 'system', owner_type: 'gym', day_count: 1,
    });

    const h = await request.get(`/nutrition-plan-templates/${copyId}/hierarchy`).set(as(gymId));
    expect(h.status).toBe(200);
    expect(h.body.days[0].meals).toHaveLength(1);
    expect(h.body.goals[0].item_name).toBe('water');
    // The copy's rows are the gym's, not the System template's.
    const { rows } = await db.query('SELECT gym_id FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ?', [copyId]);
    expect((rows[0] as any).gym_id).toBe(gymId);
  });

  it('skips a template the gym already imported and reports the import state', async () => {
    const res = await request.post('/nutrition-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: [baseId] });
    expect(res.status).toBe(200);
    expect(res.body.imported).toEqual([]);
    expect(res.body.skipped).toEqual([expect.objectContaining({ id: baseId, reason: 'already_imported', template_id: copyId })]);

    const list = await request.get('/nutrition-plan-templates/base').set(as(gymId));
    expect(list.body.find((t: any) => t.id === baseId).imported_template_id).toBe(copyId);
    // Another gym's import state is its own.
    const other = await request.get('/nutrition-plan-templates/base').set(as(otherGymId));
    expect(other.body.find((t: any) => t.id === baseId).imported_template_id).toBeNull();
  });

  it('the gym list shows the imported copy as system-sourced and custom templates as custom', async () => {
    const res = await request.get('/nutrition-plan-templates?limit=100').set(as(gymId));
    expect(res.status).toBe(200);
    const copy = res.body.items.find((t: any) => t.id === copyId);
    expect(copy.source).toBe('system');
    expect(res.body.items.find((t: any) => t.name === `NPT Own ${stamp}`).source).toBe('custom');
    expect(res.body.items.every((t: any) => t.owner_type === 'gym')).toBe(true);
  });

  it('cannot be written by a read-only role', async () => {
    const gym = await createTestGym('NPT Import RO Gym');
    await createTestMembership(gym, 'member');
    const res = await request.post('/nutrition-plan-templates/import').set(as(gym)).send({ baseTemplateIds: [secondBaseId] });
    expect(res.status).toBe(403);
  });
});

describe('POST /nutrition-plan-templates/:id/resync-with-system', () => {
  it('moves name, description and num_days from the System template and leaves content alone', async () => {
    const imp = await request.post('/nutrition-plan-templates/import').set(as(otherGymId)).send({ baseTemplateIds: [baseId] });
    const copyId = imp.body.imported[0].id;
    // The gym edits its copy's content; the System template changes its fields.
    await request.put(`/nutrition-plan-templates/${copyId}`).set(as(otherGymId)).send({ name: `Edited ${stamp}`, num_days: 7 });
    const day = await request.post(`/nutrition-plan-templates/${copyId}/days`).set(as(otherGymId)).send({ weekday: 2 });
    expect(day.status).toBe(201);
    await db.query('UPDATE nutrition_plan_templates SET description = ?, num_days = 4 WHERE id = ?', ['New System text', baseId]);

    const res = await request.post(`/nutrition-plan-templates/${copyId}/resync-with-system`).set(as(otherGymId));
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(['name', 'description', 'num_days']);
    expect(res.body.template).toMatchObject({ name: `NPT Import Base ${stamp}`, description: 'New System text', num_days: 4 });
    expect(res.body.template.day_count).toBe(2);

    const again = await request.post(`/nutrition-plan-templates/${copyId}/resync-with-system`).set(as(otherGymId));
    expect(again.body).toEqual({ updated: [], message: 'up_to_date' });
  });

  it('refuses a custom template, another gym\'s copy and a removed System template', async () => {
    const own = await request.post('/nutrition-plan-templates').set(as(gymId)).send({ name: `NPT Resync Own ${stamp}` });
    const r1 = await request.post(`/nutrition-plan-templates/${own.body.id}/resync-with-system`).set(as(gymId));
    expect(r1.status).toBe(400);
    expect(r1.body.code).toBe('no_base_template');

    const imp = await request.post('/nutrition-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: [secondBaseId] });
    const copyId = imp.body.imported[0].id;
    expect((await request.post(`/nutrition-plan-templates/${copyId}/resync-with-system`).set(as(otherGymId))).status).toBe(404);

    await db.query("UPDATE nutrition_plan_templates SET status = 'deleted' WHERE id = ?", [secondBaseId]);
    const r3 = await request.post(`/nutrition-plan-templates/${copyId}/resync-with-system`).set(as(gymId));
    expect(r3.status).toBe(409);
    expect(r3.body.code).toBe('base_unavailable');
  });
});

describe('num_days', () => {
  it('defaults to 0 and accepts integers 0..7 only, on create and update', async () => {
    const created = await request.post('/nutrition-plan-templates').set(as(gymId)).send({ name: `NPT Days ${stamp}` });
    expect(created.status).toBe(201);
    expect(created.body.num_days).toBe(0);
    for (const bad of [8, -1, 2.5, '3', null]) {
      const r = await request.post('/nutrition-plan-templates').set(as(gymId)).send({ name: `NPT Bad ${stamp} ${String(bad)}`, num_days: bad });
      expect(r.status).toBe(400);
      const u = await request.put(`/nutrition-plan-templates/${created.body.id}`).set(as(gymId)).send({ num_days: bad });
      expect(u.status).toBe(400);
    }
    const ok = await request.put(`/nutrition-plan-templates/${created.body.id}`).set(as(gymId)).send({ num_days: 7 });
    expect(ok.body.num_days).toBe(7);
    // A write that does not mention it keeps it.
    const keep = await request.put(`/nutrition-plan-templates/${created.body.id}`).set(as(gymId)).send({ description: 'x' });
    expect(keep.body.num_days).toBe(7);
  });

  it('is enforced by the database', async () => {
    await expect(
      db.query("INSERT INTO nutrition_plan_templates (gym_id, name, num_days) VALUES (?, ?, 8)", [gymId, `NPT Check ${stamp}`]),
    ).rejects.toThrow();
  });
});
