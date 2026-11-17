// #2951 stage 4: Base Professional Services and gym services get a persistent slug on creation,
// unique per scope (the Base catalogue; each gym), never changed by an edit or a sync from the
// Base service; an imported copy keeps its Base service's slug.
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
const PREFIX = `PsSlug ${RUN}`;
let gymA: string;
let gymB: string;

const auth = (gym?: string) => (gym ? { Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym } : { Authorization: TEST_AUTH_HEADER });
const slugOf = async (id: number) =>
  (await db.query<{ slug: string | null }>('SELECT slug FROM professional_services WHERE id = ?', [id])).rows[0].slug;

beforeAll(async () => {
  gymA = await createTestGym(`PS Slug A ${RUN}`);
  await createTestMembership(gymA, 'admin');
  gymB = await createTestGym(`PS Slug B ${RUN}`);
  await createTestMembership(gymB, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.query('DELETE FROM professional_services WHERE gym_id IS NULL AND name LIKE ?', [`${PREFIX}%`]);
  await db.end();
});

describe('Base Professional Services', () => {
  it('are slugged from the name, suffixed when taken, and keep the slug on rename', async () => {
    const first = await request.post('/platform/professional-services').set(auth()).send({ name: `${PREFIX} Fisioteràpia (1:1)` });
    expect(first.status).toBe(201);
    expect(first.body.slug).toBe(`psslug-${RUN}-fisioterapia-1-1`);

    const second = await request.post('/platform/professional-services').set(auth()).send({ name: `${PREFIX} Fisioterapia 1-1` });
    expect(second.status).toBe(201);
    expect(second.body.slug).toBe(`psslug-${RUN}-fisioterapia-1-1-2`);

    // Rename, and a body naming a slug: neither changes it (§7).
    const put = await request.put(`/platform/professional-services/${first.body.id}`).set(auth())
      .send({ name: `${PREFIX} Renamed`, slug: 'hijacked' });
    expect(put.status).toBe(200);
    expect(await slugOf(first.body.id)).toBe(`psslug-${RUN}-fisioterapia-1-1`);
  });
});

describe('gym Professional Services', () => {
  let baseId: number;
  let baseSlug: string;

  beforeAll(async () => {
    const res = await request.post('/platform/professional-services').set(auth()).send({ name: `${PREFIX} Importable` });
    expect(res.status).toBe(201);
    baseId = res.body.id;
    baseSlug = res.body.slug;
  });

  it('a gym service is slugged from its name, per gym, and its own slug survives a rename', async () => {
    const a = await request.post('/professional-services').set(auth(gymA)).send({ name: 'Boxing Duo' });
    const b = await request.post('/professional-services').set(auth(gymB)).send({ name: 'Boxing Duo' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    // Two gyms may share a slug.
    expect(a.body.slug).toBe('boxing-duo');
    expect(b.body.slug).toBe('boxing-duo');

    const a2 = await request.post('/professional-services').set(auth(gymA)).send({ name: 'Boxing (Duo)' });
    expect(a2.body.slug).toBe('boxing-duo-2');

    const put = await request.put(`/professional-services/${a.body.id}`).set(auth(gymA)).send({ name: 'Kickboxing', slug: 'x' });
    expect(put.status).toBe(200);
    expect(await slugOf(a.body.id)).toBe('boxing-duo');
  });

  it('a duplicate is slugged from its own name', async () => {
    const src = await request.post('/professional-services').set(auth(gymA)).send({ name: 'Yoga' });
    const dup = await request.post(`/professional-services/${src.body.id}/duplicate`).set(auth(gymA)).send({});
    expect(dup.status).toBe(201);
    expect(dup.body.slug).toBe('yoga-copy');
  });

  it('an imported copy carries its Base service slug into every gym, and a sync keeps it', async () => {
    for (const gym of [gymA, gymB]) {
      const res = await request.post('/professional-services/import').set(auth(gym)).send({ base_professional_service_ids: [baseId] });
      expect(res.status).toBe(200);
      expect(res.body.imported).toEqual([baseId]);
      const { rows } = await db.query<{ id: number; slug: string }>(
        'SELECT id, slug FROM professional_services WHERE gym_id = ? AND base_professional_service_id = ?', [gym, baseId]);
      expect(rows[0].slug).toBe(baseSlug);
    }

    const { rows: [copy] } = await db.query<{ id: number }>(
      'SELECT id FROM professional_services WHERE gym_id = ? AND base_professional_service_id = ?', [gymA, baseId]);
    await request.put(`/professional-services/${copy.id}`).set(auth(gymA)).send({ name: 'Local name' });
    const sync = await request.post(`/professional-services/${copy.id}/update-system-data`).set(auth(gymA)).send({});
    expect(sync.status).toBeLessThan(300);
    expect(await slugOf(copy.id)).toBe(baseSlug);
  });

  it('the database refuses a duplicate slug within one gym', async () => {
    await expect(db.query(
      `INSERT INTO professional_services (gym_id, name, slug, is_system) VALUES (?, 'Other', 'boxing-duo', 0)`, [gymA],
    )).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });
});
