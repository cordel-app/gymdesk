// #3186: Home's "Members without mandatory product" section.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, ensureTestProductSet, request,
  snapshotTestAssignment,
} from './helpers';
import { testAssignmentWrite } from './assignmentFixture';

const get = (gym: string) =>
  request.get('/dashboard/home').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

let gym: string;
let gymB: string;
let planId: number;
let lockerId: number;
let towelId: number;

async function product(name: string): Promise<number> {
  const r = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, is_system)
     VALUES (?, ?, 'service', '10.00', 'EUR', 'month', 'active', 0)`, [gym, name]);
  return Number(r.insertId);
}

/** A member holding the plan, with Locker (mandatory) and Towel (optional) as recurring lines. */
async function memberWithPlan(name: string, status = 'active') {
  const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gym, name, `${name.replace(/\W/g, '')}-${Date.now()}@example.com`]);
  const memberId = Number(m.insertId);
  const um = await testAssignmentWrite(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at)
     VALUES (?, ?, ?, ?, '2026-01-01')`, [gym, memberId, planId, status]);
  const setId = Number(await ensureTestProductSet(gym, memberId, Number(um.insertId)));
  const snapshotId = await snapshotTestAssignment(Number(um.insertId));
  // The member's Active Product Set carries the plan, as it does once a plan is committed.
  await db.query('INSERT IGNORE INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)',
    [setId, snapshotId]);
  for (const [productId, itemName, mandatory] of [[lockerId, 'Locker', 1], [towelId, 'Towel', 0]] as const) {
    await db.query(
      `INSERT INTO plan_periodical_snapshots (gym_id, plan_snapshot_id, product_id, item_name, item_type, mandatory)
       VALUES (?, ?, ?, ?, 'service', ?)`, [gym, snapshotId, productId, itemName, mandatory]);
  }
  return { memberId, setId };
}

async function event(
  setId: number, memberId: number, productId: number,
  opts: { scheduled?: boolean; dueInDays?: number; tx?: string | null; amount?: string } = {},
) {
  const e = await db.query(
    `INSERT INTO billing_events (gym_id, product_set_id, member_id, event_type, amount, source, billing_date, is_scheduled)
     VALUES (?, ?, ?, 'charge_created', '10.00', 'system', DATE_ADD(UTC_DATE(), INTERVAL ? DAY), ?)`,
    [gym, setId, memberId, opts.dueInDays ?? 0, opts.scheduled === false ? 0 : 1]);
  const eventId = Number(e.insertId);
  await db.query(
    `INSERT INTO billing_event_lines (gym_id, billing_event_id, kind, product_id, item_name, quantity, amount)
     VALUES (?, ?, 'product', ?, 'line', 1, ?)`, [gym, eventId, productId, opts.amount ?? '10.00']);
  if (opts.tx) {
    await db.query(
      `INSERT INTO payment_requests (gym_id, member_id, billing_event_id, amount, status, source, provider_order)
       VALUES (?, ?, ?, '10.00', ?, 'admin', ?)`,
      [gym, memberId, eventId, opts.tx, `h3186-${Math.random().toString(36).slice(2)}`]);
  }
  return eventId;
}

beforeAll(async () => {
  gym = await createTestGym('Home Mandatory');
  gymB = await createTestGym('Home Mandatory B');
  await createTestMembership(gym, 'admin');
  await createTestMembership(gymB, 'admin');
  const p = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, 'Gold', 'active', 'public')`, [gym]);
  planId = Number(p.insertId);
  lockerId = await product('Locker');
  towelId = await product('Towel');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /dashboard/home — members without mandatory product (#3186)', () => {
  it('lists failed, pending and due-unpaid mandatory recurring Products and nothing else', async () => {
    const failed = await memberWithPlan('Failed Fiona');
    await event(failed.setId, failed.memberId, lockerId, { dueInDays: -5, tx: 'failed' });

    const pending = await memberWithPlan('Pending Pablo');
    await event(pending.setId, pending.memberId, lockerId, { dueInDays: -1, tx: 'pending' });

    const due = await memberWithPlan('Due Dora');
    await event(due.setId, due.memberId, lockerId, { dueInDays: 0 });

    const paid = await memberWithPlan('Paid Paula');
    await event(paid.setId, paid.memberId, lockerId, { dueInDays: -3, tx: 'completed' });

    const future = await memberWithPlan('Future Fred');
    await event(future.setId, future.memberId, lockerId, { dueInDays: 10 });

    const optional = await memberWithPlan('Optional Olga');
    await event(optional.setId, optional.memberId, towelId, { dueInDays: -2, tx: 'failed' });

    const waived = await memberWithPlan('Zero Zack');
    await event(waived.setId, waived.memberId, lockerId, { dueInDays: -2, amount: '0.00' });

    const res = await get(gym);
    expect(res.status).toBe(200);
    const section = res.body.unpaid_mandatory_products;
    const byName = Object.fromEntries(section.items.map((i: any) => [i.name, i]));
    expect(Object.keys(byName).sort()).toEqual(['Due Dora', 'Failed Fiona', 'Pending Pablo']);
    expect(section.count).toBe(3);
    expect(byName['Failed Fiona']).toMatchObject({
      member_id: failed.memberId, product_id: lockerId, product_name: 'Locker',
      membership_plan_id: planId, plan_name: 'Gold', payment_status: 'failed',
    });
    expect(byName['Pending Pablo'].payment_status).toBe('pending');
    expect(byName['Due Dora'].payment_status).toBe('overdue');
    // Most overdue first.
    expect(section.items[0].name).toBe('Failed Fiona');

    // A successful payment removes it on the next read.
    const { rows } = await db.query<{ id: number }>(
      'SELECT id FROM billing_events WHERE member_id = ? LIMIT 1', [failed.memberId]);
    await db.query(
      `INSERT INTO payment_requests (gym_id, member_id, billing_event_id, amount, status, source, provider_order)
       VALUES (?, ?, ?, '10.00', 'completed', 'admin', ?)`,
      [gym, failed.memberId, rows[0].id, `h3186-paid-${Date.now()}`]);
    const after = await get(gym);
    expect(after.body.unpaid_mandatory_products.items.map((i: any) => i.name)).not.toContain('Failed Fiona');

    // Another gym never sees them.
    const other = await get(gymB);
    expect(other.body.unpaid_mandatory_products).toEqual({ count: 0, items: [] });
  });

  it('is absent for a role that cannot read payments', async () => {
    const g = await createTestGym('Home Mandatory Role');
    await createTestMembership(g, 'trainer_performance');
    const res = await get(g);
    expect(res.status).toBe(200);
    expect(res.body.unpaid_mandatory_products).toBeUndefined();
  });
});
