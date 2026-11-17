// #2952 stage 7: Cordel → Export / Import of Gyms.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const platformRole = vi.hoisted(() => ({ value: 'superadmin' as string | undefined }));

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockImplementation(async () => ({
          publicMetadata: platformRole.value ? { platform_role: platformRole.value } : {},
          fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
        })),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: { createInvitation: vi.fn().mockResolvedValue({ id: 'inv' }), revokeInvitation: vi.fn().mockResolvedValue({}) },
      emailAddresses: { getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 't@example.com' }) },
    })),
  };
});

const H = { Authorization: TEST_AUTH_HEADER };
const STAMP = Date.now();
const GYM_SLUG = `transfer-gym-${STAMP}`;
let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Transfer Gyms Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  // Gyms the import created are hard-deleted here; their seeds cascade from the gym row.
  const { rows } = await db.query<{ id: string }>('SELECT id FROM gyms WHERE slug LIKE ?', ['transfer-gym-%']);
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    await db.query(`DELETE FROM products WHERE gym_id IN (${marks})`, ids);
    await db.query(`DELETE FROM gyms WHERE id IN (${marks})`, ids);
  }
  await cleanupTestGyms();
  await db.end();
});

describe('Export / Import of Gyms (#2952 stage 7)', () => {
  it('refuses a caller who is not a superadmin', async () => {
    platformRole.value = undefined;
    try {
      expect((await request.get('/platform/transfer/gyms').set(H).set('x-gym-id', gymId)).status).toBe(403);
      expect((await request.post('/platform/transfer/gyms').set(H).set('x-gym-id', gymId)
        .send({ slug: GYM_SLUG, name: 'x' })).status).toBe(403);
    } finally {
      platformRole.value = 'superadmin';
    }
  });

  it('exports each live gym as its slug and its own fields only', async () => {
    const res = await request.get('/platform/transfer/gyms').set(H);
    expect(res.status).toBe(200);
    const { rows: [own] } = await db.query<any>('SELECT slug FROM gyms WHERE id = ?', [gymId]);
    expect(res.body.entities.some((e: any) => e.slug === own.slug)).toBe(true);
    for (const e of res.body.entities) {
      expect(typeof e.slug).toBe('string');
      expect(Object.keys(e.data).sort()).toEqual(['description', 'name', 'plan', 'status']);
      expect(e.images).toEqual({});
    }
  });

  it('creates a gym under the archive slug, seeded like a new gym, honouring an inactive status', async () => {
    const created = await request.post('/platform/transfer/gyms').set(H).send({
      slug: GYM_SLUG, name: `Transfer Gym ${STAMP}`, description: 'One', plan: 'pro', status: 'inactive',
      theme_id: 999999, payment_provider_id: 999999, id: 'not-an-id',
    });
    expect(created.status).toBe(201);
    expect(created.body.action).toBe('created');
    expect(created.body.entity.slug).toBe(GYM_SLUG);
    expect(created.body.entity.plan).toBe('pro');
    expect(created.body.entity.status).toBe('inactive');
    expect(created.body.entity.theme_id).toBeNull();
    const id = created.body.entity.id;
    const { rows: centers } = await db.query('SELECT id FROM centers WHERE gym_id = ?', [id]);
    expect(centers.length).toBe(1);
    const { rows: taxes } = await db.query('SELECT id FROM tax_rates WHERE gym_id = ? AND is_system = 1', [id]);
    expect(taxes.length).toBe(1);
  });

  it('updates the gym carrying the slug in place, keeping its slug, plan and references', async () => {
    const { rows: [before] } = await db.query<any>('SELECT * FROM gyms WHERE slug = ?', [GYM_SLUG]);
    const updated = await request.post('/platform/transfer/gyms').set(H).send({
      slug: GYM_SLUG, name: `Transfer Gym Renamed ${STAMP}`, description: 'Two', plan: 'enterprise', status: 'active',
      theme_id: null, payment_provider_id: null,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.action).toBe('updated');
    const { rows: [after] } = await db.query<any>('SELECT * FROM gyms WHERE slug = ?', [GYM_SLUG]);
    expect(after.id).toBe(before.id);
    expect(after.name).toBe(`Transfer Gym Renamed ${STAMP}`);
    expect(after.description).toBe('Two');
    expect(after.status).toBe('active');
    expect(after.plan).toBe(before.plan);
    expect(after.payment_provider_id).toBe(before.payment_provider_id);
    expect(after.theme_id).toBe(before.theme_id);
    expect(after.storage_folder_prefix).toBe(before.storage_folder_prefix);
    const { rows: count } = await db.query<any>('SELECT COUNT(*) AS n FROM gyms WHERE slug = ?', [GYM_SLUG]);
    expect(Number(count[0].n)).toBe(1);
  });

  it('refuses a malformed slug, an unknown status and a slug of a deleted gym', async () => {
    expect((await request.post('/platform/transfer/gyms').set(H).send({ slug: 'Bad Slug', name: 'x' })).status).toBe(400);
    expect((await request.post('/platform/transfer/gyms').set(H)
      .send({ slug: GYM_SLUG, status: 'deleted' })).status).toBe(400);
    const deletedSlug = `${GYM_SLUG}-deleted`;
    const created = await request.post('/platform/transfer/gyms').set(H).send({ slug: deletedSlug, name: 'Deleted one' });
    expect(created.status).toBe(201);
    expect((await request.delete(`/platform/gyms/${created.body.entity.id}`).set(H)).status).toBe(204);
    const again = await request.post('/platform/transfer/gyms').set(H).send({ slug: deletedSlug, name: 'Back' });
    expect(again.status).toBe(409);
  });
});
