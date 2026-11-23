// #1325 PR 3e — the Admin's Draft assignment is a ProductSet Draft from birth.
import { TEST_ASSIGNMENTS } from './assignmentReads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productSetOfLegacyAssignmentSql } from '../domain/planAssignments';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { expireDrafts } from '../api/product-sets';
import { testAssignmentWrite } from './assignmentFixture';

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
    `SELECT id, status, owner_member_id FROM product_sets WHERE gym_id = ? AND ${productSetOfLegacyAssignmentSql('?', 'product_sets')}`, [gymId, umId]);
  return rows[0] ?? null;
}

describe('a Draft assignment is created set-first', () => {
  it('links a Draft ProductSet to the assignment row at creation', async () => {
    const m = await member();
    const res = await api('post', '/user-memberships')
      .send({ member_id: m, membership_plan_id: await plan('P'), starts_at: '2026-06-01' });
    expect(res.status).toBe(201);
    const set = await draftSetOf(res.body.id);
    expect(set).toMatchObject({ status: 'in_cart', owner_member_id: m });
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
    const { rows } = await db.query<any>(`SELECT id, membership_plan_id FROM ${TEST_ASSIGNMENTS} um WHERE gym_id = ? AND member_id = ?`, [gymId, m]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].membership_plan_id)).toBe(planB);
    expect(await draftSetOf(first.body.id)).toBeNull();
    const { rows: sets } = await db.query<any>(
      `SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status IN ('in_cart','pending_payment')`, [gymId, m]);
    expect(sets).toHaveLength(1);
    const { rows: ev } = await db.query<any>('SELECT id FROM billing_events WHERE gym_id = ? AND member_id = ?', [gymId, m]);
    expect(ev).toHaveLength(0);
  });

  it('assigning a plan joins the owner\'s plain Draft (their cart) instead of answering in_flight (#2966)', async () => {
    const m = await member();
    const { insertId: cartId } = await db.query(
      `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at, created_by)
       VALUES (?, ?, 'in_cart', '2026-06-01', 'test')`, [gymId, m]);
    const res = await api('post', '/user-memberships')
      .send({ member_id: m, membership_plan_id: await plan('J'), starts_at: '2026-06-01' });
    expect(res.status).toBe(201);
    expect(await draftSetOf(res.body.id)).toMatchObject({ id: cartId, status: 'in_cart' });
    const { rows: sets } = await db.query<any>(
      `SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status IN ('in_cart','pending_payment')`, [gymId, m]);
    expect(sets).toHaveLength(1);
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
    const { rows } = await db.query(`SELECT id FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [res.body.id]);
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

// #2125 M6b-51b: a Draft's dates are written on its plan snapshot and mirrored onto its version from it.
describe('PUT /user-memberships/:id dates on a Draft (#2125 M6b-51b)', () => {
  const day = (v: unknown) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10));
  async function datesOf(umId: number) {
    const set = await draftSetOf(umId);
    const { rows: ps } = await db.query<any>('SELECT starts_at, ends_at FROM product_sets WHERE id = ?', [set.id]);
    const { rows: snap } = await db.query<any>(
      `SELECT s.starts_at, s.ends_at FROM product_set_plan_snapshots j JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
        WHERE j.product_set_id = ? AND s.anchor_plan_snapshot_id = ?`, [set.id, umId]);
    const { rows: um } = await db.query<any>(`SELECT starts_at, ends_at FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [umId]);
    const pair = (r: any) => [day(r?.starts_at), day(r?.ends_at)];
    return { set: pair(ps[0]), snapshot: pair(snap[0]), legacy: pair(um[0]) };
  }

  it('writes the dates on the plan snapshot, the version and the answer', async () => {
    const created = await api('post', '/user-memberships')
      .send({ member_id: await member(), membership_plan_id: await plan('D1'), starts_at: '2026-06-01' });
    const res = await api('put', `/user-memberships/${created.body.id}`)
      .send({ starts_at: '2026-07-15', ends_at: '2027-07-14' });
    expect(res.status).toBe(200);
    expect([day(res.body.starts_at), day(res.body.ends_at)]).toEqual(['2026-07-15', '2027-07-14']);
    expect(await datesOf(created.body.id)).toEqual({
      set: ['2026-07-15', '2027-07-14'], snapshot: ['2026-07-15', '2027-07-14'], legacy: ['2026-07-15', '2027-07-14'],
    });
  });

  it('keeps the start when only the end is sent, and clears the end on an explicit null', async () => {
    const created = await api('post', '/user-memberships')
      .send({ member_id: await member(), membership_plan_id: await plan('D2'), starts_at: '2026-06-01', ends_at: '2026-12-31' });
    expect((await api('put', `/user-memberships/${created.body.id}`).send({ ends_at: '2026-11-30' })).status).toBe(200);
    expect((await datesOf(created.body.id)).snapshot).toEqual(['2026-06-01', '2026-11-30']);
    const cleared = await api('put', `/user-memberships/${created.body.id}`).send({ ends_at: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.ends_at).toBeNull();
    const after = await datesOf(created.body.id);
    expect(after.snapshot).toEqual(['2026-06-01', null]);
    expect(after.set).toEqual(['2026-06-01', null]);
  });

  it('mirrors the version from the plan snapshot, never from the legacy row', async () => {
    const created = await api('post', '/user-memberships')
      .send({ member_id: await member(), membership_plan_id: await plan('D3'), starts_at: '2026-06-01' });
    // A legacy row that disagrees with the snapshot must not reach the version.
    await testAssignmentWrite(`UPDATE user_memberships SET starts_at = '2020-01-01' WHERE id = ?`, [created.body.id], { mirror: false });
    expect((await api('put', `/user-memberships/${created.body.id}`).send({ ends_at: '2026-12-31' })).status).toBe(200);
    const after = await datesOf(created.body.id);
    expect(after.set).toEqual(['2026-06-01', '2026-12-31']);
    expect(after.snapshot).toEqual(['2026-06-01', '2026-12-31']);
  });

  it('a request that names no date moves none', async () => {
    const created = await api('post', '/user-memberships')
      .send({ member_id: await member(), membership_plan_id: await plan('D4'), starts_at: '2026-06-01', ends_at: '2026-12-31' });
    expect((await api('put', `/user-memberships/${created.body.id}`).send({ discount_reason: null })).status).toBe(200);
    expect(await datesOf(created.body.id)).toEqual({
      set: ['2026-06-01', '2026-12-31'], snapshot: ['2026-06-01', '2026-12-31'], legacy: ['2026-06-01', '2026-12-31'],
    });
  });
});
