// Integration tests for the Home dashboard (#1367) and the Welcomed route.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, ensureTestProductSet, request } from './helpers';

let gymA: string;
let gymB: string;
let memberA: number;

const get = (gym: string, path = '/dashboard/home') =>
  request.get(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

beforeAll(async () => {
  gymA = await createTestGym('Home A');
  gymB = await createTestGym('Home B');
  await createTestMembership(gymA, 'admin');
  await createTestMembership(gymB, 'admin');
  const u = `${Date.now()}`;
  const email = `home-${u}@example.com`;
  await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymA, 'Home Member', email]);
  memberA = Number((await db.query('SELECT id FROM members WHERE gym_id = ? AND email = ?', [gymA, email])).rows[0].id);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /dashboard/home', () => {
  it('requires authentication', async () => {
    expect((await request.get('/dashboard/home').set('x-gym-id', gymA)).status).toBe(401);
  });

  it('returns the cards, tasks and panels for an admin', async () => {
    const res = await get(gymA);
    expect(res.status).toBe(200);
    expect(res.body.access).toEqual({ members: true, classes: true, payments: true });
    expect(res.body.cards.active_members).toBeDefined();
    expect(res.body.cards.classes_today.count).toBe(0);
    expect(Array.isArray(res.body.classes)).toBe(true);
    expect(res.body.latest_members.map((m: any) => m.name)).toContain('Home Member');
  });

  it('rejects a malformed date', async () => {
    expect((await get(gymA, '/dashboard/home?date=2026-02-31')).status).toBe(400);
  });

  it('never leaks another gym\'s members', async () => {
    const res = await get(gymB);
    expect(res.status).toBe(200);
    expect(res.body.latest_members.map((m: any) => m.name)).not.toContain('Home Member');
  });
});

describe('PUT /members/:id/welcomed', () => {
  it('ticks and unticks, and the task follows welcomed_at IS NULL', async () => {
    await db.query('UPDATE members SET welcomed_at = NULL WHERE id = ?', [memberA]);
    let home = await get(gymA);
    expect(home.body.tasks.find((t: any) => t.key === 'welcome_new_members')?.count).toBe(1);

    const on = await request.put(`/members/${memberA}/welcomed`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymA).send({ welcomed: true });
    expect(on.status).toBe(200);
    expect(on.body.welcomed_at).toBeTruthy();
    home = await get(gymA);
    expect(home.body.tasks.find((t: any) => t.key === 'welcome_new_members')).toBeUndefined();

    const off = await request.put(`/members/${memberA}/welcomed`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymA).send({ welcomed: false });
    expect(off.body.welcomed_at).toBeNull();
    const list = await request.get('/members?welcomed=false').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymA);
    expect(list.body.map((m: any) => m.id)).toContain(memberA);
  });

  it('is tenant-scoped and validates the body', async () => {
    const other = await request.put(`/members/${memberA}/welcomed`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymB).send({ welcomed: true });
    expect(other.status).toBe(404);
    const bad = await request.put(`/members/${memberA}/welcomed`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymA).send({ welcomed: 'yes' });
    expect(bad.status).toBe(400);
  });
});

describe('GET /dashboard/home — pending payment members (#1466)', () => {
  it('lists a member once with summed amount, ignores resolved events, and is tenant-scoped', async () => {
    const gym = await createTestGym('Home Pending');
    await createTestMembership(gym, 'admin');
    const email = `pending-${Date.now()}@example.com`;
    const { insertId: memberId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gym, 'Pending Member', email],
    );
    const setId = await ensureTestProductSet(gym, Number(memberId));
    for (const [type, amount] of [['failed_billing', '30.00'], ['failed_billing', '12.50'], ['waived_billing', '99.00']]) {
      await db.query(
        `INSERT INTO billing_events (gym_id, product_set_id, member_id, event_type, amount, source, billing_date)
         VALUES (?, ?, ?, ?, ?, 'system', UTC_DATE())`,
        [gym, setId, memberId, type, amount],
      );
    }
    const res = await get(gym);
    expect(res.status).toBe(200);
    const section = res.body.pending_payment_members;
    expect(section.count).toBe(1);
    expect(section.members).toHaveLength(1);
    expect(section.members[0]).toMatchObject({ member_id: Number(memberId), name: 'Pending Member', outstanding_amount: 42.5 });

    // Another gym never sees it.
    const other = await get(gymB);
    expect(other.body.pending_payment_members.count).toBe(0);
  });

  it('is absent for a role that cannot read payments', async () => {
    const gym = await createTestGym('Home Pending Role');
    await createTestMembership(gym, 'trainer_performance');
    const res = await get(gym);
    expect(res.status).toBe(200);
    expect(res.body.pending_payment_members).toBeUndefined();
  });
});
