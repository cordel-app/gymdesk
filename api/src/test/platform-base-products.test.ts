// #1822: Cordel → Base Products (/platform/base-products) and the gym-creation
// seed that reads them.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { seedDefaultGymProducts } from '../api/gym-default-products';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const superadminUser = { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Test Admin', firstName: 'Test', lastName: 'Admin' };
const regularUser = { publicMetadata: {}, fullName: 'Test User', firstName: 'Test', lastName: 'User' };

function mockUser(u: unknown) {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue(u as any);
}

const PREFIX = `TestBaseProd-${Date.now()}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER);
const body = (n: string, extra: Record<string, unknown> = {}) => ({
  name: `${PREFIX}-${n}`, type: 'fee', amount: 12.5, billing_frequency: 'month',
  status: 'active', enrollment_status: 'public', mandatory: false, one_time_purchase: false, ...extra,
});

let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym('BaseProductsGym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await db.query('DELETE FROM base_products WHERE name LIKE ?', [`${PREFIX}%`]);
  await cleanupTestGyms();
  await db.end();
});

beforeEach(() => mockUser(superadminUser));

describe('auth', () => {
  it('refuses a non-superadmin and an unauthenticated request', async () => {
    mockUser(regularUser);
    expect((await auth(request.get('/platform/base-products'))).status).toBe(403);
    expect((await auth(request.post('/platform/base-products')).send(body('x'))).status).toBe(403);
    expect((await request.get('/platform/base-products')).status).toBe(401);
  });
});

describe('CRUD', () => {
  let id: number;

  it('lists the seeded templates', async () => {
    const res = await auth(request.get('/platform/base-products'));
    expect(res.status).toBe(200);
    const names = res.body.map((r: any) => r.name);
    expect(names).toContain('Locker Rental');
    expect(names).toContain('Personal Training Class Package (10 Sessions)');
  });

  it('creates, reads, edits and filters a template', async () => {
    const created = await auth(request.post('/platform/base-products')).send(body('a'));
    expect(created.status).toBe(201);
    id = created.body.id;
    expect(created.body.amount).toBe(12.5);
    expect(created.body.mandatory).toBe(false);
    expect((await auth(request.get(`/platform/base-products/${id}`))).body.name).toBe(`${PREFIX}-a`);

    const put = await auth(request.put(`/platform/base-products/${id}`)).send({ amount: 20, mandatory: true });
    expect(put.status).toBe(200);
    expect(put.body.amount).toBe(20);
    expect(put.body.mandatory).toBe(true);
    // A field the request did not mention is kept.
    expect(put.body.billing_frequency).toBe('month');

    const found = await auth(request.get('/platform/base-products')).query({ q: PREFIX });
    expect(found.body.map((r: any) => r.id)).toEqual([id]);
  });

  it('rejects invalid input without coercion', async () => {
    const bad: Array<Record<string, unknown>> = [
      { billing_frequency: 'week' }, { billing_frequency: 'per_session' }, { type: 'merchandise' },
      { amount: -1 }, { mandatory: 'false' }, { type: 'sessions' }, { type: 'fee', units: 5 },
      { enrollment_status: 'hidden' }, { charge_type_code: 'membership_fee' },
    ];
    for (const extra of bad) {
      const r = await auth(request.post('/platform/base-products')).send(body('bad', extra));
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('refuses a duplicate live name and allows reuse after delete', async () => {
    const dup = await auth(request.post('/platform/base-products')).send(body('a'));
    expect(dup.status).toBe(409);
    expect((await auth(request.delete(`/platform/base-products/${id}`))).status).toBe(204);
    expect((await auth(request.get(`/platform/base-products/${id}`))).status).toBe(404);
    expect((await auth(request.put(`/platform/base-products/${id}`)).send({ amount: 1 })).status).toBe(404);
    expect((await auth(request.post('/platform/base-products')).send(body('a'))).status).toBe(201);
  });
});

describe('gym generation', () => {
  it('copies a template into a new gym, and an edit affects only later gyms', async () => {
    const created = await auth(request.post('/platform/base-products')).send(body('gen', { amount: 7 }));
    expect(created.status).toBe(201);
    await seedDefaultGymProducts(gymId);
    const first = await db.query<any>('SELECT amount, is_system FROM products WHERE gym_id = ? AND name = ?', [gymId, `${PREFIX}-gen`]);
    expect(first.rows).toHaveLength(1);
    expect(Number(first.rows[0].amount)).toBe(7);

    await auth(request.put(`/platform/base-products/${created.body.id}`)).send({ amount: 99 });
    const after = await db.query<any>('SELECT amount FROM products WHERE gym_id = ? AND name = ?', [gymId, `${PREFIX}-gen`]);
    expect(Number(after.rows[0].amount)).toBe(7);

    const otherGym = await createTestGym('BaseProductsGym2');
    await seedDefaultGymProducts(otherGym);
    const next = await db.query<any>('SELECT amount FROM products WHERE gym_id = ? AND name = ?', [otherGym, `${PREFIX}-gen`]);
    expect(Number(next.rows[0].amount)).toBe(99);
  });

  it('still seeds the System Products of the catalogue for a gym', async () => {
    const g = await createTestGym('BaseProductsGym3');
    await seedDefaultGymProducts(g);
    const { rows } = await db.query<any>('SELECT name FROM products WHERE gym_id = ? AND name IN (?, ?)', [g, 'Locker Rental', 'Insurance Fee']);
    expect(rows).toHaveLength(2);
  });
});
