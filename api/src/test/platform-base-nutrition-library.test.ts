// #1849 stages F2-F2b: Cordel's Base Foods CRUD writes the base_nutrition_library_* tables
// and, since F5, writes nothing onto the legacy table.

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
  it('create writes the Base row and its junctions, and no legacy row', async () => {
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
    expect(await legacy(createdId)).toBeUndefined();
    expect(await count('base_nutrition_library_item_categories', createdId)).toBe(1);
    expect(await count('base_nutrition_library_item_qualities', createdId)).toBe(quals.length);
    expect(await count('base_nutrition_library_item_translations', createdId)).toBe(1);
    expect(await count('base_nutrition_library_item_description_translations', createdId)).toBe(1);
    expect(await count('nutrition_library_item_categories', createdId)).toBe(0);
  });

  it('rejects a duplicate live name', async () => {
    const { rows: cats } = await db.query<any>("SELECT id FROM nutrition_library_categories LIMIT 1");
    expect((await request.post('/platform/nutrition-library').set(H).send({ name: NAME, category_ids: [cats[0].id] })).status).toBe(409);
  });

  it('update changes the Base row; the list reads the Base table', async () => {
    const res = await request.put(`/platform/nutrition-library/${createdId}`).set(H)
      .send({ name: `${NAME} edited`, translations: { es: 'Editada F2' } });
    expect(res.status).toBe(200);
    expect((await db.query<any>('SELECT name FROM base_nutrition_library_items WHERE id = ?', [createdId])).rows[0].name).toBe(`${NAME} edited`);
    expect(await legacy(createdId)).toBeUndefined();
    await db.query("UPDATE base_nutrition_library_items SET description = 'only in base' WHERE id = ?", [createdId]);
    const list = await request.get('/platform/nutrition-library').query({ search: 'Food F2' }).set(H);
    expect(list.body.items.find((i: any) => i.id === createdId).description).toBe('only in base');
  });

  it('404s for a gym-owned food', async () => {
    const gymId = await createTestGym();
    const own = await db.query("INSERT INTO nutrition_library_items (gym_id, name, status) VALUES (?, 'Test Base Food F2 gym', 'active')", [gymId]);
    expect((await request.put(`/platform/nutrition-library/${own.insertId}`).set(H).send({ name: 'x' })).status).toBe(404);
  });

  it('delete soft-deletes the Base row', async () => {
    expect((await request.delete(`/platform/nutrition-library/${createdId}`).set(H)).status).toBe(204);
    const { rows } = await db.query<any>('SELECT deleted_at FROM base_nutrition_library_items WHERE id = ?', [createdId]);
    expect(rows[0].deleted_at).not.toBeNull();
    expect(await legacy(createdId)).toBeUndefined();
    expect((await request.delete(`/platform/nutrition-library/${createdId}`).set(H)).status).toBe(409);
  });
});

describe('gym-side reads come from the Base tables (#1849 F2b)', () => {
  it('a gym lists a System food (name, translation, categories) from the Base table, not the legacy copy; a Cordel delete hides it', async () => {
    const { rows: cats } = await db.query<any>("SELECT id FROM nutrition_library_categories WHERE slug = 'main_dish'");
    const created = await request.post('/platform/nutrition-library').set(H).send({
      name: 'Test Base Food F2 read', category_ids: [cats[0].id], translations: { es: 'Legacy copy' },
    });
    const id = created.body.id;
    // Diverge on purpose: the gym must see the Base values, not the mirrored legacy ones.
    await db.query("UPDATE base_nutrition_library_items SET name = 'Test Base Food F2 read base' WHERE id = ?", [id]);
    await db.query("UPDATE base_nutrition_library_item_translations SET name = 'Solo Base F2b' WHERE item_id = ? AND locale = 'es'", [id]);
    const gymId = await createTestGym();
    const asGym = { Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId };
    const list = await request.get('/nutrition-library').query({ search: 'F2 read' }).set(asGym).set('x-locale', 'es');
    expect(list.status).toBe(200);
    const food = list.body.items.find((i: any) => i.id === id);
    expect(food.name).toBe('Test Base Food F2 read base');
    expect(food.display_name).toBe('Solo Base F2b');
    expect(food.categories.map((c: any) => c.id)).toEqual([cats[0].id]);
    expect((await request.put(`/nutrition-library/${id}`).set(asGym).send({ name: 'x' })).status).toBe(403);
    await request.delete(`/platform/nutrition-library/${id}`).set(H);
    const after = await request.get('/nutrition-library').query({ search: 'F2 read' }).set(asGym);
    expect(after.body.items.map((i: any) => i.id)).not.toContain(id);
  });
});
