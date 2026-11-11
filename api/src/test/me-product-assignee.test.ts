// #2609 stage 2 — the Members App half: a member in a family reads who a Product
// may be for (`GET /me/products/assignees`), the catalogue says which Products are
// shared, and `POST /me/products/:id/purchase` stores the chosen family member —
// refusing an outsider — and `GET /me/purchases` reports it.
//
// Only the provider's `createPaymentRequest` is stubbed, so no HTTP reaches Monei.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

vi.mock('../payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../payments')>();
  return {
    ...actual,
    getPaymentProvider: () => {
      const real = actual.getPaymentProvider();
      return {
        parseWebhook: real.parseWebhook.bind(real),
        createPaymentRequest: async (params: any) => (
          { providerOrderId: `monei-${params.orderId}`, checkoutUrl: 'https://pay.test/x' }),
      };
    },
  };
});

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const OWNER_CLERK = `mpa-owner-${uniq()}`;
const LONER_CLERK = `mpa-loner-${uniq()}`;

let owner: number;
let kid: number;
let stranger: number;
let loner: number;
let oneOff: number;
let shared: number;

async function member(name: string, clerk: string | null = null): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, name, `mpa-${uniq()}@test.com`, clerk]);
  return insertId;
}

async function product(name: string, sharing: 'individual' | 'shared' = 'individual'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior, sharing_type)
     VALUES (?, ?, 'fee', 'once', 'active', 'public', 0, 'EUR', '30.00', 'inclusive', ?)`,
    [gymId, name, sharing]);
  return insertId;
}

const staff = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
function asMember(clerk: string, r: any) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
}

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  gymId = await createTestGym('Member product assignee gym');
  await createTestMembership(gymId);
  await createTestMembership(gymId, 'member', OWNER_CLERK);
  await createTestMembership(gymId, 'member', LONER_CLERK);
  owner = await member('Family Owner', OWNER_CLERK);
  kid = await member('Family Kid');
  stranger = await member('Not Family');
  loner = await member('Lone Member', LONER_CLERK);
  await staff(request.post(`/members/${owner}/family`)).send({});
  await staff(request.post(`/members/${owner}/family/members`)).send({ member_id: kid });
  oneOff = await product(`Locker ${uniq()}`);
  shared = await product(`Family box ${uniq()}`, 'shared');
});

afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  await db.query('DELETE FROM member_products_oneoff_snapshot WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/products/assignees', () => {
  it('answers 401 without auth', async () => {
    expect((await request.get('/me/products/assignees').set('x-gym-id', gymId)).status).toBe(401);
  });

  it("lists the caller's family, owner first, with the caller's own id", async () => {
    const res = await asMember(OWNER_CLERK, request.get('/me/products/assignees'));
    expect(res.status).toBe(200);
    expect(res.body.member_id).toBe(owner);
    expect(res.body.members.map((m: any) => [m.member_id, m.name, m.is_owner]))
      .toEqual([[owner, 'Family Owner', true], [kid, 'Family Kid', false]]);
  });

  it('is empty for a member with no family', async () => {
    const res = await asMember(LONER_CLERK, request.get('/me/products/assignees'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ member_id: loner, members: [] });
  });
});

describe('GET /me/products', () => {
  it('reports whether each Product is individual or shared', async () => {
    const res = await asMember(OWNER_CLERK, request.get('/me/products'));
    expect(res.status).toBe(200);
    const byId = new Map(res.body.items.map((i: any) => [i.id, i]));
    expect((byId.get(oneOff) as any).sharing_type).toBe('individual');
    expect((byId.get(shared) as any).sharing_type).toBe('shared');
  });
});

describe('POST /me/products/:id/purchase', () => {
  it('refuses a member outside the family and writes nothing', async () => {
    const res = await asMember(OWNER_CLERK, request.post(`/me/products/${oneOff}/purchase`))
      .send({ assigned_member_id: stranger });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('assignee_not_in_family');
    const { rows } = await db.query<any>(
      'SELECT id FROM member_products_oneoff_snapshot WHERE gym_id = ? AND member_id = ?', [gymId, owner]);
    expect(rows).toHaveLength(0);
  });

  it('stores the chosen family member and lists it on the purchases', async () => {
    const res = await asMember(OWNER_CLERK, request.post(`/me/products/${oneOff}/purchase`))
      .send({ assigned_member_id: kid });
    expect(res.status).toBe(201);
    const { rows } = await db.query<any>(
      'SELECT id, assigned_member_id FROM member_products_oneoff_snapshot WHERE gym_id = ? AND member_id = ? AND product_id = ?',
      [gymId, owner, oneOff]);
    expect(rows[0].assigned_member_id).toBe(kid);

    const own = await asMember(OWNER_CLERK, request.get('/me/purchases'));
    const row = own.body.items.find((i: any) => i.id === rows[0].id);
    expect(row).toMatchObject({ assigned_member_id: kid, assigned_member_name: 'Family Kid' });
  });

  it('defaults to the buyer when nothing is named', async () => {
    const res = await asMember(LONER_CLERK, request.post(`/me/products/${oneOff}/purchase`)).send({});
    expect(res.status).toBe(201);
    const { rows } = await db.query<any>(
      'SELECT assigned_member_id FROM member_products_oneoff_snapshot WHERE gym_id = ? AND member_id = ?', [gymId, loner]);
    expect(rows[0].assigned_member_id).toBe(loner);
  });
});
