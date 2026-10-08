// #1227 stage 1 — the Member's Professional Services balance, history and
// staff adjustment. Mounted under /members/:memberId/professional-services.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const auth = (r: any, gymId: string) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(gymId: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Wallet Member', `wallet-${Date.now()}-${Math.random()}@test.com`]);
  return insertId;
}
async function service(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)',
    [gymId, `Wallet-Service-${Date.now()}`]);
  await db.query('INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, ?)',
    [gymId, insertId, 'active']);
  return insertId;
}

describe('Professional Service balance adjustment', () => {
  let gymId: string; let memberId: number; let serviceId: number;
  beforeAll(async () => {
    gymId = await createTestGym('Wallet Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await member(gymId);
    serviceId = await service(gymId);
  });

  const adjust = (body: unknown, g = () => gymId) =>
    auth(request.post(`/members/${memberId}/professional-services/${serviceId}/adjust`), g()).send(body as object);

  it('sets the balance up and records the delta with before and after', async () => {
    const res = await adjust({ new_balance: 5, reason: 'Goodwill' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available_items: 5, changed: true });
    const { rows } = await db.query(
      'SELECT delta, balance_before, balance_after, reason FROM professional_service_adjustments WHERE member_id = ?', [memberId]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].delta)).toBe(5);
    expect(Number(rows[0].balance_before)).toBe(0);
  });

  it('lowers the balance and shows it in the wallet and history', async () => {
    expect((await adjust({ new_balance: 3 })).body.available_items).toBe(3);
    const wallet = await auth(request.get(`/members/${memberId}/professional-services/wallet`), gymId);
    expect(wallet.body.find((w: any) => w.professional_service_id === serviceId).available_items).toBe(3);
    const history = await auth(request.get(`/members/${memberId}/professional-services/${serviceId}/history`), gymId);
    expect(history.body.map((h: any) => h.quantity)).toEqual([-2, 5]);
  });

  it('is a no-op when the balance is unchanged', async () => {
    const res = await adjust({ new_balance: 3 });
    expect(res.body.changed).toBe(false);
  });

  it('rejects a negative or non-integer balance', async () => {
    expect((await adjust({ new_balance: -1 })).status).toBe(400);
    expect((await adjust({ new_balance: 1.5 })).status).toBe(400);
  });

  it('404s across tenants and for an unknown service', async () => {
    const other = await createTestGym('Wallet Other Gym');
    await createTestMembership(other, 'admin');
    expect((await adjust({ new_balance: 1 }, () => other)).status).toBe(404);
    const res = await auth(request.post(`/members/${memberId}/professional-services/99999999/adjust`), gymId).send({ new_balance: 1 });
    expect(res.status).toBe(404);
  });

  it('requires write access and authentication', async () => {
    const g = await createTestGym('Wallet Accountant Gym');
    await createTestMembership(g, 'accountant');
    const m = await member(g);
    const s = await service(g);
    const res = await auth(request.post(`/members/${m}/professional-services/${s}/adjust`), g).send({ new_balance: 1 });
    expect(res.status).toBe(403);
    const anon = await request.post(`/members/${m}/professional-services/${s}/adjust`).send({ new_balance: 1 });
    expect(anon.status).toBe(401);
  });
});
