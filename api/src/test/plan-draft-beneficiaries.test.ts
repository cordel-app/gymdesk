// #2879 stage 2 / #3152 — a Draft assignment's beneficiaries.
//
// While the assignment is a Draft, staff change its beneficiaries through
// `PUT /user-memberships/:id/beneficiaries`, judged against the owner's family and the
// Plan's Members per Membership (`member_limit`, frozen on the plan snapshot and read-only
// on an assignment: a request naming another value is refused). The Plan is never touched,
// and a confirmed assignment refuses the edit.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestFamily, createTestGym, createTestMembership, legacyChildQuery, request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

describe('Draft beneficiaries (#2879 stage 2)', () => {
  let gymId: string;
  let otherGymId: string;

  beforeAll(async () => {
    gymId = await createTestGym();
    otherGymId = await createTestGym();
    await createTestMembership(gymId, 'admin');
  });

  async function createPlan(limit: '1' | '2' | 'family'): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
       VALUES (?, ?, 'active', 'staff_only', ?)`,
      [gymId, `Draft Beneficiary Plan ${uniq()}`, limit],
    );
    return insertId;
  }

  async function createMember(name: string): Promise<number> {
    const { insertId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, name, `dben-${uniq()}@test.com`],
    );
    return insertId;
  }

  /** A Draft of a plan of `limit` for `owner`, covering `beneficiaries`. */
  async function draftFor(limit: '1' | '2' | 'family', owner: number, beneficiaries: number[]) {
    const plan = await createPlan(limit);
    const res = await request
      .post(`/membership-plans/${plan}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ starts_at: '2026-12-01', owner_member_id: owner, beneficiary_member_ids: beneficiaries });
    expect(res.status).toBe(201);
    return { planId: plan, assignmentId: Number(res.body.id) };
  }

  function put(id: number, body: Record<string, unknown>, gym = gymId) {
    return request
      .put(`/user-memberships/${id}/beneficiaries`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gym)
      .send(body);
  }

  function get(id: number, gym = gymId) {
    return request.get(`/user-memberships/${id}/beneficiaries`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
  }

  async function beneficiariesOf(userMembershipId: number): Promise<number[]> {
    const { rows } = await legacyChildQuery(
      'SELECT member_id FROM user_membership_members WHERE user_membership_id = ? ORDER BY member_id',
      [userMembershipId],
    );
    return rows.map((r: any) => Number(r.member_id));
  }

  const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

  it('reports the Draft\'s own limit and beneficiaries, editable', async () => {
    const parent = await createMember('Parent');
    const kid = await createMember('Kid');
    await createTestFamily(gymId, parent, [kid]);
    const { assignmentId } = await draftFor('1', parent, [kid]);

    const res = await get(assignmentId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ editable: true, owner_member_id: parent, member_limit: '1', beneficiary_member_ids: [kid] });
  });

  it('swaps the beneficiaries within the Plan\'s count, leaving the Plan and its limit alone', async () => {
    const parent = await createMember('Parent');
    const kidA = await createMember('Kid A');
    const kidB = await createMember('Kid B');
    await createTestFamily(gymId, parent, [kidA, kidB]);
    const { planId, assignmentId } = await draftFor('2', parent, [parent, kidA]);

    const res = await put(assignmentId, { beneficiary_member_ids: [kidA, kidB] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ member_limit: '2' });
    expect(sorted(res.body.beneficiary_member_ids)).toEqual(sorted([kidA, kidB]));
    // The owner is no longer a beneficiary but stays the payer.
    expect(await beneficiariesOf(assignmentId)).toEqual(sorted([kidA, kidB]));
    const { rows: um } = await db.query('SELECT member_id FROM user_memberships WHERE id = ?', [assignmentId]);
    expect(Number(um[0].member_id)).toBe(parent);
    const { rows: plan } = await db.query('SELECT member_limit FROM membership_plans WHERE id = ?', [planId]);
    expect(plan[0].member_limit).toBe('2');
    const members = await request.get(`/user-memberships/${assignmentId}/members`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(members.body.member_limit).toBe('2');
  });

  it('refuses a selection that does not match the Plan\'s count, changing nothing', async () => {
    const parent = await createMember('Parent');
    const kid = await createMember('Kid');
    await createTestFamily(gymId, parent, [kid]);
    const { assignmentId } = await draftFor('1', parent, [parent]);

    const res = await put(assignmentId, { beneficiary_member_ids: [parent, kid] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('beneficiary_count');
    expect(await beneficiariesOf(assignmentId)).toEqual([parent]);
    expect((await get(assignmentId)).body.member_limit).toBe('1');
  });

  it('refuses a request that tries to change Members per Membership, changing nothing', async () => {
    const parent = await createMember('Parent');
    const kidA = await createMember('Kid A');
    const kidB = await createMember('Kid B');
    await createTestFamily(gymId, parent, [kidA, kidB]);
    const { assignmentId } = await draftFor('1', parent, [parent]);

    const res = await put(assignmentId, { member_limit: '2', beneficiary_member_ids: [kidA, kidB] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('member_limit_read_only');
    expect(await beneficiariesOf(assignmentId)).toEqual([parent]);
    expect((await get(assignmentId)).body.member_limit).toBe('1');
    // Restating the plan's own value is harmless.
    const same = await put(assignmentId, { member_limit: '1', beneficiary_member_ids: [kidA] });
    expect(same.status).toBe(200);
  });

  it('keeps the stored limit when the request names none', async () => {
    const parent = await createMember('Parent');
    const kidA = await createMember('Kid A');
    const kidB = await createMember('Kid B');
    await createTestFamily(gymId, parent, [kidA, kidB]);
    const { assignmentId } = await draftFor('2', parent, [parent, kidA]);

    const res = await put(assignmentId, { beneficiary_member_ids: [kidA, kidB] });
    expect(res.status).toBe(200);
    expect(res.body.member_limit).toBe('2');
    expect(await beneficiariesOf(assignmentId)).toEqual(sorted([kidA, kidB]));
  });

  it('accepts any count of at least one on a family plan', async () => {
    const parent = await createMember('Parent');
    const kidA = await createMember('Kid A');
    const kidB = await createMember('Kid B');
    await createTestFamily(gymId, parent, [kidA, kidB]);
    const { assignmentId } = await draftFor('family', parent, [parent]);

    const res = await put(assignmentId, { beneficiary_member_ids: [parent, kidA, kidB] });
    expect(res.status).toBe(200);
    expect(await beneficiariesOf(assignmentId)).toEqual(sorted([parent, kidA, kidB]));
    const empty = await put(assignmentId, { beneficiary_member_ids: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('beneficiaries_required');
  });

  it('refuses a member outside the owner\'s family', async () => {
    const parent = await createMember('Parent');
    const kid = await createMember('Kid');
    const stranger = await createMember('Stranger');
    await createTestFamily(gymId, parent, [kid]);
    const { assignmentId } = await draftFor('2', parent, [parent, kid]);

    const res = await put(assignmentId, { beneficiary_member_ids: [parent, stranger] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('beneficiary_not_in_family');
    expect(await beneficiariesOf(assignmentId)).toEqual(sorted([parent, kid]));
  });

  it('refuses an unknown member_limit and a malformed selection', async () => {
    const parent = await createMember('Parent');
    await createTestFamily(gymId, parent, []);
    const { assignmentId } = await draftFor('1', parent, [parent]);

    expect((await put(assignmentId, { member_limit: '3', beneficiary_member_ids: [parent] })).status).toBe(400);
    expect((await put(assignmentId, { beneficiary_member_ids: 'x' })).status).toBe(400);
    expect((await put(assignmentId, {})).status).toBe(400);
  });

  it('refuses the edit once the assignment is no longer a Draft', async () => {
    const parent = await createMember('Parent');
    const kid = await createMember('Kid');
    await createTestFamily(gymId, parent, [kid]);
    const { assignmentId } = await draftFor('1', parent, [parent]);
    const activate = await request.post(`/user-memberships/${assignmentId}/activate`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({});
    expect(activate.status).toBe(200);

    const res = await put(assignmentId, { beneficiary_member_ids: [kid] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_a_draft');
    expect((await get(assignmentId)).body.editable).toBe(false);
  });

  it('is tenant-isolated and authenticated', async () => {
    const parent = await createMember('Parent');
    await createTestFamily(gymId, parent, []);
    const { assignmentId } = await draftFor('1', parent, [parent]);

    expect((await get(assignmentId, otherGymId)).status).toBeGreaterThanOrEqual(403);
    expect((await put(assignmentId, { beneficiary_member_ids: [parent] }, otherGymId)).status).toBeGreaterThanOrEqual(403);
    const anon = await request.get(`/user-memberships/${assignmentId}/beneficiaries`).set('x-gym-id', gymId);
    expect(anon.status).toBe(401);
  });

  it('freezes the Plan\'s limit onto a new assignment', async () => {
    const parent = await createMember('Parent');
    const kid = await createMember('Kid');
    await createTestFamily(gymId, parent, [kid]);
    const { planId, assignmentId } = await draftFor('2', parent, [parent, kid]);
    await db.query("UPDATE membership_plans SET member_limit = 'family' WHERE id = ?", [planId]);

    expect((await get(assignmentId)).body.member_limit).toBe('2');
  });
});
