// #1191 — a multi-member Membership is one contract seen as Primary by its owner
// and Linked by every other covered Member.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let gymId: string;
let otherGymId: string;
let planId: number;
let john: number;
let jane: number;
let alone: number;
let duoId: number;
let soloId: number;

async function member(gym: string, name: string) {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gym, name, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId as number;
}

const h = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });

beforeAll(async () => {
  gymId = await createTestGym('Rel Gym');
  otherGymId = await createTestGym('Rel Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  const plan = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, 'Duo', 'active', 'public', '2')`,
    [gymId],
  );
  planId = plan.insertId;
  john = await member(gymId, 'John');
  jane = await member(gymId, 'Jane');
  alone = await member(gymId, 'Alone');

  const duo = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', CURDATE(), 29.99)`,
    [gymId, john, planId],
  );
  duoId = duo.insertId;
  await db.query(
    'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1), (?, ?, ?, 0)',
    [gymId, duoId, john, gymId, duoId, jane],
  );
  const solo = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', CURDATE(), 29.99)`,
    [gymId, alone, planId],
  );
  soloId = solo.insertId;
  await db.query(
    'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)',
    [gymId, soloId, alone],
  );
});

describe('GET /user-memberships/member/:id/configuration', () => {
  it('shows the Duo as primary to the owner and linked to the covered Member, same id', async () => {
    const a = await request.get(`/user-memberships/member/${john}/configuration`).set(h(gymId));
    const b = await request.get(`/user-memberships/member/${jane}/configuration`).set(h(gymId));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.plans.map((p: any) => [p.id, p.assignment_relationship])).toEqual([[duoId, 'primary']]);
    expect(b.body.plans.map((p: any) => [p.id, p.assignment_relationship])).toEqual([[duoId, 'linked']]);
  });

  it('keeps a single-member Membership primary and absent from other Members', async () => {
    const r = await request.get(`/user-memberships/member/${alone}/configuration`).set(h(gymId));
    expect(r.body.plans.map((p: any) => [p.id, p.assignment_relationship])).toEqual([[soloId, 'primary']]);
  });

  it('drops the Membership from a Member once removed from coverage', async () => {
    const extra = await member(gymId, 'Extra');
    await request.post(`/user-memberships/${duoId}/members`).set(h(gymId)).send({ member_id: extra }).expect(201);
    const added = await request.get(`/user-memberships/member/${extra}/configuration`).set(h(gymId));
    expect(added.body.plans[0].assignment_relationship).toBe('linked');
    await request.delete(`/user-memberships/${duoId}/members/${extra}`).set(h(gymId)).expect(200);
    const removed = await request.get(`/user-memberships/member/${extra}/configuration`).set(h(gymId));
    expect(removed.body.plans).toEqual([]);
  });
});

describe('GET /user-memberships', () => {
  it('lists the Duo once globally, and for both Members when filtered', async () => {
    const all = await request.get('/user-memberships').set(h(gymId));
    expect(all.body.filter((r: any) => r.id === duoId)).toHaveLength(1);
    const forJane = await request.get(`/user-memberships?member_id=${jane}`).set(h(gymId));
    expect(forJane.body.map((r: any) => [r.id, r.assignment_relationship])).toEqual([[duoId, 'linked']]);
    const forJohn = await request.get(`/user-memberships?member_id=${john}`).set(h(gymId));
    expect(forJohn.body.map((r: any) => [r.id, r.assignment_relationship])).toEqual([[duoId, 'primary']]);
  });

  it('is tenant-isolated', async () => {
    const r = await request.get(`/user-memberships?member_id=${jane}`).set(h(otherGymId));
    expect(r.body).toEqual([]);
  });
});

describe('Linked context is read-only', () => {
  it('opens the same Membership from both contexts, with no Billing Events for Linked', async () => {
    const p = await request.get(`/user-memberships/${duoId}?as_member_id=${john}`).set(h(gymId));
    const l = await request.get(`/user-memberships/${duoId}?as_member_id=${jane}`).set(h(gymId));
    expect(p.body.id).toBe(duoId);
    expect(l.body.id).toBe(duoId);
    expect(p.body.assignment_relationship).toBe('primary');
    expect(l.body.assignment_relationship).toBe('linked');
    expect(p.body.billing_events.available).toBe(true);
    expect(l.body.billing_events.available).toBe(false);
    expect(l.body.billing_events.events).toEqual([]);
  });

  it('refuses the Billing Events route and every write from a Linked context', async () => {
    await request.get(`/user-memberships/${duoId}/billing-events?as_member_id=${jane}`).set(h(gymId)).expect(403);
    const pause = await request.post(`/user-memberships/${duoId}/pause?as_member_id=${jane}`).set(h(gymId));
    expect(pause.status).toBe(403);
    expect(pause.body.error).toBe('linked_member_read_only');
    const row = await db.query('SELECT status FROM user_memberships WHERE id = ?', [duoId]);
    expect(row.rows[0].status).toBe('active');
  });

  it('lets the Primary context act, and 404s a Member the Membership does not cover', async () => {
    await request.get(`/user-memberships/${duoId}/billing-events?as_member_id=${john}`).set(h(gymId)).expect(200);
    await request.get(`/user-memberships/${duoId}?as_member_id=${alone}`).set(h(gymId)).expect(404);
  });
});
