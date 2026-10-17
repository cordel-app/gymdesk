// #1325 PR 3e — the Admin's Draft assignment is a ProductSet Draft from birth.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { expireDrafts } from '../api/product-sets';

let gymId: string;
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

beforeAll(async () => {
  gymId = await createTestGym('Draft Set Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function plan(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `${name}-${uniq()}`]);
  return insertId;
}
async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Draft Set', `ds-${uniq()}@test.com`]);
  return insertId;
}
const api = (method: 'post' | 'put' | 'delete', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function draftSetOf(umId: number) {
  const { rows } = await db.query<any>(
    'SELECT id, status, owner_member_id FROM product_sets WHERE gym_id = ? AND user_membership_id = ?', [gymId, umId]);
  return rows[0] ?? null;
}

describe('a Draft assignment is created set-first', () => {
  it('links a Draft ProductSet to the assignment row at creation', async () => {
    const m = await member();
    const res = await api('post', '/user-memberships')
      .send({ member_id: m, membership_plan_id: await plan('P'), starts_at: '2026-06-01' });
    expect(res.status).toBe(201);
    const set = await draftSetOf(res.body.id);
    expect(set).toMatchObject({ status: 'draft', owner_member_id: m });
  });

  it('assigning again while a Draft is open replaces it: one Draft, the latest plan (#1707)', async () => {
    const m = await member();
    const first = await api('post', '/user-memberships')
      .send({ member_id: m, membership_plan_id: await plan('A'), starts_at: '2026-06-01' });
    expect(first.status).toBe(201);
    const planB = await plan('B');
    const second = await api('post', '/user-memberships')
      .send({ member_id: m, membership_plan_id: planB, starts_at: '2026-06-01' });
    expect(second.status).toBe(201);
    const { rows } = await db.query<any>('SELECT id, membership_plan_id FROM user_memberships WHERE gym_id = ? AND member_id = ?', [gymId, m]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].membership_plan_id)).toBe(planB);
    expect(await draftSetOf(first.body.id)).toBeNull();
    const { rows: sets } = await db.query<any>(
      `SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status IN ('draft','pending_payment')`, [gymId, m]);
    expect(sets).toHaveLength(1);
    const { rows: ev } = await db.query<any>('SELECT id FROM billing_events WHERE gym_id = ? AND member_id = ?', [gymId, m]);
    expect(ev).toHaveLength(0);
  });

  it('still refuses a new Draft while a version is Pending Payment', async () => {
    const m = await member();
    const first = await api('post', '/user-memberships')
      .send({ member_id: m, membership_plan_id: await plan('PP'), starts_at: '2026-06-01' });
    const set = await draftSetOf(first.body.id);
    await db.query(`UPDATE product_sets SET status = 'pending_payment' WHERE id = ?`, [set.id]);
    const second = await api('post', '/user-memberships')
      .send({ member_id: m, membership_plan_id: await plan('PQ'), starts_at: '2026-06-01' });
    expect(second.status).toBe(409);
  });

  it('discarding the Draft takes its version with it, so another can be started', async () => {
    const m = await member();
    const p = await plan('D');
    const first = await api('post', '/user-memberships').send({ member_id: m, membership_plan_id: p, starts_at: '2026-06-01' });
    expect((await api('delete', `/user-memberships/${first.body.id}/draft`)).status).toBe(204);
    expect(await draftSetOf(first.body.id)).toBeNull();
    const again = await api('post', '/user-memberships').send({ member_id: m, membership_plan_id: p, starts_at: '2026-06-01' });
    expect(again.status).toBe(201);
  });

  it('a Draft idle for two hours expires with its assignment row', async () => {
    const m = await member();
    const res = await api('post', '/user-memberships')
      .send({ member_id: m, membership_plan_id: await plan('E'), starts_at: '2026-06-01' });
    const set = await draftSetOf(res.body.id);
    await db.query(
      'UPDATE product_sets SET last_activity_at = UTC_TIMESTAMP() - INTERVAL 3 HOUR WHERE id = ?', [set.id]);
    await expireDrafts();
    expect(await draftSetOf(res.body.id)).toBeNull();
    const { rows } = await db.query('SELECT id FROM user_memberships WHERE id = ?', [res.body.id]);
    expect(rows).toHaveLength(0);
  });

  it('refuses to change the Billing frequency of a Draft (the chain\'s schedule is anchored once)', async () => {
    const m = await member();
    const res = await api('post', '/user-memberships')
      .send({ member_id: m, membership_plan_id: await plan('F'), starts_at: '2026-06-01' });
    const edit = await api('put', `/user-memberships/${res.body.id}/billing-duration`)
      .send({ recurring_billing_unit: 'year', recurring_billing_interval: 1 });
    expect(edit.status).toBe(400);
  });

  it('activating the Draft moves the version it already is', async () => {
    const m = await member();
    const res = await api('post', '/user-memberships')
      .send({ member_id: m, membership_plan_id: await plan('C'), starts_at: '2026-06-01' });
    const set = await draftSetOf(res.body.id);
    expect((await api('post', `/user-memberships/${res.body.id}/activate`).send({})).status).toBe(200);
    const after = await draftSetOf(res.body.id);
    expect(after).toMatchObject({ id: set.id, status: 'active' });
  });
});
