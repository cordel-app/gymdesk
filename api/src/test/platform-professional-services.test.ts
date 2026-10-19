// #1817: Cordel → Base Professional Services (/platform/professional-services).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const superadminUser = { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Test Admin', firstName: 'Test', lastName: 'Admin' };
const regularUser = { publicMetadata: {}, fullName: 'Test User', firstName: 'Test', lastName: 'User' };

function mockUser(u: unknown) {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue(u as any);
}

const PREFIX = `TestBasePS-${Date.now()}`;
let gymId: string;
const body = (n: string, extra: Record<string, unknown> = {}) => ({
  name: `${PREFIX}-${n}`,
  description: 'English text',
  max_capacity: 6,
  translations: { es: { name: `${PREFIX}-${n}-es`, description: 'Texto' }, ca: { name: `${PREFIX}-${n}-ca` } },
  ...extra,
});
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER);

beforeAll(async () => {
  gymId = await createTestGym('BasePSGym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await db.query('DELETE FROM professional_services WHERE gym_id IS NULL AND name LIKE ?', [`${PREFIX}%`]);
  await cleanupTestGyms();
  await db.end();
});

beforeEach(() => mockUser(superadminUser));

describe('auth', () => {
  it('refuses a non-superadmin', async () => {
    mockUser(regularUser);
    expect((await auth(request.get('/platform/professional-services'))).status).toBe(403);
    expect((await auth(request.post('/platform/professional-services')).send(body('x'))).status).toBe(403);
  });
  it('refuses an unauthenticated request', async () => {
    expect((await request.get('/platform/professional-services')).status).toBe(401);
  });
});

describe('CRUD', () => {
  let id: number;

  it('creates with max capacity and three languages, visible to existing gyms', async () => {
    const res = await auth(request.post('/platform/professional-services')).send(body('a'));
    expect(res.status).toBe(201);
    id = res.body.id;
    expect(res.body.max_capacity).toBe(6);
    expect(res.body.translations.es.name).toBe(`${PREFIX}-a-es`);
    expect(res.body.translations.ca.description).toBeNull();
    const { rows } = await db.query('SELECT status FROM gym_professional_services WHERE gym_id = ? AND professional_service_id = ?', [gymId, id]);
    expect(rows).toHaveLength(1);
  });

  it('rejects invalid capacity and missing translations', async () => {
    for (const bad of [0, -1, 1.5, 'x']) {
      const r = await auth(request.post('/platform/professional-services')).send(body('bad', { max_capacity: bad }));
      expect(r.status).toBe(400);
    }
    const r = await auth(request.post('/platform/professional-services')).send(body('bad2', { translations: { es: { name: 'x' } } }));
    expect(r.status).toBe(400);
  });

  it('lists, reads and edits; omitted translations are kept', async () => {
    const list = await auth(request.get(`/platform/professional-services?q=${PREFIX}-a`));
    expect(list.body.map((r: any) => r.id)).toContain(id);
    const upd = await auth(request.put(`/platform/professional-services/${id}`)).send({ max_capacity: 10 });
    expect(upd.status).toBe(200);
    expect(upd.body.max_capacity).toBe(10);
    expect(upd.body.translations.es.name).toBe(`${PREFIX}-a-es`);
    const cleared = await auth(request.put(`/platform/professional-services/${id}`)).send({ max_capacity: null });
    expect(cleared.body.max_capacity).toBeNull();
    expect((await auth(request.put(`/platform/professional-services/${id}`)).send({ max_capacity: 0 })).status).toBe(400);
  });

  it('does not expose gym-owned services', async () => {
    const { insertId } = await db.query(
      "INSERT INTO professional_services (gym_id, name, is_system, created_by) VALUES (?, ?, 0, 'test')", [gymId, `${PREFIX}-gym`]);
    expect((await auth(request.get(`/platform/professional-services/${insertId}`))).status).toBe(404);
    expect((await auth(request.delete(`/platform/professional-services/${insertId}`))).status).toBe(404);
  });

  it('soft-deletes an unused service', async () => {
    const fresh = await auth(request.post('/platform/professional-services')).send(body('del'));
    const del = await auth(request.delete(`/platform/professional-services/${fresh.body.id}`));
    expect(del.status).toBe(204);
    expect((await auth(request.get(`/platform/professional-services/${fresh.body.id}`))).status).toBe(404);
    const { rows } = await db.query('SELECT deleted_at FROM professional_services WHERE id = ?', [fresh.body.id]);
    expect(rows[0].deleted_at).not.toBeNull();
  });
});
