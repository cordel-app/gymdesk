// Integration tests for the Finance Dashboard router (#638).
//
// GET /financials/dashboard/membership-plans returns one card per Membership
// Plan — every active plan, plus non-active plans that still have assignments.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { invalidateFeatureFlagsCache } from '../infra/featureFlags';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const PATH = '/financials/dashboard/membership-plans';

let gymId: string;

interface PlanCard {
  id: number;
  name: string;
  lifecycle_status: string;
  assigned_members: number;
}

async function createPlan(
  gym: string,
  name: string,
  lifecycleStatus: 'draft' | 'active' | 'paused' | 'inactive' = 'active',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, ?, 'staff_only', '1')`,
    [gym, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, lifecycleStatus],
  );
  return insertId;
}

async function createMember(gym: string, name = 'FD Test Member'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
    [gym, name, `fd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId;
}

// Mirrors what POST /user-memberships writes (membership row + owner row).
async function assignPlan(
  gym: string,
  memberId: number,
  planId: number,
  status: 'draft' | 'awaiting_payment' | 'active' | 'paused' | 'cancelled' | 'expired' = 'active',
  endsAt: string | null = null,
  startsAt: string | null = null,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, ends_at, final_price)
     VALUES (?, ?, ?, ?, COALESCE(?, CURDATE()), ?, 29.99)`,
    [gym, memberId, planId, status, startsAt, endsAt],
  );
  await db.query(
    'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)',
    [gym, insertId, memberId],
  );
  return insertId;
}

const get = (gym: string) =>
  request.get(PATH).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function cards(gym: string): Promise<PlanCard[]> {
  const res = await get(gym);
  expect(res.status).toBe(200);
  return res.body as PlanCard[];
}

beforeAll(async () => {
  gymId = await createTestGym('Finance Dashboard Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /financials/dashboard/membership-plans — auth', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get(PATH);
    expect(res.status).toBe(401);
  });

  it('returns 403 when the user has no membership in the requested gym', async () => {
    const otherGym = await createTestGym('No Membership Gym');
    const res = await get(otherGym);
    expect(res.status).toBe(403);
  });

  it('returns 403 for a role without FINANCIALS access', async () => {
    const memberGym = await createTestGym('Member Role Gym');
    await createTestMembership(memberGym, 'member');
    const res = await get(memberGym);
    expect(res.status).toBe(403);
  });

  it('returns 200 for a read-only FINANCIALS role', async () => {
    const accountantGym = await createTestGym('Accountant Gym');
    await createTestMembership(accountantGym, 'accountant');
    const res = await get(accountantGym);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// The Dashboard is deliberately mounted on the `financials` group flag rather
// than `financials.plans` — turning the Plans page off must not take the
// Dashboard with it. Superadmins bypass flags, so the caller here is a gym admin.
describe('GET /financials/dashboard/membership-plans — feature flags', () => {
  const FLAGS = ['financials', 'financials.plans'];
  let originalFlags: Record<string, number> = {};

  beforeAll(async () => {
    const { rows } = await db.query<{ feature_key: string; enabled: number }>(
      `SELECT feature_key, enabled FROM feature_flags WHERE feature_key IN (${FLAGS.map(() => '?').join(',')})`,
      FLAGS,
    );
    originalFlags = Object.fromEntries(rows.map((r) => [r.feature_key, r.enabled]));
  });

  afterEach(async () => {
    for (const [key, enabled] of Object.entries(originalFlags)) {
      await db.query('UPDATE feature_flags SET enabled = ? WHERE feature_key = ?', [enabled, key]);
    }
    invalidateFeatureFlagsCache();
  });

  async function setFlag(key: string, enabled: boolean) {
    await db.query('UPDATE feature_flags SET enabled = ? WHERE feature_key = ?', [enabled ? 1 : 0, key]);
    invalidateFeatureFlagsCache();
  }

  // Without this, a renamed flag would make the two cases below pass vacuously.
  it('has both flags seeded', () => {
    expect(Object.keys(originalFlags).sort()).toEqual([...FLAGS].sort());
  });

  it('still serves the Dashboard when the Plans page is switched off', async () => {
    await setFlag('financials.plans', false);
    expect((await get(gymId)).status).toBe(200);
  });

  it('is blocked by the Financials group flag', async () => {
    await setFlag('financials', false);
    expect((await get(gymId)).status).toBe(403);
  });
});

describe('GET /financials/dashboard/membership-plans — tenant isolation', () => {
  it("never returns another gym's plans or counts its assignments", async () => {
    const gymB = await createTestGym('Other Finance Gym');
    await createTestMembership(gymB, 'admin');
    const planA = await createPlan(gymId, 'Isolation A');
    const planB = await createPlan(gymB, 'Isolation B');
    await assignPlan(gymB, await createMember(gymB), planB);

    const fromA = await cards(gymId);
    expect(fromA.map((c) => c.id)).toContain(planA);
    expect(fromA.map((c) => c.id)).not.toContain(planB);

    const fromB = await cards(gymB);
    expect(fromB.map((c) => c.id)).toEqual([planB]);
    expect(fromB[0].assigned_members).toBe(1);
  });
});

describe('GET /financials/dashboard/membership-plans — which plans are shown', () => {
  it('shows an active plan with no assignments', async () => {
    const gym = await createTestGym('Visibility Gym 1');
    await createTestMembership(gym, 'admin');
    const planId = await createPlan(gym, 'Empty Active', 'active');

    const list = await cards(gym);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: planId, lifecycle_status: 'active', assigned_members: 0 });
  });

  it('hides a non-active plan with no assignments', async () => {
    const gym = await createTestGym('Visibility Gym 2');
    await createTestMembership(gym, 'admin');
    await createPlan(gym, 'Empty Inactive', 'inactive');
    await createPlan(gym, 'Empty Draft', 'draft');
    await createPlan(gym, 'Empty Paused', 'paused');

    expect(await cards(gym)).toHaveLength(0);
  });

  it('shows a non-active plan that still has an assignment', async () => {
    const gym = await createTestGym('Visibility Gym 3');
    await createTestMembership(gym, 'admin');
    const planId = await createPlan(gym, 'Retired', 'inactive');
    await assignPlan(gym, await createMember(gym), planId);

    const list = await cards(gym);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: planId, lifecycle_status: 'inactive', assigned_members: 1 });
  });

  it('hides a soft-deleted plan even when it has assignments', async () => {
    const gym = await createTestGym('Visibility Gym 4');
    await createTestMembership(gym, 'admin');
    const planId = await createPlan(gym, 'Deleted Plan', 'active');
    await assignPlan(gym, await createMember(gym), planId);
    await db.query('UPDATE membership_plans SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [planId]);

    expect(await cards(gym)).toHaveLength(0);
  });
});

describe('GET /financials/dashboard/membership-plans — assignment counting', () => {
  // The dashboard counts assignments, not members, so the same member holding
  // two of them counts twice. They are one active and one paused here to show
  // that the count is not filtered by status.
  it('counts each assignment independently, including two for the same member', async () => {
    const gym = await createTestGym('Counting Gym 1');
    await createTestMembership(gym, 'admin');
    const planId = await createPlan(gym, 'Standard');
    const memberId = await createMember(gym);
    await assignPlan(gym, memberId, planId, 'active');
    await assignPlan(gym, memberId, planId, 'paused');
    await assignPlan(gym, await createMember(gym), planId);

    const list = await cards(gym);
    expect(list[0].assigned_members).toBe(3);
  });

  it('counts assignments that are not yet paid, and paused ones', async () => {
    const gym = await createTestGym('Counting Gym 2');
    await createTestMembership(gym, 'admin');
    const planId = await createPlan(gym, 'Lifecycle');
    for (const status of ['draft', 'awaiting_payment', 'active', 'paused'] as const) {
      await assignPlan(gym, await createMember(gym), planId, status);
    }

    const list = await cards(gym);
    expect(list).toHaveLength(1);
    expect(list[0].assigned_members).toBe(4);
  });

  // The Assigned Plans list projects a future `starts_at` as `pending`, not as
  // one of the two terminal statuses — so the plan is assigned and counts.
  it('counts an assignment that has not started yet', async () => {
    const gym = await createTestGym('Counting Gym 5');
    await createTestMembership(gym, 'admin');
    const planId = await createPlan(gym, 'Starts Later');
    await assignPlan(gym, await createMember(gym), planId, 'active', null, '2099-01-01');

    const list = await cards(gym);
    expect(list).toHaveLength(1);
    expect(list[0].assigned_members).toBe(1);
  });

  // Plan ids are globally unique, so only the join's `um.gym_id = p.gym_id`
  // guard stops a stray cross-gym assignment row from inflating the card.
  it("ignores an assignment row stored under another gym's id", async () => {
    const gymA = await createTestGym('Cross Gym A');
    await createTestMembership(gymA, 'admin');
    const gymB = await createTestGym('Cross Gym B');
    const planId = await createPlan(gymA, 'Cross Tenant');
    await assignPlan(gymB, await createMember(gymB), planId);

    const list = await cards(gymA);
    expect(list).toHaveLength(1);
    expect(list[0].assigned_members).toBe(0);
  });

  it('does not count cancelled, expired or past-dated assignments', async () => {
    const gym = await createTestGym('Counting Gym 3');
    await createTestMembership(gym, 'admin');
    const planId = await createPlan(gym, 'Terminated');
    await assignPlan(gym, await createMember(gym), planId, 'cancelled');
    await assignPlan(gym, await createMember(gym), planId, 'expired');
    await assignPlan(gym, await createMember(gym), planId, 'active', '2020-01-01');

    const list = await cards(gym);
    expect(list).toHaveLength(1);
    expect(list[0].assigned_members).toBe(0);
  });

  it("does not count a soft-deleted member's assignment", async () => {
    const gym = await createTestGym('Counting Gym 4');
    await createTestMembership(gym, 'admin');
    const planId = await createPlan(gym, 'Deleted Member');
    const memberId = await createMember(gym);
    await assignPlan(gym, memberId, planId);
    await db.query('UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [memberId]);

    const list = await cards(gym);
    expect(list).toHaveLength(1);
    expect(list[0].assigned_members).toBe(0);
  });

  it('orders cards by plan name', async () => {
    const gym = await createTestGym('Ordering Gym');
    await createTestMembership(gym, 'admin');
    await createPlan(gym, 'Zeta');
    await createPlan(gym, 'Alpha');

    const names = (await cards(gym)).map((c) => c.name);
    expect(names).toEqual([...names].sort());
  });
});
