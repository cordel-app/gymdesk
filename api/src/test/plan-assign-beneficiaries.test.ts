// #2879 — Assign Plan: the beneficiaries come from the owner's family.
//
// `POST /membership-plans/:id/assign` takes `owner_member_id` (the payer) and
// `beneficiary_member_ids`, all members of the owner's family, exactly as many as
// the plan's Members per Membership (`member_limit`), at least one for a family
// plan. The owner need not be a beneficiary.

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

describe('POST /membership-plans/:id/assign — family beneficiaries (#2879)', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym();
    await createTestMembership(gymId, 'admin');
  });

  async function createPlan(limit: '1' | '2' | 'family'): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
       VALUES (?, ?, 'active', 'staff_only', ?)`,
      [gymId, `Beneficiary Plan ${uniq()}`, limit],
    );
    return insertId;
  }

  async function createMember(name = 'Beneficiary Member', inGym = gymId): Promise<number> {
    const { insertId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [inGym, name, `ben-${uniq()}@test.com`],
    );
    return insertId;
  }

  function assign(planId: number, body: Record<string, unknown>, gym = gymId) {
    return request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gym)
      .send({ starts_at: '2026-12-01', ...body });
  }

  async function beneficiariesOf(userMembershipId: number): Promise<number[]> {
    const { rows } = await legacyChildQuery(
      'SELECT member_id FROM user_membership_members WHERE user_membership_id = ? ORDER BY member_id',
      [userMembershipId],
    );
    return rows.map((r: any) => Number(r.member_id));
  }

  it('covers family members without the family owner, who still owns the assignment', async () => {
    const plan = await createPlan('2');
    const parent = await createMember('Parent');
    const kidA = await createMember('Kid A');
    const kidB = await createMember('Kid B');
    await createTestFamily(gymId, parent, [kidA, kidB]);

    const res = await assign(plan, { owner_member_id: parent, beneficiary_member_ids: [kidA, kidB] });
    expect(res.status).toBe(201);
    expect(res.body.member_id).toBe(parent);
    expect(await beneficiariesOf(res.body.id)).toEqual([kidA, kidB].sort((a, b) => a - b));
  });

  it('covers the owner when the owner is selected', async () => {
    const plan = await createPlan('2');
    const parent = await createMember('Parent');
    const kid = await createMember('Kid');
    await createTestFamily(gymId, parent, [kid]);

    const res = await assign(plan, { owner_member_id: parent, beneficiary_member_ids: [parent, kid] });
    expect(res.status).toBe(201);
    expect(await beneficiariesOf(res.body.id)).toEqual([parent, kid].sort((a, b) => a - b));
  });

  it('refuses a member outside the family', async () => {
    const plan = await createPlan('2');
    const parent = await createMember('Parent');
    const kid = await createMember('Kid');
    const stranger = await createMember('Stranger');
    await createTestFamily(gymId, parent, [kid]);

    const res = await assign(plan, { owner_member_id: parent, beneficiary_member_ids: [kid, stranger] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('beneficiary_not_in_family');
    expect(res.body.member_ids).toEqual([stranger]);
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM user_memberships WHERE member_id = ?', [parent]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('refuses more or fewer beneficiaries than Members per Membership', async () => {
    const plan = await createPlan('2');
    const parent = await createMember('Parent');
    const kidA = await createMember('Kid A');
    const kidB = await createMember('Kid B');
    await createTestFamily(gymId, parent, [kidA, kidB]);

    const fewer = await assign(plan, { owner_member_id: parent, beneficiary_member_ids: [kidA] });
    expect(fewer.status).toBe(400);
    expect(fewer.body.code).toBe('beneficiary_count');
    const more = await assign(plan, { owner_member_id: parent, beneficiary_member_ids: [parent, kidA, kidB] });
    expect(more.status).toBe(400);
    expect(more.body.code).toBe('beneficiary_count');
  });

  it('refuses a plan the family is too small for', async () => {
    const plan = await createPlan('2');
    const solo = await createMember('Solo');
    await createTestFamily(gymId, solo);
    const res = await assign(plan, { owner_member_id: solo, beneficiary_member_ids: [solo] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('beneficiary_count');
  });

  it('takes any non-empty part of the family for a family plan', async () => {
    const plan = await createPlan('family');
    const parent = await createMember('Parent');
    const kidA = await createMember('Kid A');
    const kidB = await createMember('Kid B');
    await createTestFamily(gymId, parent, [kidA, kidB]);

    const res = await assign(plan, { owner_member_id: parent, beneficiary_member_ids: [kidB] });
    expect(res.status).toBe(201);
    expect(await beneficiariesOf(res.body.id)).toEqual([kidB]);

    const empty = await assign(plan, { owner_member_id: parent, beneficiary_member_ids: [] });
    expect(empty.status).toBe(400);
  });

  it('refuses a member of another gym as a beneficiary', async () => {
    const otherGym = await createTestGym();
    const plan = await createPlan('2');
    const parent = await createMember('Parent');
    const kid = await createMember('Kid');
    await createTestFamily(gymId, parent, [kid]);
    const foreign = await createMember('Foreign', otherGym);

    const res = await assign(plan, { owner_member_id: parent, beneficiary_member_ids: [kid, foreign] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('rejects a malformed beneficiary list', async () => {
    const plan = await createPlan('1');
    const parent = await createMember('Parent');
    const res = await assign(plan, { owner_member_id: parent, beneficiary_member_ids: 'nope' });
    expect(res.status).toBe(400);
  });
});
