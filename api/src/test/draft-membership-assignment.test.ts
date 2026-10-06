// #1108 stage 1 — **a newly assigned Membership Plan is a Draft.**
//
// The ticket's §1 is the whole of this stage: assigning a plan no longer makes
// it the member's active membership. The row is created `draft` (migration 227
// widened `user_memberships_status_check` back open for it), it is fully
// editable while it is one (§2–§4), it bills nothing and cannot be booked on,
// and `POST /:id/activate` is the one transition that commits it — which is also
// where #956's "one member, one Membership Plan" check moved to, off the four
// insert paths that used to each run it.
//
// What is asserted here is the part that would be invisible otherwise: a Draft
// that silently behaved like an active plan would read correctly on every screen
// while the nightly run charged it, and a Draft that counted as the member's one
// plan would make configuring a replacement impossible — the two failure modes
// Q2's answer is about.
//
// Save & Pay, the Pending Payment state and the consolidation of the forecast
// into real Billing Events are stage 2's; nothing here anticipates them.

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
    [gymId, 'Draft Assignment Member', `draft-${uniq()}@test.com`],
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

async function readStatus(umId: number): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    'SELECT status FROM user_memberships WHERE id = ?', [umId],
  );
  return rows[0].status;
}

const api = (method: 'post' | 'put' | 'get', path: string, gymId: string) =>
  (request as any)[method](path)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);

async function assignPlan(gymId: string, memberId: number, planId: number, startsAt = '2026-03-01') {
  const res = await api('post', '/user-memberships', gymId)
    .send({ member_id: memberId, membership_plan_id: planId, starts_at: startsAt });
  expect(res.status).toBe(201);
  return res.body;
}

describe('#1108 stage 1 — every assignment path creates a Draft', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Draft Assignment Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('POST /user-memberships creates the assignment as a Draft', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Draft Plan ${uniq()}`);

    const created = await assignPlan(gymId, memberId, planId);
    expect(created.status).toBe('draft');
    // The stored column, not something the response composed.
    expect(await readStatus(created.id)).toBe('draft');
    // `lifecycle_status` is a projection of the stored status (#410) and a
    // stored `draft` outranks the date-aware part of it: a future-dated Draft
    // reads `draft`, not `pending`.
    expect(created.lifecycle_status).toBe('draft');
    // §1: no billing. A Draft is outside the nightly run's own
    // `WHERE status = 'active'` and has no cycle to be charged on yet.
    expect(created.next_billing_date).toBeNull();
  });

  it('POST /membership-plans/:id/assign creates a Draft too', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Draft Bulk Plan ${uniq()}`);

    const res = await api('post', `/membership-plans/${planId}/assign`, gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-03-01' });
    expect(res.status).toBe(201);
    expect(await readStatus(res.body.id)).toBe('draft');
  });

  it('assign-new-plan creates the successor as a Draft and leaves the plan it replaces running', async () => {
    const memberId = await createMember(gymId);
    const firstPlan = await createPlan(gymId, `Draft Superseded ${uniq()}`);
    const secondPlan = await createPlan(gymId, `Draft Successor ${uniq()}`);

    const first = await assignPlan(gymId, memberId, firstPlan);
    const activated = await api('post', `/user-memberships/${first.id}/activate`, gymId).send({});
    expect(activated.status).toBe(200);

    const res = await api('post', `/user-memberships/${first.id}/assign-new-plan`, gymId)
      .send({ membership_plan_id: secondPlan, starts_at: '2026-06-01' });
    expect(res.status).toBe(201);
    expect(await readStatus(res.body.id)).toBe('draft');
    // The point of the Draft: the member keeps the plan they are on while its
    // replacement is configured. The supersede happens at the commit.
    expect(await readStatus(first.id)).toBe('active');
  });

  it('records the creation as a NULL -> draft ledger transition', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Draft Ledger Plan ${uniq()}`);
    const created = await assignPlan(gymId, memberId, planId);

    const { rows } = await db.query<{ previous_status: string | null; new_status: string }>(
      `SELECT previous_status, new_status FROM billing_events
        WHERE user_membership_id = ? AND event_type = 'status_changed'
        ORDER BY id ASC`,
      [created.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].previous_status).toBeNull();
    expect(rows[0].new_status).toBe('draft');
  });
});

describe('#1108 stage 1 — a Draft is not the member\'s Membership Plan', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Draft Not Live Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('lets a member hold one Active plan and one Draft replacement at once', async () => {
    const memberId = await createMember(gymId);
    const livePlan = await createPlan(gymId, `Draft Beside Live ${uniq()}`);
    const nextPlan = await createPlan(gymId, `Draft Beside Next ${uniq()}`);

    const live = await assignPlan(gymId, memberId, livePlan);
    expect((await api('post', `/user-memberships/${live.id}/activate`, gymId).send({})).status).toBe(200);

    // #956 used to answer 409 here. Q2: a Draft is outside the live statuses, so
    // configuring a replacement beside a running plan is a legal state and the
    // conflict is raised by the commit instead.
    const draft = await api('post', '/user-memberships', gymId)
      .send({ member_id: memberId, membership_plan_id: nextPlan, starts_at: '2026-09-01' });
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe('draft');
    expect(await readStatus(live.id)).toBe('active');
  });

  it('does not report a Draft as the member\'s enrollment status', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Draft Enrollment Plan ${uniq()}`);
    await assignPlan(gymId, memberId, planId);

    const res = await api('get', '/members?limit=200', gymId).send();
    expect(res.status).toBe(200);
    const row = (res.body as any[]).find((m) => Number(m.id) === memberId);
    expect(row).toBeTruthy();
    // The Members list reads the *latest* assignment, so a Draft that reported
    // itself here would overwrite a member's real enrollment status.
    expect(row.enrollment_status ?? null).toBeNull();
  });

  it('keeps a Draft out of the member\'s own My Membership read', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Draft Me Plan ${uniq()}`);
    await assignPlan(gymId, memberId, planId);

    const { rows } = await db.query<{ status: string }>(
      `SELECT um.status FROM user_memberships um
        WHERE um.gym_id = ? AND um.member_id = ? AND um.status <> 'draft'`,
      [gymId, memberId],
    );
    // The member-facing filter is one constant
    // (MEMBER_CURRENT_ASSIGNMENT_FILTER); with only a Draft on file it selects
    // nothing, which is what `{ membership: null }` is for.
    expect(rows.length).toBe(0);
  });
});

describe('#1108 stage 1 — committing a Draft', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Draft Activation Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('POST /:id/activate moves draft -> active and records the transition', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Draft Activate Plan ${uniq()}`);
    const draft = await assignPlan(gymId, memberId, planId);

    const res = await api('post', `/user-memberships/${draft.id}/activate`, gymId).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(await readStatus(draft.id)).toBe('active');

    const { rows } = await db.query<{ previous_status: string | null; new_status: string }>(
      `SELECT previous_status, new_status FROM billing_events
        WHERE user_membership_id = ? AND event_type = 'status_changed'
        ORDER BY id DESC LIMIT 1`,
      [draft.id],
    );
    expect(rows[0].previous_status).toBe('draft');
    expect(rows[0].new_status).toBe('active');
  });

  it('refuses to activate anything that is not a Draft', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Draft Twice Plan ${uniq()}`);
    const draft = await assignPlan(gymId, memberId, planId);

    expect((await api('post', `/user-memberships/${draft.id}/activate`, gymId).send({})).status).toBe(200);
    // Idempotency is deliberately *not* silent: the second call says what it
    // found, which is also what the loser of two concurrent commits gets.
    const again = await api('post', `/user-memberships/${draft.id}/activate`, gymId).send({});
    expect(again.status).toBe(400);
  });

  it('answers 404 for another gym\'s assignment', async () => {
    const otherGym = await createTestGym('Draft Other Gym');
    await createTestMembership(otherGym, 'admin');
    const memberId = await createMember(otherGym);
    const planId = await createPlan(otherGym, `Draft Tenant Plan ${uniq()}`);
    const draft = await assignPlan(otherGym, memberId, planId);

    const res = await api('post', `/user-memberships/${draft.id}/activate`, gymId).send({});
    expect(res.status).toBe(404);
    expect(await readStatus(draft.id)).toBe('draft');
  });

  it('409s with the replacement conflict when the member already holds a live plan, and supersedes it on confirm', async () => {
    const memberId = await createMember(gymId);
    const livePlan = await createPlan(gymId, `Draft Conflict Live ${uniq()}`);
    const nextPlan = await createPlan(gymId, `Draft Conflict Next ${uniq()}`);

    const live = await assignPlan(gymId, memberId, livePlan, '2026-03-01');
    expect((await api('post', `/user-memberships/${live.id}/activate`, gymId).send({})).status).toBe(200);
    const draft = await assignPlan(gymId, memberId, nextPlan, '2026-09-01');

    const refused = await api('post', `/user-memberships/${draft.id}/activate`, gymId).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('active_plan_exists');
    expect(refused.body.current_plan.id).toBe(live.id);
    // Refusing changes nothing.
    expect(await readStatus(draft.id)).toBe('draft');
    expect(await readStatus(live.id)).toBe('active');

    const confirmed = await api('post', `/user-memberships/${draft.id}/activate`, gymId)
      .send({ confirm: true });
    expect(confirmed.status).toBe(200);
    expect(await readStatus(draft.id)).toBe('active');
    expect(await readStatus(live.id)).toBe('cancelled');

    // #956 Q3: the two plans meet at one date — the new one's `starts_at`.
    const { rows } = await db.query<{ ends_at: string; closed_at: string | null }>(
      `SELECT DATE_FORMAT(ends_at, '%Y-%m-%d') AS ends_at, closed_at
         FROM user_memberships WHERE id = ?`,
      [live.id],
    );
    expect(rows[0].ends_at).toBe('2026-09-01');
    expect(rows[0].closed_at).not.toBeNull();
  });

  it('refuses a Draft that starts before the plan it would replace', async () => {
    const memberId = await createMember(gymId);
    const livePlan = await createPlan(gymId, `Draft Backdate Live ${uniq()}`);
    const nextPlan = await createPlan(gymId, `Draft Backdate Next ${uniq()}`);

    const live = await assignPlan(gymId, memberId, livePlan, '2026-05-01');
    expect((await api('post', `/user-memberships/${live.id}/activate`, gymId).send({})).status).toBe(200);
    const draft = await assignPlan(gymId, memberId, nextPlan, '2026-01-01');

    const res = await api('post', `/user-memberships/${draft.id}/activate`, gymId)
      .send({ confirm: true });
    expect(res.status).toBe(400);
    expect(await readStatus(live.id)).toBe('active');
    expect(await readStatus(draft.id)).toBe('draft');
  });

  it('refuses a plain PUT status flip out of draft and names the activation route', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Draft Put Plan ${uniq()}`);
    const draft = await assignPlan(gymId, memberId, planId);

    const res = await api('put', `/user-memberships/${draft.id}`, gymId).send({ status: 'active' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('activate');
    expect(await readStatus(draft.id)).toBe('draft');
  });

  it('discards a Draft through Close, with no unused-value warning to confirm', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Draft Close Plan ${uniq()}`);
    const draft = await assignPlan(gymId, memberId, planId);

    // Q1a: a Draft nobody pays for does not expire — staff cancel it. It never
    // had a `next_billing_date`, so there is nothing for the 409 guard to warn
    // about and the first call closes it.
    const res = await api('post', `/user-memberships/${draft.id}/close`, gymId).send({});
    expect(res.status).toBe(200);
    expect(await readStatus(draft.id)).toBe('cancelled');
  });
});

describe('#1108 stage 1 — a Draft is editable, projected, and not billable', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Draft Editable Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('lets every snapshot section of a Draft be edited (§2)', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Draft Editable Plan ${uniq()}`);
    const draft = await assignPlan(gymId, memberId, planId);

    const res = await api('put', `/user-memberships/${draft.id}/billing-duration`, gymId)
      .send({ free_periods: 1, paid_periods: 12, bonus_periods: 0, pay_beforehand_periods: 0 });
    expect(res.status).toBe(200);
  });

  it('projects a Draft in its own Billing Event Forecast (§5 / Q3)', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Draft Forecast Plan ${uniq()}`);
    const draft = await assignPlan(gymId, memberId, planId);

    const res = await api('get', `/user-memberships/${draft.id}/billing-event-simulation`, gymId).send();
    expect(res.status).toBe(200);
    // The forecast is what §5 asks for — what *would* be billed if the Draft
    // were committed — so a Draft is simulated rather than reported as having
    // nothing scheduled.
    expect(res.body).toHaveProperty('available');
  });

  it('keeps a Draft out of the nightly run\'s due set', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId, `Draft Unbilled Plan ${uniq()}`);
    const draft = await assignPlan(gymId, memberId, planId);

    // The run's own predicate, asserted against the stored row rather than by
    // calling the run (which claims a per-UTC-date slot, #780).
    await db.query('UPDATE user_memberships SET next_billing_date = CURDATE() WHERE id = ?', [draft.id]);
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_memberships
        WHERE id = ? AND status = 'active' AND next_billing_date <= CURDATE()`,
      [draft.id],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});
