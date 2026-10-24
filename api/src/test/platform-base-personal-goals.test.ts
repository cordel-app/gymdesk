// #1849 stage 2b: Cordel's Base Personal Goals CRUD writes base_personal_goals
// and mirrors every write onto the legacy System row of the same id.

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


const NAME = 'Test Base Goal 2b';
let createdId: number;

afterAll(async () => {
  await db.query("DELETE FROM base_personal_goals WHERE name LIKE 'Test Base Goal 2b%'");
  await db.query("DELETE FROM personal_goals WHERE gym_id IS NULL AND name LIKE 'Test Base Goal 2b%'");
  await cleanupTestGyms();
  await db.end();
});

async function legacy(id: number) {
  const { rows } = await db.query<any>(
    'SELECT name, description, target_value, target_unit, status, gym_id FROM personal_goals WHERE id = ?', [id]);
  return rows[0];
}

describe('platform personal goals on base_personal_goals', () => {
  it('create writes the Base row and a legacy mirror under the same id, with translations', async () => {
    const res = await request.post('/platform/personal-goals').set('Authorization', TEST_AUTH_HEADER).send({
      name: NAME, description: 'd', target_value: 5, target_unit: 'kg',
      translations: { es: { name: 'Prueba 2b' } },
    });
    expect(res.status).toBe(201);
    createdId = res.body.id;
    expect(res.body.gym_id).toBeNull();
    expect(res.body.status).toBe('active');
    expect(res.body.translations.es.name).toBe('Prueba 2b');
    const { rows } = await db.query<any>('SELECT name FROM base_personal_goals WHERE id = ?', [createdId]);
    expect(rows[0].name).toBe(NAME);
    expect(await legacy(createdId)).toMatchObject({ name: NAME, gym_id: null, status: 'active' });
    const { rows: t } = await db.query<any>('SELECT name FROM personal_goal_translations WHERE personal_goal_id = ?', [createdId]);
    expect(t.map((r: any) => r.name)).toEqual(['Prueba 2b']);
  });

  it('rejects a duplicate live name', async () => {
    const res = await request.post('/platform/personal-goals').set('Authorization', TEST_AUTH_HEADER).send({ name: NAME });
    expect(res.status).toBe(409);
  });

  it('update changes the Base row and the mirror; lists and reads come from the Base table', async () => {
    const res = await request.put(`/platform/personal-goals/${createdId}`).set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `${NAME} edited`, target_value: 7 });
    expect(res.status).toBe(200);
    expect(res.body.target_value).toBe(7);
    expect(await legacy(createdId)).toMatchObject({ name: `${NAME} edited` });
    const list = await request.get('/platform/personal-goals').query({ search: 'Base Goal 2b' }).set('Authorization', TEST_AUTH_HEADER);
    expect(list.body.items.map((g: any) => g.id)).toContain(createdId);
  });

  it('404s for a goal that is not a Base goal (a gym-owned one)', async () => {
    const gymId = await createTestGym();
    const { insertId } = await db.query(
      "INSERT INTO personal_goals (gym_id, name, status) VALUES (?, 'Test Base Goal 2b gym', 'active')", [gymId]);
    const res = await request.put(`/platform/personal-goals/${insertId}`).set('Authorization', TEST_AUTH_HEADER).send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('delete soft-deletes the Base row and the mirror', async () => {
    const res = await request.delete(`/platform/personal-goals/${createdId}`).set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(204);
    const { rows } = await db.query<any>('SELECT deleted_at FROM base_personal_goals WHERE id = ?', [createdId]);
    expect(rows[0].deleted_at).not.toBeNull();
    expect((await legacy(createdId)).status).toBe('deleted');
    expect((await request.delete(`/platform/personal-goals/${createdId}`).set('Authorization', TEST_AUTH_HEADER)).status).toBe(409);
  });
});
