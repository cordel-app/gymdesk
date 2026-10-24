// #1849 stage F2: Cordel's Base Foods CRUD writes the base_nutrition_library_* tables
// and mirrors every write onto the legacy System food of the same id.

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


const NAME = 'Test Base Food F2';
let createdId: number;
const H = { Authorization: TEST_AUTH_HEADER };

afterAll(async () => {
  await db.query("DELETE FROM base_nutrition_library_items WHERE name LIKE 'Test Base Food F2%'");
  await db.query("DELETE FROM nutrition_library_items WHERE name LIKE 'Test Base Food F2%'");
  await cleanupTestGyms();
  await db.end();
});

async function legacy(id: number) {
  const { rows } = await db.query<any>('SELECT name, description, status, gym_id FROM nutrition_library_items WHERE id = ?', [id]);
  return rows[0];
}
async function count(table: string, id: number) {
  const { rows } = await db.query<any>(`SELECT COUNT(*) AS n FROM ${table} WHERE item_id = ?`, [id]);
  return Number(rows[0].n);
}

describe('platform foods on base_nutrition_library_items (#1849 F2)', () => {
  it('create writes the Base row, its junctions and a legacy mirror under the same id', async () => {
    const { rows: cats } = await db.query<any>("SELECT id FROM nutrition_library_categories WHERE slug = 'main_dish'");
    const { rows: quals } = await db.query<any>('SELECT id FROM nutritional_qualities ORDER BY id LIMIT 2');
    const res = await request.post('/platform/nutrition-library').set(H).send({
      name: NAME, description: 'd', category_ids: [cats[0].id], quality_ids: quals.map((q: any) => q.id),
      translations: { es: 'Comida F2' }, description_translations: { es: 'Descripción F2' },
    });
    expect(res.status).toBe(201);
    createdId = res.body.id;
    expect(res.body.status).toBe('active');
    expect(res.body.translations.es).toBe('Comida F2');
    expect(res.body.description_translations.es).toBe('Descripción F2');
    const { rows } = await db.query<any>('SELECT name FROM base_nutrition_library_items WHERE id = ?', [createdId]);
    expect(rows[0].name).toBe(NAME);
    expect(await legacy(createdId)).toMatchObject({ name: NAME, gym_id: null, status: 'active' });
    expect(await count('base_nutrition_library_item_categories', createdId)).toBe(1);
    expect(await count('nutrition_library_item_categories', createdId)).toBe(1);
    expect(await count('nutrition_library_item_qualities', createdId)).toBe(quals.length);
    expect(await count('nutrition_library_item_translations', createdId)).toBe(1);
    expect(await count('nutrition_library_item_description_translations', createdId)).toBe(1);
  });

  it('rejects a duplicate live name', async () => {
    const { rows: cats } = await db.query<any>("SELECT id FROM nutrition_library_categories LIMIT 1");
    expect((await request.post('/platform/nutrition-library').set(H).send({ name: NAME, category_ids: [cats[0].id] })).status).toBe(409);
  });

  it('update changes the Base row and the mirror; the list reads the Base table', async () => {
    const res = await request.put(`/platform/nutrition-library/${createdId}`).set(H)
      .send({ name: `${NAME} edited`, translations: { es: 'Editada F2' } });
    expect(res.status).toBe(200);
    expect(await legacy(createdId)).toMatchObject({ name: `${NAME} edited` });
    await db.query("UPDATE base_nutrition_library_items SET description = 'only in base' WHERE id = ?", [createdId]);
    const list = await request.get('/platform/nutrition-library').query({ search: 'Food F2' }).set(H);
    expect(list.body.items.find((i: any) => i.id === createdId).description).toBe('only in base');
  });

  it('404s for a gym-owned food', async () => {
    const gymId = await createTestGym();
    const own = await db.query("INSERT INTO nutrition_library_items (gym_id, name, status) VALUES (?, 'Test Base Food F2 gym', 'active')", [gymId]);
    expect((await request.put(`/platform/nutrition-library/${own.insertId}`).set(H).send({ name: 'x' })).status).toBe(404);
  });

  it('delete soft-deletes the Base row and the mirror', async () => {
    expect((await request.delete(`/platform/nutrition-library/${createdId}`).set(H)).status).toBe(204);
    const { rows } = await db.query<any>('SELECT deleted_at FROM base_nutrition_library_items WHERE id = ?', [createdId]);
    expect(rows[0].deleted_at).not.toBeNull();
    expect((await legacy(createdId)).status).toBe('deleted');
    expect((await request.delete(`/platform/nutrition-library/${createdId}`).set(H)).status).toBe(409);
  });
});
