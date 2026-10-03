// #956 — "one member, one active Membership Plan", across all three paths that
// can create a `user_memberships` row:
//
//   POST /user-memberships                     (the Member card's assign)
//   POST /user-memberships/:id/assign-new-plan (Assign New Plan, #412)
//   POST /membership-plans/:id/assign          (the Plans page's Assign modal, #376)
//
// The rule it replaces is #634 §6/§14 ("several plans in parallel, but only one
// of each type", migration 172); migration 213 restores migration 007's
// single-column UNIQUE index on `active_member_key`, which is the half of the
// invariant the database holds.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';
import { ACTIVE_PLAN_EXISTS } from '../domain/oneActivePlan';

let gymId: string;
let otherGymId: string;

beforeAll(async () => {
  gymId = await createTestGym('One Active Plan Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('One Active Plan Other Gym');
  await createTestMembership(otherGymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function createPlan(
  gym: string,
  name: string,
  memberLimit: '1' | '2' | 'family' = '1',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', ?)`,
    [gym, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, memberLimit],
  );
  return insertId;
}

async function createMember(gym: string, name = 'OAP Member'): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gym, name, `oap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`],
  );
  return insertId;
}

function post(path: string, body: unknown, gym = gymId) {
  return request.post(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send(body);
}

async function assignmentsOf(memberId: number) {
  const { rows } = await db.query(
    `SELECT id, membership_plan_id, status, closed_at,
            DATE_FORMAT(starts_at, '%Y-%m-%d') AS starts_at,
            DATE_FORMAT(ends_at, '%Y-%m-%d') AS ends_at
     FROM user_memberships WHERE member_id = ? ORDER BY id ASC`,
    [memberId],
  );
  return rows;
}

// ─── POST /user-memberships ───────────────────────────────────────────────────

describe('POST /user-memberships — the one-active-plan rule', () => {
  it('assigns normally when the member has no plan at all (no warning)', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, 'First');
    const res = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: planId, starts_at: '2026-01-01',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
  });

  it('refuses a second plan with 409 active_plan_exists, naming both plans', async () => {
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, 'Premium');
    const second = await createPlan(gymId, 'Basic');
    const created = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: first, starts_at: '2026-01-01',
    });
    expect(created.status).toBe(201);

    const res = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: second, starts_at: '2026-10-01',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(ACTIVE_PLAN_EXISTS);
    expect(res.body.current_plan.id).toBe(created.body.id);
    expect(res.body.current_plan.membership_plan_id).toBe(first);
    expect(res.body.current_plan.starts_at).toBe('2026-01-01');
    expect(res.body.conflicts).toHaveLength(1);
  });

  it('cancelling the dialog — i.e. not resending — leaves the plan and its dates untouched', async () => {
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, 'Premium');
    const second = await createPlan(gymId, 'Basic');
    const created = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: first, starts_at: '2026-01-01', ends_at: '2026-12-31',
    });
    const refused = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: second, starts_at: '2026-10-01',
    });
    expect(refused.status).toBe(409);

    const rows = await assignmentsOf(memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(created.body.id);
    expect(rows[0].status).toBe('active');
    expect(rows[0].ends_at).toBe('2026-12-31');
    expect(rows[0].closed_at).toBeNull();
  });

  it('confirm: true cancels the current plan, dates it, and leaves the new one the only live row', async () => {
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, 'Premium');
    const second = await createPlan(gymId, 'Basic');
    const created = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: first, starts_at: '2026-01-01',
    });
    const res = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: second, starts_at: '2026-10-01', confirm: true,
    });
    expect(res.status).toBe(201);

    const rows = await assignmentsOf(memberId);
    expect(rows).toHaveLength(2);
    const [old, fresh] = rows;
    expect(old.id).toBe(created.body.id);
    // Q3: cancelled, closed now, ending where the new plan starts — the two
    // plans meet at one date and never overlap as live rows.
    expect(old.status).toBe('cancelled');
    expect(old.ends_at).toBe('2026-10-01');
    expect(old.closed_at).not.toBeNull();
    expect(fresh.status).toBe('active');
    expect(fresh.starts_at).toBe('2026-10-01');
    expect(rows.filter((r: any) => r.status === 'active' || r.status === 'paused')).toHaveLength(1);
  });

  it('records a status_changed ledger row for the plan it cancelled', async () => {
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, 'Premium');
    const second = await createPlan(gymId, 'Basic');
    const created = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: first, starts_at: '2026-01-01',
    });
    await post('/user-memberships', {
      member_id: memberId, membership_plan_id: second, starts_at: '2026-10-01', confirm: true,
    });
    const { rows } = await db.query(
      `SELECT previous_status, new_status FROM billing_events
       WHERE gym_id = ? AND user_membership_id = ? AND event_type = 'status_changed'
       ORDER BY id DESC LIMIT 1`,
      [gymId, created.body.id],
    );
    expect(rows[0]).toMatchObject({ previous_status: 'active', new_status: 'cancelled' });
  });

  it('counts a paused plan as the one plan (#956 Q2)', async () => {
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, 'Premium');
    const second = await createPlan(gymId, 'Basic');
    const created = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: first, starts_at: '2026-01-01',
    });
    const paused = await post(`/user-memberships/${created.body.id}/pause`, {});
    expect(paused.status).toBe(200);

    const refused = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: second, starts_at: '2026-10-01',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.current_plan.status).toBe('paused');

    const confirmed = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: second, starts_at: '2026-10-01', confirm: true,
    });
    expect(confirmed.status).toBe(201);
    const rows = await assignmentsOf(memberId);
    expect(rows.find((r: any) => r.id === created.body.id).status).toBe('cancelled');
  });

  it('a future-dated assignment counts too — it is stored active', async () => {
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, 'Premium');
    const second = await createPlan(gymId, 'Basic');
    await post('/user-memberships', {
      member_id: memberId, membership_plan_id: first, starts_at: '2099-01-01',
    });
    const refused = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: second, starts_at: '2099-06-01',
    });
    expect(refused.status).toBe(409);
  });

  it('a cancelled or expired plan never blocks a new one, and history is kept', async () => {
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, 'Premium');
    const second = await createPlan(gymId, 'Basic');
    const created = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: first, starts_at: '2026-01-01',
    });
    await post(`/user-memberships/${created.body.id}/close`, { confirm: true });

    const res = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: second, starts_at: '2026-10-01',
    });
    expect(res.status).toBe(201);
    const rows = await assignmentsOf(memberId);
    // The old plan is not deleted: both rows are still there.
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('cancelled');
  });

  it('refuses a replacement that starts before the plan it replaces', async () => {
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, 'Premium');
    const second = await createPlan(gymId, 'Basic');
    await post('/user-memberships', {
      member_id: memberId, membership_plan_id: first, starts_at: '2026-06-01',
    });
    const res = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: second, starts_at: '2026-01-01', confirm: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/earlier than/);
    const rows = await assignmentsOf(memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
  });

  it('another gym\'s live plan for a same-named member is not a conflict (tenant isolation)', async () => {
    const theirs = await createMember(otherGymId);
    const theirPlan = await createPlan(otherGymId, 'Theirs');
    const created = await post('/user-memberships', {
      member_id: theirs, membership_plan_id: theirPlan, starts_at: '2026-01-01',
    }, otherGymId);
    expect(created.status).toBe(201);

    const ours = await createMember(gymId);
    const ourPlan = await createPlan(gymId, 'Ours');
    const res = await post('/user-memberships', {
      member_id: ours, membership_plan_id: ourPlan, starts_at: '2026-01-01',
    });
    expect(res.status).toBe(201);
  });

  it('two concurrent assignments of a member with no plan cannot both succeed', async () => {
    // Nothing exists to lock, so this case is the restored UNIQUE index's
    // (migration 213) rather than the FOR UPDATE read's.
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, 'Premium');
    const second = await createPlan(gymId, 'Basic');
    const [a, b] = await Promise.all([
      post('/user-memberships', { member_id: memberId, membership_plan_id: first, starts_at: '2026-01-01' }),
      post('/user-memberships', { member_id: memberId, membership_plan_id: second, starts_at: '2026-01-01' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).not.toBe(201);
    const rows = await assignmentsOf(memberId);
    expect(rows.filter((r: any) => r.status === 'active')).toHaveLength(1);
  });

  it('two concurrent confirmed replacements cannot leave two live plans', async () => {
    // Here the member *does* have a live plan, so both requests serialise on
    // its FOR UPDATE lock and the loser finds nothing live to supersede.
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, 'Premium');
    const second = await createPlan(gymId, 'Basic');
    const third = await createPlan(gymId, 'Gold');
    await post('/user-memberships', {
      member_id: memberId, membership_plan_id: first, starts_at: '2026-01-01',
    });
    const results = await Promise.all([
      post('/user-memberships', { member_id: memberId, membership_plan_id: second, starts_at: '2026-10-01', confirm: true }),
      post('/user-memberships', { member_id: memberId, membership_plan_id: third, starts_at: '2026-10-01', confirm: true }),
    ]);
    const rows = await assignmentsOf(memberId);
    expect(rows.filter((r: any) => r.status === 'active' || r.status === 'paused')).toHaveLength(1);
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
  });
});

// ─── POST /user-memberships/:id/assign-new-plan ───────────────────────────────

describe('POST /user-memberships/:id/assign-new-plan — supersede shape', () => {
  it('cancels the superseded row and dates it, rather than expiring it', async () => {
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, 'Premium');
    const second = await createPlan(gymId, 'Basic');
    const created = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: first, starts_at: '2026-01-01',
    });
    const res = await post(`/user-memberships/${created.body.id}/assign-new-plan`, {
      membership_plan_id: second, starts_at: '2026-10-01',
    });
    expect(res.status).toBe(201);

    const rows = await assignmentsOf(memberId);
    const old = rows.find((r: any) => r.id === created.body.id);
    expect(old.status).toBe('cancelled');
    expect(old.ends_at).toBe('2026-10-01');
    expect(old.closed_at).not.toBeNull();
    expect(rows.filter((r: any) => r.status === 'active')).toHaveLength(1);
  });

  it('needs no confirm — replacement is the route\'s whole contract', async () => {
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, 'Premium');
    const second = await createPlan(gymId, 'Basic');
    const created = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: first, starts_at: '2026-01-01',
    });
    const res = await post(`/user-memberships/${created.body.id}/assign-new-plan`, {
      membership_plan_id: second, starts_at: '2026-02-01',
    });
    expect(res.status).toBe(201);
  });

  it('refuses a start date earlier than the plan being replaced', async () => {
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, 'Premium');
    const second = await createPlan(gymId, 'Basic');
    const created = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: first, starts_at: '2026-06-01',
    });
    const res = await post(`/user-memberships/${created.body.id}/assign-new-plan`, {
      membership_plan_id: second, starts_at: '2026-01-01',
    });
    expect(res.status).toBe(400);
    const rows = await assignmentsOf(memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
  });
});

// ─── POST /membership-plans/:id/assign ────────────────────────────────────────

describe('POST /membership-plans/:id/assign — the one-active-plan rule', () => {
  it('assigns a member with no plan', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, 'Solo');
    const res = await post(`/membership-plans/${planId}/assign`, {
      member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-01-01',
    });
    expect(res.status).toBe(201);
  });

  it('refuses when a selected member already has one, and cancels nothing', async () => {
    const memberId = await createMember(gymId);
    const first = await createPlan(gymId, 'Premium');
    const second = await createPlan(gymId, 'Basic');
    const created = await post('/user-memberships', {
      member_id: memberId, membership_plan_id: first, starts_at: '2026-01-01',
    });
    const res = await post(`/membership-plans/${second}/assign`, {
      member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-10-01',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(ACTIVE_PLAN_EXISTS);
    const rows = await assignmentsOf(memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(created.body.id);
    expect(rows[0].status).toBe('active');
  });

  it('confirm: true replaces every selected member\'s plan in one transaction', async () => {
    const a = await createMember(gymId, 'Family A');
    const b = await createMember(gymId, 'Family B');
    const solo = await createPlan(gymId, 'Solo');
    const family = await createPlan(gymId, 'Family', '2');
    const aPlan = await post('/user-memberships', {
      member_id: a, membership_plan_id: solo, starts_at: '2026-01-01',
    });
    const bPlan = await post('/user-memberships', {
      member_id: b, membership_plan_id: solo, starts_at: '2026-02-01',
    });
    expect(aPlan.status).toBe(201);
    expect(bPlan.status).toBe(201);

    const refused = await post(`/membership-plans/${family}/assign`, {
      member_ids: [a, b], owner_member_id: a, starts_at: '2026-10-01',
    });
    expect(refused.status).toBe(409);
    // Both are named, so the gym weighs both cancellations at once.
    expect(refused.body.conflicts).toHaveLength(2);

    const res = await post(`/membership-plans/${family}/assign`, {
      member_ids: [a, b], owner_member_id: a, starts_at: '2026-10-01', confirm: true,
    });
    expect(res.status).toBe(201);
    for (const id of [aPlan.body.id, bPlan.body.id]) {
      const { rows } = await db.query('SELECT status FROM user_memberships WHERE id = ?', [id]);
      expect(rows[0].status).toBe('cancelled');
    }
  });

  it('refuses to cover a member who already has a live plan, and offers no confirm', async () => {
    const owner = await createMember(gymId, 'Cover Owner');
    const joiner = await createMember(gymId, 'Cover Joiner');
    const family = await createPlan(gymId, 'Cover Family', 'family');
    const solo = await createPlan(gymId, 'Cover Solo');
    const assigned = await post(`/membership-plans/${family}/assign`, {
      member_ids: [owner], owner_member_id: owner, starts_at: '2026-01-01',
    });
    expect(assigned.status).toBe(201);
    const joinersOwn = await post('/user-memberships', {
      member_id: joiner, membership_plan_id: solo, starts_at: '2026-02-01',
    });
    expect(joinersOwn.status).toBe(201);

    const refused = await post(`/user-memberships/${assigned.body.id}/members`, { member_id: joiner });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(ACTIVE_PLAN_EXISTS);
    expect(refused.body.message).toMatch(/Close it before adding them/);
    // Even confirmed: this path deliberately has no replacement, because there
    // is no new `starts_at` to end their own plan on.
    const refusedAgain = await post(
      `/user-memberships/${assigned.body.id}/members`, { member_id: joiner, confirm: true },
    );
    expect(refusedAgain.status).toBe(409);
    const { rows } = await db.query(
      'SELECT status FROM user_memberships WHERE id = ?', [joinersOwn.body.id],
    );
    expect(rows[0].status).toBe('active');

    // Closing their own plan is what makes the add go through.
    await post(`/user-memberships/${joinersOwn.body.id}/close`, { confirm: true });
    const added = await post(`/user-memberships/${assigned.body.id}/members`, { member_id: joiner });
    expect(added.status).toBe(201);
  });

  it('a covered member of a family plan already has a plan (#956 Q4)', async () => {
    const owner = await createMember(gymId, 'Owner');
    const coMember = await createMember(gymId, 'Co-member');
    const family = await createPlan(gymId, 'Family', '2');
    const solo = await createPlan(gymId, 'Solo');
    const assigned = await post(`/membership-plans/${family}/assign`, {
      member_ids: [owner, coMember], owner_member_id: owner, starts_at: '2026-01-01',
    });
    expect(assigned.status).toBe(201);

    // The co-member owns no `user_memberships` row at all — the conflict is
    // found through `user_membership_members`, which is the whole point of Q4.
    const res = await post('/user-memberships', {
      member_id: coMember, membership_plan_id: solo, starts_at: '2026-10-01',
    });
    expect(res.status).toBe(409);
    expect(res.body.current_plan.id).toBe(assigned.body.id);
    expect(res.body.current_plan.owner_member_id).toBe(owner);
    expect(res.body.current_plan.blocked_member_id).toBe(coMember);
  });
});
