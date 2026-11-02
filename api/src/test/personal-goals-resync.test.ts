// #2258 — "Resync with System" syncs name, description and their translations from the
// originating Base Personal Goal (image only while the copy has none) and nothing else.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, allocateTestBaseGoalId, createTestMembership, request,
} from './helpers';

const NAME = `Resync Goal ${Date.now()}`;
let base: number;
let gymA: string;
let gymB: string;
let copyId: number;
let ownId: number;
let memberId: number;

const as = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });
const url = (id: number) => `/personal-goals/${id}/resync-with-system`;

beforeAll(async () => {
  base = await allocateTestBaseGoalId();
  await db.query(
    "INSERT INTO base_personal_goals (id, name, description, target_value, target_unit, target_type, created_by) VALUES (?, ?, 'v1', 5, 'kg', 'absolute', 'System')",
    [base, NAME],
  );
  await db.query(
    "INSERT INTO base_personal_goal_translations (base_personal_goal_id, locale, name, description) VALUES (?, 'es', 'Meta ES', 'desc es')",
    [base],
  );
  gymA = await createTestGym('Resync A');
  await createTestMembership(gymA, 'admin');
  gymB = await createTestGym('Resync B');
  await createTestMembership(gymB, 'admin');
  const imp = await request.post('/personal-goals/import').set(as(gymA)).send({ base_personal_goal_ids: [base] });
  expect(imp.body.imported).toEqual([base]);
  copyId = (await db.query('SELECT id FROM personal_goals WHERE gym_id = ? AND base_personal_goal_id = ?', [gymA, base])).rows[0].id;
  ownId = (await request.post('/personal-goals').set(as(gymA)).send({ name: `${NAME} own` })).body.id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.query('DELETE FROM base_personal_goals WHERE id = ?', [base]);
  await db.end();
});

describe('POST /personal-goals/:id/resync-with-system', () => {
  it('reports nothing to do when the copy is current', async () => {
    const res = await request.post(url(copyId)).set(as(gymA));
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
  });

  it('syncs name, description and translations; keeps target, link and the Base row', async () => {
    await db.query("UPDATE personal_goals SET target_value = 9, target_unit = 'lb' WHERE id = ?", [copyId]);
    await db.query("UPDATE base_personal_goals SET name = ?, description = 'v2' WHERE id = ?", [`${NAME} 2`, base]);
    await db.query("UPDATE base_personal_goal_translations SET name = 'Meta ES 2' WHERE base_personal_goal_id = ? AND locale = 'es'", [base]);
    const res = await request.post(url(copyId)).set(as(gymA));
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(['name', 'description']);
    const { rows } = await db.query<any>('SELECT * FROM personal_goals WHERE id = ?', [copyId]);
    expect(rows[0]).toMatchObject({ name: `${NAME} 2`, description: 'v2', target_unit: 'lb', base_personal_goal_id: base });
    expect(Number(rows[0].target_value)).toBe(9);
    const { rows: tr } = await db.query<any>('SELECT name FROM personal_goal_translations WHERE personal_goal_id = ? AND locale = ?', [copyId, 'es']);
    expect(tr[0].name).toBe('Meta ES 2');
    const { rows: b } = await db.query<any>('SELECT name FROM base_personal_goals WHERE id = ?', [base]);
    expect(b[0].name).toBe(`${NAME} 2`);
    expect((await request.post(url(copyId)).set(as(gymA))).body.updated).toEqual([]);
  });

  it('keeps assignments and readings', async () => {
    memberId = (await db.query(
      "INSERT INTO members (gym_id, first_name, last_name, email, created_by) VALUES (?, 'R', 'S', ?, 'test')",
      [gymA, `resync-${Date.now()}@example.com`],
    )).insertId;
    const mpg = await db.query(
      "INSERT INTO member_personal_goals (gym_id, member_id, personal_goal_id, goal_name, status, created_by) VALUES (?, ?, ?, 'Old snapshot', 'in_progress', 'test')",
      [gymA, memberId, copyId],
    );
    await db.query("UPDATE base_personal_goals SET description = 'v3' WHERE id = ?", [base]);
    const res = await request.post(url(copyId)).set(as(gymA));
    expect(res.status).toBe(200);
    const { rows } = await db.query<any>('SELECT goal_name, personal_goal_id FROM member_personal_goals WHERE id = ?', [mpg.insertId]);
    expect(rows[0]).toMatchObject({ goal_name: 'Old snapshot', personal_goal_id: copyId });
  });

  it('409s name_taken when another live goal already uses the System name', async () => {
    await db.query("UPDATE base_personal_goals SET name = ? WHERE id = ?", [`${NAME} own`, base]);
    const res = await request.post(url(copyId)).set(as(gymA));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('name_taken');
  });

  it('409s base_unavailable when the Base goal is gone', async () => {
    await db.query("UPDATE base_personal_goals SET name = ?, deleted_at = UTC_TIMESTAMP() WHERE id = ?", [`${NAME} 4`, base]);
    const res = await request.post(url(copyId)).set(as(gymA));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('base_unavailable');
    await db.query('UPDATE base_personal_goals SET deleted_at = NULL WHERE id = ?', [base]);
  });

  it('400s for a goal the gym created itself', async () => {
    const res = await request.post(url(ownId)).set(as(gymA));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_base_goal');
  });

  it('is isolated per gym and requires auth', async () => {
    expect((await request.post(url(copyId)).set(as(gymB))).status).toBe(404);
    expect((await request.post(url(copyId)).set('x-gym-id', gymA)).status).toBe(401);
  });
});
