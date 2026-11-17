// #2951 stage 5: Base Nutrition Library foods and gym foods get a persistent slug on creation,
// unique per scope (the Base catalogue; each gym), never changed by an edit; a gym reads a Base
// food's slug through the catalogue.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockResolvedValue({
          publicMetadata: { platform_role: 'superadmin' },
          fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
          emailAddresses: [], primaryEmailAddressId: null,
        }),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
    })),
  };
});

const RUN = Math.random().toString(36).slice(2, 8);
const PREFIX = `FoodSlug ${RUN}`;
const SLUG = `foodslug-${RUN}`;
let gymA: string;
let gymB: string;
let categoryId: number;

const auth = (gym?: string) => (gym ? { Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym } : { Authorization: TEST_AUTH_HEADER });

beforeAll(async () => {
  gymA = await createTestGym(`Food Slug A ${RUN}`);
  await createTestMembership(gymA, 'admin');
  gymB = await createTestGym(`Food Slug B ${RUN}`);
  await createTestMembership(gymB, 'admin');
  categoryId = (await db.query<{ id: number }>('SELECT id FROM nutrition_library_categories ORDER BY id LIMIT 1')).rows[0].id;
});

afterAll(async () => {
  await db.query('DELETE FROM base_nutrition_library_items WHERE name LIKE ?', [`${PREFIX}%`]);
  await db.query('DELETE FROM nutrition_library_items WHERE name LIKE ?', [`${PREFIX}%`]);
  await cleanupTestGyms();
  await db.end();
});

describe('Base foods', () => {
  let baseId: number;

  it('are slugged from the name, suffixed when taken, and keep the slug on rename', async () => {
    const first = await request.post('/platform/nutrition-library').set(auth()).send({ name: `${PREFIX} Crème Brûlée (light)`, category_ids: [categoryId] });
    expect(first.status).toBe(201);
    expect(first.body.slug).toBe(`${SLUG}-creme-brulee-light`);
    baseId = first.body.id;

    const second = await request.post('/platform/nutrition-library').set(auth()).send({ name: `${PREFIX} Creme Brulee Light`, category_ids: [categoryId] });
    expect(second.status).toBe(201);
    expect(second.body.slug).toBe(`${SLUG}-creme-brulee-light-2`);

    // A rename, and a body naming a slug: neither changes it (§7).
    const put = await request.put(`/platform/nutrition-library/${baseId}`).set(auth())
      .send({ name: `${PREFIX} Renamed`, slug: 'hijacked' });
    expect(put.status).toBe(200);
    const { rows } = await db.query<{ slug: string }>('SELECT slug FROM base_nutrition_library_items WHERE id = ?', [baseId]);
    expect(rows[0].slug).toBe(`${SLUG}-creme-brulee-light`);
  });

  it('reach a gym through the catalogue with their slug', async () => {
    const res = await request.get('/nutrition-library').query({ q: PREFIX, limit: 'all' }).set(auth(gymA));
    expect(res.status).toBe(200);
    const items = Array.isArray(res.body) ? res.body : res.body.rows ?? res.body.items;
    expect(items.find((i: { id: number }) => i.id === baseId)?.slug).toBe(`${SLUG}-creme-brulee-light`);
  });
});

describe('gym foods', () => {
  it('are unique per gym, may repeat across gyms and a Base slug, and keep the slug on rename', async () => {
    const a1 = await request.post('/nutrition-library').set(auth(gymA)).send({ name: `${PREFIX} Crème Brûlée (light)`, category_ids: [categoryId] });
    expect(a1.status).toBe(201);
    // Same slug as the Base food: a different scope (§3).
    expect(a1.body.slug).toBe(`${SLUG}-creme-brulee-light`);

    const a2 = await request.post('/nutrition-library').set(auth(gymA)).send({ name: `${PREFIX} creme-brulee light`, category_ids: [categoryId] });
    expect(a2.status).toBe(201);
    expect(a2.body.slug).toBe(`${SLUG}-creme-brulee-light-2`);

    const b1 = await request.post('/nutrition-library').set(auth(gymB)).send({ name: `${PREFIX} Crème Brûlée (light)`, category_ids: [categoryId] });
    expect(b1.status).toBe(201);
    expect(b1.body.slug).toBe(`${SLUG}-creme-brulee-light`);

    const put = await request.put(`/nutrition-library/${a1.body.id}`).set(auth(gymA))
      .send({ name: `${PREFIX} Something else`, slug: 'hijacked' });
    expect(put.status).toBe(200);
    expect(put.body.slug).toBe(`${SLUG}-creme-brulee-light`);

    const list = await request.get('/nutrition-library').query({ q: PREFIX, limit: 'all' }).set(auth(gymA));
    expect(list.status).toBe(200);
    const items = Array.isArray(list.body) ? list.body : list.body.rows ?? list.body.items;
    const listed = items.find((i: { id: number }) => i.id === a2.body.id);
    expect(listed?.slug).toBe(`${SLUG}-creme-brulee-light-2`);
  });

  it('are refused a duplicate slug within one gym by the database', async () => {
    const { rows } = await db.query<{ id: number }>(
      'SELECT id FROM nutrition_library_items WHERE gym_id = ? AND name LIKE ? ORDER BY id LIMIT 2', [gymA, `${PREFIX}%`],
    );
    await expect(db.query('UPDATE nutrition_library_items SET slug = (SELECT s FROM (SELECT slug AS s FROM nutrition_library_items WHERE id = ?) x) WHERE id = ?', [rows[0].id, rows[1].id]))
      .rejects.toThrow(/Duplicate/);
  });
});
