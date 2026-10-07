// #1187 — catalogue-mandatory Products (`products.mandatory = 1`) are billed per
// covered Member on the Assigned Plan snapshot, and follow Members added/removed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

async function member(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Qty Member', `qty-${uniq()}@test.com`],
  );
  return insertId;
}

async function product(gymId: string, mandatory: boolean, type: string, freq: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system, mandatory)
     VALUES (?, ?, ?, 50, 'EUR', ?, 'active', 'available', 0, ?)`,
    [gymId, `Qty-Item-${uniq()}`, type, freq, mandatory ? 1 : 0],
  );
  return insertId;
}

const http = (method: 'post' | 'delete', gymId: string, path: string, body?: object) => {
  const r = request[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
  return body ? r.send(body) : r;
};

async function quantities(gymId: string, umId: number) {
  const out: Record<string, number> = {};
  for (const [key, table] of [
    ['oneoff', 'user_membership_oneoff'],
    ['session', 'user_membership_session'],
    ['periodical', 'user_membership_periodical'],
  ]) {
    const { rows } = await db.query(
      `SELECT product_id, quantity FROM ${table} WHERE user_membership_id = ? AND gym_id = ?`,
      [umId, gymId],
    );
    for (const r of rows) out[`${key}:${r.product_id}`] = Number(r.quantity);
  }
  return out;
}

describe('mandatory Product quantity follows the covered Members', () => {
  let gymId: string;
  let planId: number;
  let regFee: number;     // mandatory, one-off
  let insurance: number;  // mandatory, periodical, Plan quantity 2
  let sessions: number;   // mandatory, session
  let locker: number;     // not mandatory, periodical
  let umId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Qty Gym');
    await createTestMembership(gymId, 'admin');
    regFee = await product(gymId, true, 'fee', 'once');
    insurance = await product(gymId, true, 'service', 'month');
    sessions = await product(gymId, true, 'sessions', 'per_session');
    locker = await product(gymId, false, 'service', 'month');
    const { insertId } = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
       VALUES (?, ?, 'active', 'public', 'family')`,
      [gymId, `Qty-Plan-${uniq()}`],
    );
    planId = insertId;
    const add = (table: string, pid: number, q: number) => db.query(
      `INSERT INTO ${table} (gym_id, membership_plan_id, product_id, quantity, mandatory) VALUES (?, ?, ?, ?, 0)`,
      [gymId, planId, pid, q],
    );
    await add('membership_plan_oneoff', regFee, 1);
    await add('membership_plan_periodical', insurance, 2);
    await add('membership_plan_periodical', locker, 2);
    await add('membership_plan_session', sessions, 5);

    const res = await http('post', gymId, '/user-memberships', {
      member_id: await member(gymId), membership_plan_id: planId,
      starts_at: new Date().toISOString().slice(0, 10),
    });
    expect(res.status).toBe(201);
    umId = res.body.id;
  });

  it('a one-member assignment takes quantity 1 on mandatory lines only', async () => {
    const q = await quantities(gymId, umId);
    expect(q[`oneoff:${regFee}`]).toBe(1);
    expect(q[`periodical:${insurance}`]).toBe(1); // replaced, not kept at 2
    expect(q[`session:${sessions}`]).toBe(1);
    expect(q[`periodical:${locker}`]).toBe(2);    // untouched
  });

  it('adding a Member raises them, removing lowers them, a plain line never moves', async () => {
    const b = await member(gymId);
    const c = await member(gymId);
    expect((await http('post', gymId, `/user-memberships/${umId}/members`, { member_id: b })).status).toBe(201);
    expect((await http('post', gymId, `/user-memberships/${umId}/members`, { member_id: c })).status).toBe(201);
    let q = await quantities(gymId, umId);
    expect(q[`oneoff:${regFee}`]).toBe(3);
    expect(q[`periodical:${insurance}`]).toBe(3);
    expect(q[`session:${sessions}`]).toBe(3);
    expect(q[`periodical:${locker}`]).toBe(2);

    expect((await http('delete', gymId, `/user-memberships/${umId}/members/${c}`)).status).toBe(204);
    q = await quantities(gymId, umId);
    expect(q[`oneoff:${regFee}`]).toBe(2);
    expect(q[`periodical:${locker}`]).toBe(2);
  });

  it('never rewrites the Plan configuration', async () => {
    const { rows } = await db.query(
      'SELECT quantity FROM membership_plan_periodical WHERE membership_plan_id = ? AND product_id = ?',
      [planId, insurance],
    );
    expect(Number(rows[0].quantity)).toBe(2);
  });

  it('keeps the owner-removal restriction', async () => {
    const { rows } = await db.query(
      'SELECT member_id FROM user_membership_members WHERE user_membership_id = ? AND is_owner = 1', [umId],
    );
    const res = await http('delete', gymId, `/user-memberships/${umId}/members/${rows[0].member_id}`);
    expect(res.status).toBe(400);
    expect((await quantities(gymId, umId))[`oneoff:${regFee}`]).toBe(2);
  });
});
