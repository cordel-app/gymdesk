// #2123 stage 4: a family change that moves the payer is refused when it would strand an obligation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
const TODAY = new Date().toISOString().slice(0, 10);

const api = {
  post: (p: string, b: object = {}) => request.post(p).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send(b),
  put: (p: string, b: object = {}) => request.put(p).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send(b),
  del: (p: string) => request.delete(p).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId),
};

async function member(name: string, withCard = false): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `fpc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`]);
  if (withCard) {
    await db.query(
      `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id) VALUES (?, ?, 'monei', 'tok', 'seq')`,
      [gymId, insertId]);
  }
  return insertId as number;
}
async function makeFamily(owner: number, ...others: number[]) {
  await api.post(`/members/${owner}/family`);
  for (const o of others) await api.post(`/members/${owner}/family/members`, { member_id: o });
}
async function scheduledEvent(beneficiary: number) {
  const s = await db.query(
    `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at) VALUES (?, ?, 'active', ?)`, [gymId, beneficiary, TODAY]);
  await db.query('UPDATE product_sets SET root_product_set_id = id WHERE id = ?', [s.insertId]);
  const e = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, product_set_id, billing_date, is_scheduled)
     VALUES (?, ?, 'charge_created', 'system', 25, ?, '2999-01-01', 1)`, [gymId, beneficiary, s.insertId]);
  return e.insertId as number;
}

beforeAll(async () => {
  gymId = await createTestGym('Family payer change gym');
  await createTestMembership(gymId);
});
afterAll(async () => {
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('family payer change guard', () => {
  it('changes the owner when the new owner has a card, and when nothing is owed', async () => {
    const owner = await member('O1', true);
    const kid = await member('K1', true);
    await makeFamily(owner, kid);
    await scheduledEvent(kid);
    const res = await api.put(`/members/${owner}/family/owner`, { member_id: kid });
    expect(res.status).toBe(200);
    expect(res.body.family.owner_member_id).toBe(kid);
  });

  it('refuses an owner change to a member with no card while family obligations are scheduled', async () => {
    const owner = await member('O2', true);
    const kid = await member('K2'); // no card
    await makeFamily(owner, kid);
    await scheduledEvent(kid);
    const res = await api.put(`/members/${owner}/family/owner`, { member_id: kid });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('payer_without_card');
    expect(res.body.member_ids).toContain(kid);
    const after = await request.get(`/members/${owner}/family`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(after.body.family.owner_member_id).toBe(owner);
  });

  it('allows an owner change to a card-less member when nothing is owed', async () => {
    const owner = await member('O3', true);
    const kid = await member('K3');
    await makeFamily(owner, kid);
    expect((await api.put(`/members/${owner}/family/owner`, { member_id: kid })).status).toBe(200);
  });

  it('refuses removing a member who would become a card-less payer of their own obligations', async () => {
    const owner = await member('O4', true);
    const kid = await member('K4'); // no card
    await makeFamily(owner, kid);
    await scheduledEvent(kid);
    const res = await api.del(`/members/${owner}/family/members/${kid}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('payer_without_card');
  });

  it('refuses dissolving while a member would be left unable to pay', async () => {
    const owner = await member('O5', true);
    const kid = await member('K5');
    await makeFamily(owner, kid);
    await scheduledEvent(kid);
    const res = await api.del(`/members/${owner}/family`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('payer_without_card');
  });

  it('refuses any change while a family member has a payment in flight', async () => {
    const owner = await member('O6', true);
    const kid = await member('K6', true);
    await makeFamily(owner, kid);
    const eventId = await scheduledEvent(kid);
    await db.query(
      `INSERT INTO payment_requests (gym_id, member_id, amount, currency, billing_event_id, status, source, provider, provider_order, attempt)
       VALUES (?, ?, 25, 'EUR', ?, 'pending', 'billing_run', 'monei', ?, 1)`, [gymId, kid, eventId, `ord-${Date.now()}`]);
    const res = await api.del(`/members/${owner}/family/members/${kid}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('payment_in_flight');
  });
});
