// Tests for member-nutrition-plans.ts router

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
let memberId: number;

beforeAll(async () => {
  gymId = await createTestGym('MNP Test Gym');
  await createTestMembership(gymId, 'admin');

  // Insert a test member so assign endpoint has a valid target.
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'MNP Test Member', ?)`,
    [gymId, `mnp-member-${Date.now()}@test.com`],
  );
  memberId = insertId;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// Helper: create a template and assign it to memberId, returns the created plan body.
async function createTestPlan(): Promise<any> {
  const tplRes = await request
    .post('/nutrition-plan-templates')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ name: `MNP Plan ${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  expect(tplRes.status).toBe(201);

  const assignRes = await request
    .post(`/nutrition-plan-templates/${tplRes.body.id}/assign`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ member_id: memberId });
  expect(assignRes.status).toBe(201);
  return assignRes.body;
}

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

describe('auth guard', () => {
  it('returns 401 without auth on GET /member-nutrition-plans', async () => {
    const res = await request.get('/member-nutrition-plans');
    expect(res.status).toBe(401);
  });

  it('returns 401 without auth on GET /member-nutrition-plans/:id', async () => {
    const res = await request.get('/member-nutrition-plans/1');
    expect(res.status).toBe(401);
  });

  it('returns 401 without auth on DELETE /member-nutrition-plans/:id', async () => {
    const res = await request.delete('/member-nutrition-plans/1');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('returns 403 when user has no membership in this gym', async () => {
    const otherId = await createTestGym('MNP Other Gym');
    const res = await request
      .get('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherId);
    expect(res.status).toBe(403);
  });

  it('returns 404 when accessing a plan that belongs to another gym', async () => {
    const plan = await createTestPlan();

    const gymB = await createTestGym('MNP Gym B');
    await createTestMembership(gymB, 'admin');

    const res = await request
      .get(`/member-nutrition-plans/${plan.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });

  it('returns 404 on hierarchy for a plan that belongs to another gym', async () => {
    const plan = await createTestPlan();

    const gymC = await createTestGym('MNP Gym C');
    await createTestMembership(gymC, 'admin');

    const res = await request
      .get(`/member-nutrition-plans/${plan.id}/hierarchy`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymC);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Module access guard — accountant has NONE on NUTRITION
// ---------------------------------------------------------------------------

describe('module access guard', () => {
  it('returns 403 for accountant role on GET /member-nutrition-plans', async () => {
    const accountantGymId = await createTestGym('MNP Accountant Gym');
    await createTestMembership(accountantGymId, 'accountant');

    const res = await request
      .get('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', accountantGymId);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('member nutrition plans happy path', () => {
  let plan: any;

  beforeAll(async () => {
    plan = await createTestPlan();
  });

  it('lists plans for the gym as an array', async () => {
    const res = await request
      .get('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((p: any) => p.id === plan.id);
    expect(found).toBeDefined();
    expect(found.member_name).toBe('MNP Test Member');
  });

  it('filters plans by ?member_id=', async () => {
    const res = await request
      .get(`/member-nutrition-plans?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const p of res.body) {
      expect(Number(p.member_id)).toBe(memberId);
    }
  });

  it('returns 400 for a non-integer ?member_id', async () => {
    const res = await request
      .get('/member-nutrition-plans?member_id=abc')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('gets a single plan by id', async () => {
    const res = await request
      .get(`/member-nutrition-plans/${plan.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(plan.id);
    expect(res.body.member_name).toBe('MNP Test Member');
  });

  it('returns 404 for a non-existent plan', async () => {
    const res = await request
      .get('/member-nutrition-plans/999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('gets the full hierarchy for a plan', async () => {
    const res = await request
      .get(`/member-nutrition-plans/${plan.id}/hierarchy`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(plan.id);
    expect(Array.isArray(res.body.days)).toBe(true);
    expect(Array.isArray(res.body.restrictions)).toBe(true);
    expect(Array.isArray(res.body.goals)).toBe(true);
  });

  it('returns 404 on hierarchy for a non-existent plan', async () => {
    const res = await request
      .get('/member-nutrition-plans/999999/hierarchy')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('soft-deletes a plan and hides it from the list and get', async () => {
    const planToDelete = await createTestPlan();

    const delRes = await request
      .delete(`/member-nutrition-plans/${planToDelete.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(delRes.status).toBe(204);

    const listRes = await request
      .get('/member-nutrition-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(listRes.status).toBe(200);
    const found = listRes.body.find((p: any) => p.id === planToDelete.id);
    expect(found).toBeUndefined();

    const getRes = await request
      .get(`/member-nutrition-plans/${planToDelete.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(getRes.status).toBe(404);
  });

  it('returns 404 when deleting a non-existent plan', async () => {
    const res = await request
      .delete('/member-nutrition-plans/999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
