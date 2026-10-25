// #1849 stage E2: Cordel's Base Exercises CRUD writes the base_exercise* tables and mirrors
// them onto the legacy System row of the same id (transitional, removed in the final stage).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, deleteBaseExercises, request } from './helpers';

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



const NAME = 'Test Base Exercise E2';
const H = { Authorization: TEST_AUTH_HEADER };
const ids: number[] = [];

afterAll(async () => {
  await deleteBaseExercises(ids);
  await db.query("DELETE FROM base_exercises WHERE name LIKE 'Test Base Exercise E2%'");
  await cleanupTestGyms();
  await db.end();
});

const one = async (sql: string, params: unknown[]) => (await db.query<any>(sql, params)).rows[0];
const count = async (table: string, id: number) =>
  Number((await one(`SELECT COUNT(*) AS n FROM ${table} WHERE exercise_id = ?`, [id])).n);

describe('platform exercises on base_exercises (#1849 E2)', () => {
  it('create writes the Base row + junctions and mirrors the legacy System row with the same id', async () => {
    const res = await request.post('/platform/exercises').set(H).send({
      name: NAME, description: 'd', category: 'strength',
      muscles: [{ key: 'chest', role: 'principal' }, { key: 'triceps', role: 'secondary' }],
      translations: { es: 'Ejercicio E2' }, description_translations: { es: { description: 'Descripción E2' } },
    });
    expect(res.status).toBe(201);
    const id = res.body.id as number;
    ids.push(id);
    expect(res.body.gym_id).toBeNull();
    expect(res.body.translations).toEqual({ es: 'Ejercicio E2' });
    expect(res.body.muscles).toHaveLength(2);
    expect(res.body.allowed_result_types.length).toBeGreaterThan(0);

    expect(await one('SELECT name, status FROM base_exercises WHERE id = ?', [id])).toMatchObject({ name: NAME, status: 'active' });
    expect(await count('base_exercise_translations', id)).toBe(1);
    expect(await count('base_exercise_description_translations', id)).toBe(1);
    expect(await count('base_exercise_muscles', id)).toBe(2);
    expect(await count('base_exercise_allowed_result_types', id)).toBeGreaterThan(0);

    // The mirror: the legacy System row of the same id, junctions included.
    expect(await one('SELECT name, status, gym_id FROM exercises WHERE id = ?', [id])).toMatchObject({ name: NAME, status: 'active', gym_id: null });
    expect(await count('exercise_translations', id)).toBe(1);
    expect(await count('exercise_description_translations', id)).toBe(1);
    expect(await count('exercise_muscles', id)).toBe(2);
    expect(await count('exercise_allowed_result_types', id)).toBe(await count('base_exercise_allowed_result_types', id));
  });

  it('the id comes from the legacy sequence, so a Base id never collides with a gym-owned one', async () => {
    const gymId = await createTestGym('E2 Gym');
    const { insertId } = await db.query("INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Test Base Exercise E2 gym', 'active')", [gymId]);
    const res = await request.post('/platform/exercises').set(H).send({ name: `${NAME} next` });
    expect(res.status).toBe(201);
    ids.push(res.body.id);
    expect(res.body.id).toBeGreaterThan(Number(insertId));
  });

  it('update changes the Base row and the mirror, and replaces the junctions', async () => {
    const id = ids[0];
    const res = await request.put(`/platform/exercises/${id}`).set(H).send({
      description: 'new', muscles: [{ key: 'back', role: 'principal' }], translations: { es: 'Otro' },
    });
    expect(res.status).toBe(200);
    expect((await one('SELECT description FROM base_exercises WHERE id = ?', [id])).description).toBe('new');
    expect((await one('SELECT description FROM exercises WHERE id = ?', [id])).description).toBe('new');
    expect(await count('base_exercise_muscles', id)).toBe(1);
    expect(await count('exercise_muscles', id)).toBe(1);
    expect((await one('SELECT name FROM exercise_translations WHERE exercise_id = ?', [id])).name).toBe('Otro');
  });

  it('a duplicate name is a 409, and the list and detail read the Base table', async () => {
    const dup = await request.post('/platform/exercises').set(H).send({ name: NAME });
    expect(dup.status).toBe(409);
    await db.query("UPDATE base_exercises SET description = 'only-in-base' WHERE id = ?", [ids[0]]);
    const get = await request.get(`/platform/exercises/${ids[0]}`).set(H);
    expect(get.body.description).toBe('only-in-base');
    const list = await request.get(`/platform/exercises?q=${encodeURIComponent(NAME)}`).set(H);
    expect(list.body.find((e: any) => e.id === ids[0])?.description).toBe('only-in-base');
  });

  it('delete soft-deletes the Base row and the mirror', async () => {
    const res = await request.delete(`/platform/exercises/${ids[0]}`).set(H);
    expect(res.status).toBe(204);
    expect(await one('SELECT status, deleted_at FROM base_exercises WHERE id = ?', [ids[0]])).toMatchObject({ status: 'deleted' });
    expect((await one('SELECT status FROM exercises WHERE id = ?', [ids[0]])).status).toBe('deleted');
    expect((await request.get(`/platform/exercises/${ids[0]}`).set(H)).status).toBe(404);
    expect((await request.delete(`/platform/exercises/${ids[0]}`).set(H)).status).toBe(404);
  });

  it('is superadmin-only', async () => {
    expect((await request.post('/platform/exercises').send({ name: 'x' })).status).toBe(401);
  });
});
