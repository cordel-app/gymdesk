// #2125 stage 21 — coverage is each Membership Plan assignment's own (Oscar, 2026-11-02): covering a
// Member on one of an owner's plans does not cover them on another, the member limit is per plan,
// and adding or removing coverage on one plan leaves the others alone.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { loadMemberProfessionalServiceGrants } from '../domain/memberProfessionalServices';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;

beforeAll(async () => {
  gymId = await createTestGym('Coverage per plan gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

const call = (method: 'get' | 'post' | 'put' | 'delete', path: string, body?: unknown) => {
  const r = request[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
  return body === undefined ? r : r.send(body as object);
};
async function member(name: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, name, `cov-${uniq()}@example.com`]);
  return insertId;
}
async function plan(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '2')`, [gymId, `${name}-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 20, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
async function assign(memberId: number, planId: number, startsAt: string, onConflict?: 'add'): Promise<number> {
  const created = await call('post', '/user-memberships', { member_id: memberId, membership_plan_id: planId, starts_at: startsAt });
  expect(created.status).toBe(201);
  const res = await call('post', `/user-memberships/${created.body.id}/activate`, onConflict ? { on_conflict: onConflict } : {});
  expect(res.status).toBe(200);
  return created.body.id as number;
}
const coveredOn = async (umId: number): Promise<number[]> => {
  const res = await call('get', `/user-memberships/${umId}/members`);
  expect(res.status).toBe(200);
  return res.body.members.map((m: any) => Number(m.member_id)).sort((a: number, b: number) => a - b);
};

describe('coverage per Membership Plan (#2125 stage 21)', () => {
  it('covers a Member on one plan only, with the limit counted per plan', async () => {
    const owner = await member('Peter');
    const ana = await member('Ana');
    const bob = await member('Bob');
    const umA = await assign(owner, await plan('Cov A'), '2026-01-01');
    const umB = await assign(owner, await plan('Cov B'), '2026-02-01', 'add');

    const first = await call('post', `/user-memberships/${umA}/members`, { member_id: ana });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(await coveredOn(umA)).toEqual([owner, ana].sort((a, b) => a - b));
    expect(await coveredOn(umB)).toEqual([owner]);

    // Plan A is at its limit of two; plan B still has room for the same person.
    expect((await call('post', `/user-memberships/${umA}/members`, { member_id: bob })).status).toBe(400);
    expect((await call('post', `/user-memberships/${umB}/members`, { member_id: bob })).status).toBe(201);
    expect(await coveredOn(umA)).toEqual([owner, ana].sort((a, b) => a - b));
    expect(await coveredOn(umB)).toEqual([owner, bob].sort((a, b) => a - b));

    // The same Member may be covered by both plans, and removing one leaves the other.
    expect((await call('post', `/user-memberships/${umB}/members`, { member_id: ana })).status).toBe(400); // B is full
    expect((await call('delete', `/user-memberships/${umA}/members/${ana}`)).status).toBe(204);
    expect(await coveredOn(umA)).toEqual([owner]);
    expect(await coveredOn(umB)).toEqual([owner, bob].sort((a, b) => a - b));

    // No chain-level coverage table is left behind.
    const { rows: tables } = await db.query<any>("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_set_members'");
    expect(Number(tables[0].n)).toBe(0);
  });
});

describe('the payer is not a beneficiary by default (#2125 stage 22)', () => {
  async function planWithSessions(): Promise<number> {
    const planId = await plan('Payer');
    const { insertId: serviceId } = await db.query(
      `INSERT INTO professional_services (gym_id, name, is_system) VALUES (?, ?, 0)`, [gymId, `PS-${uniq()}`]);
    await db.query(`INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`, [gymId, serviceId]);
    const { insertId: productId } = await db.query(
      `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system, units)
       VALUES (?, ?, 'sessions', 0, 'EUR', 'once', 'active', 'available', 0, 1)`, [gymId, `Sess-${uniq()}`]);
    await db.query('INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)', [gymId, productId, serviceId]);
    await db.query(`INSERT INTO membership_plan_session (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, 4)`, [gymId, planId, productId]);
    return planId;
  }
  const planSessions = async (memberId: number) =>
    (await loadMemberProfessionalServiceGrants(gymId, memberId)).filter((g) => g.kind === 'plan_session');

  it('the payer sees the plan but holds none of its sessions until they are a beneficiary', async () => {
    const peter = await member('Peter');
    const mary = await member('Mary');
    const planId = await planWithSessions();
    const created = await call('post', '/user-memberships', {
      member_id: peter, membership_plan_id: planId, starts_at: '2026-01-01', owner_is_beneficiary: false });
    expect(created.status).toBe(201);
    const um = created.body.id as number;
    expect((await call('post', `/user-memberships/${um}/activate`, {})).status).toBe(200);

    // The plan is Peter's (he is the payer) but nobody is covered yet.
    expect(await coveredOn(um)).toEqual([]);
    expect(await planSessions(peter)).toHaveLength(0);

    expect((await call('post', `/user-memberships/${um}/members`, { member_id: mary })).status).toBe(201);
    expect(await coveredOn(um)).toEqual([mary]);
    expect(await planSessions(mary)).toHaveLength(1);
    expect(await planSessions(peter)).toHaveLength(0);

    // Making the payer a beneficiary, and taking them out again, only moves their own place.
    expect((await call('post', `/user-memberships/${um}/members`, { member_id: peter })).status).toBe(201);
    expect(await coveredOn(um)).toEqual([peter, mary].sort((a, b) => a - b));
    expect(await planSessions(peter)).toHaveLength(1);
    expect((await call('delete', `/user-memberships/${um}/members/${peter}`)).status).toBe(204);
    expect(await coveredOn(um)).toEqual([mary]);
    expect(await planSessions(peter)).toHaveLength(0);
  });

  it('a plan created the usual way still covers its payer', async () => {
    const solo = await member('Solo');
    const um = await assign(solo, await plan('Solo'), '2026-01-01');
    expect(await coveredOn(um)).toEqual([solo]);
  });
});
