// #2951 stage 1: Payment Providers, Base Payment Methods and Gyms get a slug on
// creation, generated from the name, unique within the table, never changed by
// an edit.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, request } from './helpers';

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
const providerIds: number[] = [];
const methodIds: number[] = [];
const gymIds: string[] = [];

afterAll(async () => {
  if (gymIds.length) {
    const marks = gymIds.map(() => '?').join(',');
    await db.query(`DELETE FROM products WHERE gym_id IN (${marks})`, gymIds);
    await db.query(`DELETE FROM gyms WHERE id IN (${marks})`, gymIds);
  }
  await cleanupTestGyms();
  if (providerIds.length) {
    await db.query(`DELETE FROM payment_providers WHERE id IN (${providerIds.map(() => '?').join(',')})`, providerIds);
  }
  if (methodIds.length) {
    await db.query(`DELETE FROM base_payment_methods WHERE id IN (${methodIds.map(() => '?').join(',')})`, methodIds);
  }
  await db.end();
});

const post = (path: string, body: Record<string, unknown>) =>
  request.post(path).set('Authorization', TEST_AUTH_HEADER).send(body);
const put = (path: string, body: Record<string, unknown>) =>
  request.put(path).set('Authorization', TEST_AUTH_HEADER).send(body);

describe('Payment Providers', () => {
  it('generates the slug from the name, suffixes a duplicate and keeps it on rename', async () => {
    const name = `Équilibre Pay (1:1) ${RUN}`;
    const first = await post('/platform/payment-providers', { name, provider_key: 'monei' });
    expect(first.status).toBe(201);
    providerIds.push(Number(first.body.id));
    expect(first.body.slug).toBe(`equilibre-pay-1-1-${RUN}`);

    // Same slug base under another name (punctuation differs, slug does not).
    const second = await post('/platform/payment-providers', { name: `Equilibre Pay 1 1 ${RUN}`, provider_key: 'monei' });
    expect(second.status).toBe(201);
    providerIds.push(Number(second.body.id));
    expect(second.body.slug).toBe(`equilibre-pay-1-1-${RUN}-2`);

    const renamed = await put(`/platform/payment-providers/${first.body.id}`, { name: `Renamed ${RUN}`, slug: 'hacked' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe(`Renamed ${RUN}`);
    expect(renamed.body.slug).toBe(first.body.slug);
  });
});

describe('Base Payment Methods', () => {
  it('generates the slug from the English name and keeps it when the translations change', async () => {
    const code = `slug_${RUN}`;
    const created = await post('/platform/base-payment-methods', {
      code,
      translations: { en: { name: `Tarjeta Regalo ${RUN}` } },
    });
    expect(created.status).toBe(201);
    methodIds.push(Number(created.body.id));
    expect(created.body.slug).toBe(`tarjeta-regalo-${RUN}`);

    const edited = await put(`/platform/base-payment-methods/${created.body.id}`, {
      translations: { en: { name: `Gift Card ${RUN}` } },
      slug: 'hacked',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.slug).toBe(`tarjeta-regalo-${RUN}`);
  });
});

describe('Gyms', () => {
  it('generates a slug by the shared rule, suffixes a duplicate and keeps it on rename', async () => {
    const name = `Gimnàs Slug ${RUN}`;
    const first = await post('/platform/gyms', { name });
    expect(first.status).toBe(201);
    gymIds.push(first.body.id);
    expect(first.body.slug).toBe(`gimnas-slug-${RUN}`);

    const second = await post('/platform/gyms', { name: `Gimnas  Slug ${RUN}` });
    expect(second.status).toBe(201);
    gymIds.push(second.body.id);
    expect(second.body.slug).toBe(`gimnas-slug-${RUN}-2`);

    const renamed = await put(`/platform/gyms/${first.body.id}`, { name: `Another Name ${RUN}`, slug: 'hacked' });
    expect(renamed.status).toBe(200);
    const { rows } = await db.query<{ slug: string }>('SELECT slug FROM gyms WHERE id = ?', [first.body.id]);
    expect(rows[0].slug).toBe(`gimnas-slug-${RUN}`);
  });
});
