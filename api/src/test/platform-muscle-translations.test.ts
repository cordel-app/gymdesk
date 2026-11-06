// #2402: a muscle's name in every supported language, through Cordel → Muscles.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, request } from './helpers';

const mockGetUser = vi.hoisted(() =>
  vi.fn().mockImplementation(async () => ({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
  })),
);

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: { getUser: mockGetUser, getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }) },
      invitations: { createInvitation: vi.fn().mockResolvedValue({ id: 'inv' }), revokeInvitation: vi.fn().mockResolvedValue({}) },
      emailAddresses: { getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 't@example.com' }) },
    })),
  };
});

const H = { Authorization: TEST_AUTH_HEADER };
const NAME = 'Test Muscle T2402';

afterAll(async () => {
  await db.query("DELETE FROM muscles WHERE name LIKE 'Test Muscle T2402%'");
  await cleanupTestGyms();
  await db.end();
});

describe('muscle translations (#2402)', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request.get('/platform/muscles');
    expect(res.status).toBe(401);
  });

  it('stores translations on create, reports them, keeps them on a name-only edit and replaces them on request', async () => {
    const created = await request.post('/platform/muscles').set(H)
      .send({ name: NAME, translations: { es: 'Músculo prueba', ca: 'Múscul prova' } });
    expect(created.status).toBe(201);
    expect(created.body.translations).toEqual({ es: 'Músculo prueba', ca: 'Múscul prova' });
    const id = created.body.id;

    // A request that does not mention translations leaves them alone.
    const renamed = await request.put(`/platform/muscles/${id}`).set(H).send({ name: `${NAME} B` });
    expect(renamed.status).toBe(200);
    expect(renamed.body.translations.es).toBe('Músculo prueba');

    // A partial set is allowed (no "every language required"); omitted locales are dropped.
    const partial = await request.put(`/platform/muscles/${id}`).set(H)
      .send({ name: `${NAME} B`, translations: { es: 'Solo es' } });
    expect(partial.status).toBe(200);
    expect(partial.body.translations).toEqual({ es: 'Solo es' });

    const list = await request.get('/platform/muscles').set(H);
    expect(list.body.find((m: any) => m.id === id).translations).toEqual({ es: 'Solo es' });

    const cleared = await request.put(`/platform/muscles/${id}`).set(H).send({ name: `${NAME} B`, translations: {} });
    expect(cleared.body.translations).toEqual({});
  });

  it('rejects the base locale and unknown locales', async () => {
    const created = await request.post('/platform/muscles').set(H).send({ name: `${NAME} C` });
    const id = created.body.id;
    expect(created.body.translations).toEqual({});
    const base = await request.put(`/platform/muscles/${id}`).set(H).send({ name: `${NAME} C`, translations: { en: 'x' } });
    expect(base.status).toBe(400);
    const unknown = await request.put(`/platform/muscles/${id}`).set(H).send({ name: `${NAME} C`, translations: { xx: 'x' } });
    expect(unknown.status).toBe(400);
  });
});
