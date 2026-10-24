// #1850 — Import System Personal Goals: gym creation seeds every live Base
// Personal Goal as a gym-owned goal that records its template, and
// `GET /personal-goals/base` + `POST /personal-goals/import` import templates
// without duplicates, without touching existing goals and without leaking
// across gyms.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { seedDefaultGymPersonalGoals } from '../api/gym-default-personal-goals';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  allocateTestBaseGoalId,
  createTestMembership,
  request,
} from './helpers';

const NAME_A = 'Import Test Goal Alpha';
const NAME_B = 'Import Test Goal Beta';
let baseA: number;
let baseB: number;

afterAll(async () => {
  await cleanupTestGyms();
  await db.query('DELETE FROM base_personal_goals WHERE id IN (?, ?)', [baseA, baseB]);
  await db.end();
});

const auth = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });

describe('Import System Personal Goals', () => {
  let gymId: string;
  let otherGym: string;
  let readOnlyGym: string;

  beforeAll(async () => {
    const insert = async (name: string, value: number | null, unit: string | null) => {
      const insertId = await allocateTestBaseGoalId();
      await db.query(
        `INSERT INTO base_personal_goals (id, name, description, target_value, target_unit, target_type, created_by)
         VALUES (?, ?, 'Template description', ?, ?, 'relative', 'System')`,
        [insertId, name, value, unit],
      );
      await db.query(
        `INSERT INTO base_personal_goal_translations (base_personal_goal_id, locale, name, description)
         VALUES (?, 'es', ?, 'Descripción')`,
        [insertId, `${name} ES`],
      );
      return insertId;
    };
    baseA = await insert(NAME_A, 5, 'kg');
    baseB = await insert(NAME_B, null, null);

    gymId = await createTestGym('Import Goals Gym');
    await createTestMembership(gymId, 'admin');
    otherGym = await createTestGym('Import Goals Other Gym');
    await createTestMembership(otherGym, 'admin');
    readOnlyGym = await createTestGym('Import Goals Accountant Gym');
    await createTestMembership(readOnlyGym, 'accountant');
  });

  it('gym creation seeds every live template, records provenance, and is safe to re-run', async () => {
    const seeded = await createTestGym('Import Goals Seeded Gym');
    await seedDefaultGymPersonalGoals(seeded);
    const { rows: templates } = await db.query<any>('SELECT id FROM base_personal_goals WHERE deleted_at IS NULL');
    const { rows } = await db.query<any>(
      'SELECT * FROM personal_goals WHERE gym_id = ? AND base_personal_goal_id IS NOT NULL',
      [seeded],
    );
    expect(rows.map((r: any) => r.base_personal_goal_id).sort()).toEqual(templates.map((t: any) => t.id).sort());
    const alpha = rows.find((r: any) => r.base_personal_goal_id === baseA);
    expect(alpha).toMatchObject({ name: NAME_A, gym_id: seeded, slug: null, target_unit: 'kg', target_type: 'relative', status: 'active' });
    expect(Number(alpha.target_value)).toBe(5);
    const { rows: tr } = await db.query<any>(
      'SELECT name FROM personal_goal_translations WHERE personal_goal_id = ? AND locale = ?', [alpha.id, 'es']);
    expect(tr[0].name).toBe(`${NAME_A} ES`);
    const { rows: avail } = await db.query<any>(
      'SELECT status FROM gym_personal_goals WHERE gym_id = ? AND personal_goal_id = ?', [seeded, alpha.id]);
    expect(avail[0].status).toBe('active');

    await seedDefaultGymPersonalGoals(seeded);
    const { rows: again } = await db.query<any>('SELECT id FROM personal_goals WHERE gym_id = ?', [seeded]);
    expect(again).toHaveLength(rows.length);
  });

  it('requires auth and an admin', async () => {
    expect((await request.get('/personal-goals/base').set('x-gym-id', gymId)).status).toBe(401);
    const ro = await request.get('/personal-goals/base').set(auth(readOnlyGym));
    expect(ro.status).toBe(403);
    const roPost = await request.post('/personal-goals/import').set(auth(readOnlyGym))
      .send({ base_personal_goal_ids: [baseA] });
    expect(roPost.status).toBe(403);
  });

  it('lists live templates as not imported and filters by name', async () => {
    const res = await request.get('/personal-goals/base').set(auth(gymId));
    expect(res.status).toBe(200);
    const a = res.body.find((r: any) => r.id === baseA);
    expect(a).toMatchObject({ name: NAME_A, target_value: 5, target_unit: 'kg', imported: false, imported_personal_goal_id: null });
    const filtered = await request.get('/personal-goals/base?q=Import Test Goal Beta').set(auth(gymId));
    expect(filtered.body.map((r: any) => r.id)).toEqual([baseB]);
  });

  it('validates the import body', async () => {
    for (const body of [{}, { base_personal_goal_ids: [] }, { base_personal_goal_ids: ['a'] }, { base_personal_goal_ids: [0] }]) {
      const res = await request.post('/personal-goals/import').set(auth(gymId)).send(body);
      expect(res.status).toBe(400);
    }
  });

  it('imports the selection as gym-owned goals once, and marks them', async () => {
    const res = await request.post('/personal-goals/import').set(auth(gymId)).send({ base_personal_goal_ids: [baseA] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ imported: [baseA], skipped: [] });

    const again = await request.post('/personal-goals/import').set(auth(gymId)).send({ base_personal_goal_ids: [baseA, baseB] });
    expect(again.body).toEqual({ imported: [baseB], skipped: [baseA] });

    const { rows } = await db.query<any>(
      'SELECT id FROM personal_goals WHERE gym_id = ? AND base_personal_goal_id IN (?, ?)', [gymId, baseA, baseB]);
    expect(rows).toHaveLength(2);

    const list = await request.get('/personal-goals/base').set(auth(gymId));
    const a = list.body.find((r: any) => r.id === baseA);
    expect(a.imported).toBe(true);
    expect(a.imported_personal_goal_id).toBeTypeOf('number');

    const goals = await request.get('/personal-goals?limit=200').set(auth(gymId));
    const imported = goals.body.items.find((g: any) => g.name === NAME_A && g.gym_id === gymId);
    expect(imported).toMatchObject({ gym_id: gymId, is_system: true, base_personal_goal_id: baseA });
  });

  it('concurrent imports create it once', async () => {
    const gym = await createTestGym('Import Goals Concurrent Gym');
    await createTestMembership(gym, 'admin');
    await Promise.all([1, 2, 3].map(() =>
      request.post('/personal-goals/import').set(auth(gym)).send({ base_personal_goal_ids: [baseA] })));
    const { rows } = await db.query<any>(
      'SELECT id FROM personal_goals WHERE gym_id = ? AND base_personal_goal_id = ?', [gym, baseA]);
    expect(rows).toHaveLength(1);
  });

  it('keeps gym edits and deletions: a re-import neither overwrites nor resurrects', async () => {
    const { rows } = await db.query<any>(
      'SELECT id FROM personal_goals WHERE gym_id = ? AND base_personal_goal_id = ?', [gymId, baseA]);
    const goalId = rows[0].id;
    const put = await request.put(`/personal-goals/${goalId}`).set(auth(gymId)).send({ name: 'My renamed goal', description: 'mine' });
    expect(put.status).toBe(200);

    await request.post('/personal-goals/import').set(auth(gymId)).send({ base_personal_goal_ids: [baseA] });
    const { rows: after } = await db.query<any>('SELECT name, status FROM personal_goals WHERE id = ?', [goalId]);
    expect(after[0]).toMatchObject({ name: 'My renamed goal', status: 'active' });
    const { rows: base } = await db.query<any>('SELECT name FROM base_personal_goals WHERE id = ?', [baseA]);
    expect(base[0].name).toBe(NAME_A);

    expect((await request.delete(`/personal-goals/${goalId}`).set(auth(gymId))).status).toBe(204);
    const re = await request.post('/personal-goals/import').set(auth(gymId)).send({ base_personal_goal_ids: [baseA] });
    expect(re.body.imported).toEqual([]);
    const { rows: still } = await db.query<any>('SELECT status FROM personal_goals WHERE id = ?', [goalId]);
    expect(still[0].status).toBe('deleted');
  });

  it('is isolated between gyms', async () => {
    const { rows } = await db.query<any>(
      'SELECT id FROM personal_goals WHERE gym_id = ? AND base_personal_goal_id = ?', [otherGym, baseA]);
    expect(rows).toHaveLength(0);
    const list = await request.get('/personal-goals/base').set(auth(otherGym));
    expect(list.body.find((r: any) => r.id === baseA).imported).toBe(false);
  });

  it('ignores a template that does not exist or is deleted', async () => {
    const res = await request.post('/personal-goals/import').set(auth(otherGym)).send({ base_personal_goal_ids: [999999999] });
    expect(res.body).toEqual({ imported: [], skipped: [999999999] });
  });
});
