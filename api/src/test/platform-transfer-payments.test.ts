// #2952 stage 2: Cordel → Export / Import of Payment Providers and Base Payment Methods.

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
const PROVIDER_SLUG = `transfer-provider-${STAMP}`;
const METHOD_SLUG = `transfer-method-${STAMP}`;
const METHOD_CODE = `transfer_method_${STAMP}`;
let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Transfer Payments Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await db.query('DELETE FROM payment_providers WHERE slug LIKE ?', ['transfer-provider-%']);
  await db.query(
    'DELETE FROM base_payment_method_translations WHERE base_payment_method_id IN (SELECT id FROM base_payment_methods WHERE slug LIKE ?)',
    ['transfer-method-%'],
  );
  await db.query('DELETE FROM base_payment_methods WHERE slug LIKE ?', ['transfer-method-%']);
  await cleanupTestGyms();
  await db.end();
});

describe('Export / Import of Payment Providers (#2952 stage 2)', () => {
  it('refuses a caller who is not a superadmin', async () => {
    platformRole.value = undefined;
    try {
      expect((await request.get('/platform/transfer/payment_providers').set(H).set('x-gym-id', gymId)).status).toBe(403);
      expect((await request.post('/platform/transfer/base_payment_methods').set(H).set('x-gym-id', gymId)
        .send({ slug: METHOD_SLUG })).status).toBe(403);
    } finally {
      platformRole.value = 'superadmin';
    }
  });

  it('exports each provider as its slug and its own fields, never the default flag', async () => {
    const res = await request.get('/platform/transfer/payment_providers').set(H);
    expect(res.status).toBe(200);
    expect(res.body.entities.length).toBeGreaterThan(0);
    for (const e of res.body.entities) {
      expect(typeof e.slug).toBe('string');
      expect(Object.keys(e.data).sort()).toEqual(['description', 'name', 'provider_key', 'status']);
      expect(e.images).toEqual({});
    }
  });

  it('creates a provider under the archive slug, then updates it in place, keeping the default flag', async () => {
    const created = await request.post('/platform/transfer/payment_providers').set(H)
      .send({ slug: PROVIDER_SLUG, name: `Transfer Provider ${STAMP}`, provider_key: 'monei', description: 'One', status: 'active', is_default: true, id: 999999 });
    expect(created.status).toBe(201);
    expect(created.body.action).toBe('created');
    expect(created.body.entity.slug).toBe(PROVIDER_SLUG);
    expect(created.body.entity.is_default).toBe(false);
    const id = created.body.entity.id;
    expect(id).not.toBe(999999);

    // A gym pointing at it: the relationship an update must not touch.
    await db.query('UPDATE gyms SET payment_provider_id = ? WHERE id = ?', [id, gymId]);

    const updated = await request.post('/platform/transfer/payment_providers').set(H)
      .send({ slug: PROVIDER_SLUG, name: `Transfer Provider ${STAMP} Renamed`, provider_key: 'monei', description: 'Two', status: 'active' });
    expect(updated.status).toBe(200);
    expect(updated.body.action).toBe('updated');
    expect(updated.body.entity.id).toBe(id);
    expect(updated.body.entity.slug).toBe(PROVIDER_SLUG);
    expect(updated.body.entity.name).toBe(`Transfer Provider ${STAMP} Renamed`);
    expect(updated.body.entity.description).toBe('Two');

    const gym = await db.query<{ payment_provider_id: number }>('SELECT payment_provider_id FROM gyms WHERE id = ?', [gymId]);
    expect(gym.rows[0].payment_provider_id).toBe(id);

    // The editor's rules hold: a provider gyms use cannot be made inactive by an import.
    const inactive = await request.post('/platform/transfer/payment_providers').set(H)
      .send({ slug: PROVIDER_SLUG, name: `Transfer Provider ${STAMP} Renamed`, provider_key: 'monei', status: 'inactive' });
    expect(inactive.status).toBe(409);

    const def = await db.query<{ id: number }>('SELECT id FROM payment_providers WHERE is_default = 1 AND deleted_at IS NULL');
    await db.query('UPDATE gyms SET payment_provider_id = ? WHERE id = ?', [def.rows[0].id, gymId]);
  });

  it('refuses a malformed slug and a soft-deleted slug', async () => {
    expect((await request.post('/platform/transfer/payment_providers').set(H)
      .send({ slug: 'Bad Slug', name: 'X', provider_key: 'monei' })).status).toBe(400);
    await db.query('UPDATE payment_providers SET deleted_at = UTC_TIMESTAMP() WHERE slug = ?', [PROVIDER_SLUG]);
    const res = await request.post('/platform/transfer/payment_providers').set(H)
      .send({ slug: PROVIDER_SLUG, name: 'Resurrected', provider_key: 'monei' });
    expect(res.status).toBe(409);
  });
});

describe('Export / Import of Base Payment Methods (#2952 stage 2)', () => {
  const translations = {
    en: { name: `Transfer Method ${STAMP}`, description: 'English' },
    es: { name: `Método ${STAMP}`, description: null },
  };

  it('exports each method with its code, status, translations and image slot', async () => {
    const res = await request.get('/platform/transfer/base_payment_methods').set(H);
    expect(res.status).toBe(200);
    const cash = res.body.entities.find((e: any) => e.data.code === 'cash');
    expect(cash.slug).toBeTruthy();
    expect(cash.data.translations.en.name).toBeTruthy();
    expect(cash.images).toHaveProperty('image');
  });

  it('creates a method under the archive slug, then updates its translations and status in place', async () => {
    const created = await request.post('/platform/transfer/base_payment_methods').set(H)
      .send({ slug: METHOD_SLUG, code: METHOD_CODE, status: 'active', translations });
    expect(created.status).toBe(201);
    expect(created.body.action).toBe('created');
    expect(created.body.entity.slug).toBe(METHOD_SLUG);
    const id = created.body.entity.id;

    const updated = await request.post('/platform/transfer/base_payment_methods').set(H)
      .send({
        slug: METHOD_SLUG, code: METHOD_CODE, status: 'inactive',
        translations: { en: { name: `Transfer Method ${STAMP} Renamed`, description: null }, ca: { name: `Mètode ${STAMP}`, description: null } },
      });
    expect(updated.status).toBe(200);
    expect(updated.body.action).toBe('updated');
    expect(updated.body.entity.id).toBe(id);
    expect(updated.body.entity.slug).toBe(METHOD_SLUG);
    expect(updated.body.entity.code).toBe(METHOD_CODE);
    expect(updated.body.entity.status).toBe('inactive');
    expect(updated.body.entity.translations.en.name).toBe(`Transfer Method ${STAMP} Renamed`);
    expect(updated.body.entity.translations.ca.name).toBe(`Mètode ${STAMP}`);
    expect(updated.body.entity.translations.es).toBeUndefined();

    const count = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM base_payment_methods WHERE slug = ?', [METHOD_SLUG]);
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it('never changes the code of an existing method', async () => {
    const res = await request.post('/platform/transfer/base_payment_methods').set(H)
      .send({ slug: METHOD_SLUG, code: `${METHOD_CODE}_other`, status: 'active', translations });
    expect(res.status).toBe(400);
    const row = await db.query<{ code: string }>('SELECT code FROM base_payment_methods WHERE slug = ?', [METHOD_SLUG]);
    expect(row.rows[0].code).toBe(METHOD_CODE);
  });

  it('refuses an image for an unknown slug or slot', async () => {
    const unknown = await request.post('/platform/transfer/base_payment_methods/transfer-method-missing/image/image').set(H)
      .set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(unknown.status).toBe(404);
    const slot = await request.post(`/platform/transfer/base_payment_methods/${METHOD_SLUG}/image/other`).set(H)
      .set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(slot.status).toBe(400);
  });
});
