// #958 — *Created by* and *Created at* on an Assigned Membership Plan card.
//
// The thread's Q4 answer is that key metadata belongs on the entity rather than
// being derived from `audit_logs`, so migration 215 gives `user_memberships` the
// `created_by_name` / `created_by_type` snapshot pair and the three paths that
// insert a row write it. These tests pin the two halves of that:
//
//  1. every creation path stamps the actor, and a superseded row keeps its own;
//  2. the Member's configuration read reports the pair plus `created_at`, which
//     is what lets every plan card show the actor without one subquery per row.
//
// The actor's name is the Clerk stub's (`Test User`) and the type is `staff`,
// because these routes run behind `tenantContext`: a superadmin reaching one is
// impersonating a gym, which is the staff case.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Creation Actor Member', `actor-${uniq()}@test.com`],
  );
  return insertId;
}

async function createPlan(gymId: string, name: string, memberLimit = '1'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', ?)`,
    [gymId, name, memberLimit],
  );
  return insertId;
}

async function readActor(umId: number) {
  const { rows } = await db.query(
    'SELECT created_by_name, created_by_type FROM user_memberships WHERE id = ?',
    [umId],
  );
  return rows[0];
}

describe('#958 — the creation actor is snapshotted by every path that assigns a plan', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Creation Actor Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('POST /user-memberships stamps the actor on the row it inserts', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Actor Plan ${uniq()}`);

    const res = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, membership_plan_id: planId, starts_at: '2026-03-01' });
    expect(res.status).toBe(201);
    expect(res.body.created_by_name).toBe('Test User');
    expect(res.body.created_by_type).toBe('staff');

    // And it is a column, not something the response composed.
    expect(await readActor(res.body.id)).toEqual({
      created_by_name: 'Test User', created_by_type: 'staff',
    });
  });

  it('POST /membership-plans/:id/assign stamps it too', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Actor Assign Plan ${uniq()}`);

    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-03-01' });
    expect(res.status).toBe(201);
    expect(await readActor(res.body.id)).toEqual({
      created_by_name: 'Test User', created_by_type: 'staff',
    });
  });

  it('assign-new-plan stamps the successor and leaves the superseded row its own', async () => {
    const memberId = await createMember(gymId);
    const firstPlan = await createPlan(gymId, `Actor Superseded Plan ${uniq()}`);
    const secondPlan = await createPlan(gymId, `Actor Successor Plan ${uniq()}`);

    const first = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, membership_plan_id: firstPlan, starts_at: '2026-03-01' });
    expect(first.status).toBe(201);

    // A different actor's name on the first row, so "the successor records who
    // assigned *it*" is asserted rather than coincidentally true.
    await db.query(
      'UPDATE user_memberships SET created_by_name = ? WHERE id = ?',
      ['Earlier Admin', first.body.id],
    );

    const res = await request
      .post(`/user-memberships/${first.body.id}/assign-new-plan`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_id: secondPlan, starts_at: '2026-06-01' });
    expect(res.status).toBe(201);

    expect(await readActor(res.body.id)).toEqual({
      created_by_name: 'Test User', created_by_type: 'staff',
    });
    // The superseded row is the record of what it billed (#956): its own actor
    // is not rewritten by the replacement.
    expect((await readActor(first.body.id)).created_by_name).toBe('Earlier Admin');
  });

  it('reports the actor and the creation date on the Member configuration read', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Actor Config Plan ${uniq()}`);

    const created = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, membership_plan_id: planId, starts_at: '2026-03-01' });
    expect(created.status).toBe(201);

    const res = await request
      .get(`/user-memberships/member/${memberId}/configuration`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const plan = res.body.plans.find((p: any) => p.id === created.body.id);
    expect(plan).toBeDefined();
    expect(plan.created_by_name).toBe('Test User');
    expect(plan.created_by_type).toBe('staff');
    // Reported as a bare date, like every other date in this payload.
    expect(plan.created_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('reports a null actor rather than inventing one for a row that snapshotted none', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Actor Legacy Plan ${uniq()}`);
    // A row written before migration 215 with no audit history to backfill from
    // — the card renders an em dash for it.
    const { insertId } = await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at)
       VALUES (?, ?, ?, 'active', '2026-03-01')`,
      [gymId, memberId, planId],
    );

    const res = await request
      .get(`/user-memberships/member/${memberId}/configuration`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const plan = res.body.plans.find((p: any) => p.id === insertId);
    expect(plan).toBeDefined();
    expect(plan.created_by_name).toBeNull();
    expect(plan.created_by_type).toBeNull();
  });
});
