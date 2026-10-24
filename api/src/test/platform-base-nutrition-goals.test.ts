// #1849: Cordel's Base Nutrition Goals CRUD writes base_nutrition_goals alone (the 2b
// legacy mirror is gone since 2f-1); new ids come from the gym-owned goals' sequence.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, request } from './helpers';

// Override the default @clerk/backend mock: make test-user-id a superadmin.
const mockGetUser = vi.hoisted(() =>
  vi.fn().mockImplementation(async () => ({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin',
    firstName: 'Super',
    lastName: 'Admin',
  })),
);

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: mockGetUser,
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: {
        createInvitation: vi.fn().mockResolvedValue({ id: 'inv-test-id' }),
        revokeInvitation: vi.fn().mockResolvedValue({}),
      },
      emailAddresses: {
        getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 'test@example.com' }),
      },
    })),
  };
});


const NAME = 'Test Base NGoal N2';
let createdId: number;

afterAll(async () => {
  await db.query("DELETE FROM base_nutrition_goals WHERE name LIKE 'Test Base NGoal N2%'");
  await db.query("DELETE FROM nutrition_goals WHERE gym_id IS NULL AND name LIKE 'Test Base NGoal N2%'");
  await cleanupTestGyms();
  await db.end();
});

const H = { Authorization: TEST_AUTH_HEADER };

async function legacy(id: number) {
  const { rows } = await db.query<any>('SELECT name, description, status, gym_id FROM nutrition_goals WHERE id = ?', [id]);
  return rows[0];
}

describe('platform nutrition goals on base_nutrition_goals (#1849 N2)', () => {
  it('create writes the Base row and a legacy mirror under the same id, with translations', async () => {
    const res = await request.post('/platform/nutrition-goals').set(H).send({
      name: NAME, description: 'd', translations: { es: { name: 'Prueba N2' } },
    });
    expect(res.status).toBe(201);
    createdId = res.body.id;
    expect(res.body.gym_id).toBeNull();
    expect(res.body.status).toBe('active');
    expect(res.body.translations.es.name).toBe('Prueba N2');
    const { rows } = await db.query<any>('SELECT name FROM base_nutrition_goals WHERE id = ?', [createdId]);
    expect(rows[0].name).toBe(NAME);
    expect(await legacy(createdId)).toMatchObject({ name: NAME, gym_id: null, status: 'active' });
    const { rows: t } = await db.query<any>('SELECT name FROM nutrition_goal_translations WHERE nutrition_goal_id = ?', [createdId]);
    expect(t.map((r: any) => r.name)).toEqual(['Prueba N2']);
  });

  it('rejects a duplicate live name', async () => {
    expect((await request.post('/platform/nutrition-goals').set(H).send({ name: NAME })).status).toBe(409);
  });

  it('update changes the Base row and the mirror; the list reads the Base table', async () => {
    const res = await request.put(`/platform/nutrition-goals/${createdId}`).set(H).send({ name: `${NAME} edited` });
    expect(res.status).toBe(200);
    expect(await legacy(createdId)).toMatchObject({ name: `${NAME} edited` });
    await db.query("UPDATE base_nutrition_goals SET description = 'only in base' WHERE id = ?", [createdId]);
    const list = await request.get('/platform/nutrition-goals').query({ search: 'NGoal N2' }).set(H);
    expect(list.body.items.find((g: any) => g.id === createdId).description).toBe('only in base');
  });

  it('404s for a goal that is not a Base goal (a gym-owned one)', async () => {
    const gymId = await createTestGym();
    const own = await db.query("INSERT INTO nutrition_goals (gym_id, name, status) VALUES (?, 'Test Base NGoal N2 gym', 'active')", [gymId]);
    expect((await request.put(`/platform/nutrition-goals/${own.insertId}`).set(H).send({ name: 'x' })).status).toBe(404);
  });

  it('delete soft-deletes the Base row and the mirror', async () => {
    expect((await request.delete(`/platform/nutrition-goals/${createdId}`).set(H)).status).toBe(204);
    const { rows } = await db.query<any>('SELECT deleted_at FROM base_nutrition_goals WHERE id = ?', [createdId]);
    expect(rows[0].deleted_at).not.toBeNull();
    expect((await legacy(createdId)).status).toBe('deleted');
    expect((await request.delete(`/platform/nutrition-goals/${createdId}`).set(H)).status).toBe(409);
  });
});
