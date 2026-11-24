// #3328 stage 1: Cordel → Base Meals CRUD (superadmin only).
import { afterAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const isSuperadmin = vi.hoisted(() => ({ value: true }));
const mockGetUser = vi.hoisted(() =>
  vi.fn().mockImplementation(async () => ({
    publicMetadata: isSuperadmin.value ? { platform_role: 'superadmin' } : {},
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
      users: { getUser: mockGetUser, getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }) },
      invitations: { createInvitation: vi.fn(), revokeInvitation: vi.fn() },
      emailAddresses: { getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 'test@example.com' }) },
    })),
  };
});

const H = { Authorization: TEST_AUTH_HEADER };
const NAME = 'Test Base Meal 3328';
let createdId: number;

afterAll(async () => {
  await db.query("DELETE FROM base_meals WHERE name LIKE 'Test Base Meal 3328%'");
  await cleanupTestGyms();
  await db.end();
});

describe('Base Meals (#3328 stage 1)', () => {
  it('is seeded with today’s fixed meal types, translated, in display order', async () => {
    const res = await request.get('/platform/base-meals').set(H).set('x-locale', 'es');
    expect(res.status).toBe(200);
    const slugs = res.body.map((m: any) => m.slug);
    expect(slugs.slice(0, 3)).toEqual(['recien_levantado', 'breakfast', 'media_manana']);
    const breakfast = res.body.find((m: any) => m.slug === 'breakfast');
    expect(breakfast.name).toBe('Breakfast');
    expect(breakfast.display_name).toBe('Desayuno');
    expect(breakfast.translations.ca.name).toBe('Esmorzar');
  });

  it('401 without a token, 403 for a user who is not a superadmin', async () => {
    expect((await request.get('/platform/base-meals')).status).toBe(401);
    isSuperadmin.value = false;
    try {
      const gymId = await createTestGym();
      await createTestMembership(gymId, 'admin');
      const res = await request.get('/platform/base-meals').set(H).set('x-gym-id', gymId);
      expect(res.status).toBe(403);
      expect((await request.post('/platform/base-meals').set(H).send({ name: `${NAME} x` })).status).toBe(403);
    } finally {
      isSuperadmin.value = true;
    }
  });

  it('creates a meal with a slug generated from its name and its translations', async () => {
    const res = await request.post('/platform/base-meals').set(H).send({
      name: NAME,
      description: 'A test meal',
      translations: { es: { name: 'Comida de prueba', description: 'Una comida' }, ca: { name: 'Àpat de prova' } },
    });
    expect(res.status).toBe(201);
    createdId = res.body.id;
    expect(res.body.slug).toBe('test-base-meal-3328');
    expect(res.body.created_by).toBe('Super Admin');
    expect(res.body.translations.es).toEqual({ name: 'Comida de prueba', description: 'Una comida' });
    const es = await request.get(`/platform/base-meals/${createdId}`).set(H).set('x-locale', 'es');
    expect(es.body.display_name).toBe('Comida de prueba');
    expect(es.body.display_description).toBe('Una comida');
  });

  it('validates the name and refuses a duplicate live name', async () => {
    expect((await request.post('/platform/base-meals').set(H).send({})).status).toBe(400);
    expect((await request.post('/platform/base-meals').set(H).send({ name: '  ' })).status).toBe(400);
    expect((await request.post('/platform/base-meals').set(H).send({
      name: `${NAME} b`, translations: { fr: { name: 'x' } },
    })).status).toBe(400);
    expect((await request.post('/platform/base-meals').set(H).send({ name: NAME })).status).toBe(409);
  });

  it('a second meal with a similar name gets its own slug', async () => {
    const res = await request.post('/platform/base-meals').set(H).send({ name: `${NAME}!` });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe('test-base-meal-3328-2');
  });

  it('updates the name and description but never the slug; omitted translations stay', async () => {
    const res = await request.put(`/platform/base-meals/${createdId}`).set(H)
      .send({ name: `${NAME} edited`, slug: 'hijacked', description: null });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`${NAME} edited`);
    expect(res.body.description).toBeNull();
    expect(res.body.slug).toBe('test-base-meal-3328');
    expect(res.body.translations.es.name).toBe('Comida de prueba');
    const cleared = await request.put(`/platform/base-meals/${createdId}`).set(H).send({ translations: {} });
    expect(cleared.body.translations).toEqual({});
  });

  it('search matches the slug and any translated name', async () => {
    await request.put(`/platform/base-meals/${createdId}`).set(H).send({ translations: { ca: { name: 'Àpat únic 3328' } } });
    const res = await request.get('/platform/base-meals').query({ search: 'únic 3328' }).set(H);
    expect(res.body.map((m: any) => m.id)).toEqual([createdId]);
  });

  it('image upload of a non-image is refused and leaves the meal untouched', async () => {
    const res = await request.post(`/platform/base-meals/${createdId}/image`).set(H)
      .set('Content-Type', 'text/plain').send('nope');
    expect(res.status).toBe(415);
    expect((await request.post('/platform/base-meals/999999999/image').set(H)
      .set('Content-Type', 'image/png').send(Buffer.from('x'))).status).toBe(404);
  });

  it('delete is soft, hides the meal and keeps its slug taken', async () => {
    expect((await request.delete(`/platform/base-meals/${createdId}`).set(H)).status).toBe(204);
    const { rows } = await db.query<any>('SELECT deleted_at, deleted_by FROM base_meals WHERE id = ?', [createdId]);
    expect(rows[0].deleted_at).not.toBeNull();
    expect(rows[0].deleted_by).toBe('Super Admin');
    expect((await request.get(`/platform/base-meals/${createdId}`).set(H)).status).toBe(404);
    expect((await request.delete(`/platform/base-meals/${createdId}`).set(H)).status).toBe(404);
    const list = await request.get('/platform/base-meals').set(H);
    expect(list.body.map((m: any) => m.id)).not.toContain(createdId);
    const again = await request.post('/platform/base-meals').set(H).send({ name: NAME });
    expect(again.status).toBe(201);
    expect(again.body.slug).toBe('test-base-meal-3328-3');
  });

  it('writes an audit row resolvable to the meal’s name', async () => {
    const { resolveEntityName } = await import('../infra/audit-registry');
    const { rows } = await db.query<any>("SELECT id FROM base_meals WHERE slug = 'breakfast'");
    expect(await resolveEntityName('base_meal', String(rows[0].id), 'x')).toBe('Breakfast');
  });
});
