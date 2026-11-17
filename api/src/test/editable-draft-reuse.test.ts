// #2858 — a Draft Product Set is edited as many times as needed: opening an editor while the owner
// already holds a Draft reuses it instead of answering `This member already has a ProductSet
// version in flight`; a genuinely new configuration still keeps the one-in-flight rule.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productSetLegacyAssignmentIdSql } from '../domain/planAssignments';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestDraftAssignment,
  createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

beforeAll(async () => {
  gymId = await createTestGym('Editable Draft Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const post = (path: string, body: object = {}) =>
  request.post(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send(body);

async function memberWithPlan(active: boolean) {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `Plan-${uniq()}`]);
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Draft Owner', `dr-${uniq()}@test.com`]);
  const umId = await createTestDraftAssignment(gymId, memberId, planId);
  if (active) await activateTestAssignment(gymId, umId);
  return { memberId: Number(memberId), umId: Number(umId) };
}

const setsOf = async (memberId: number) => (await db.query<any>(
  `SELECT id, status, ${productSetLegacyAssignmentIdSql('product_sets')} AS user_membership_id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? ORDER BY id`,
  [gymId, memberId])).rows;

describe('reusing the owner\'s Draft (#2858)', () => {
  it('⋮ → Edit on a running plan adopts the products Draft instead of refusing it', async () => {
    const { memberId, umId } = await memberWithPlan(true);
    const draft = await post('/product-sets/draft', { member_id: memberId });
    expect(draft.status).toBe(201);

    const edit = await post(`/user-memberships/${umId}/edit-draft`);
    expect(edit.status).toBe(201);
    expect(edit.body.error).toBeUndefined();

    const sets = await setsOf(memberId);
    expect(sets.map((s: any) => s.status)).toEqual(['active', 'in_cart']);
    expect(Number(sets[1].id)).toBe(Number(draft.body.id));
    expect(Number(sets[1].user_membership_id)).toBe(edit.body.id);

    // Editing products again lands on that same Draft, never a new version or `in_flight`.
    const again = await post('/product-sets/draft', { member_id: memberId });
    expect(again.status).toBe(200);
    expect(Number(again.body.id)).toBe(Number(draft.body.id));
    expect(await setsOf(memberId)).toHaveLength(2);

    // And ⋮ → Edit a second time returns the same Draft assignment.
    const editAgain = await post(`/user-memberships/${umId}/edit-draft`);
    expect(editAgain.status).toBe(200);
    expect(editAgain.body.id).toBe(edit.body.id);
  });

  it('a products Draft opened after ⋮ → Edit reuses the edit Draft', async () => {
    const { memberId, umId } = await memberWithPlan(true);
    const edit = await post(`/user-memberships/${umId}/edit-draft`);
    expect(edit.status).toBe(201);
    const draftId = Number((await setsOf(memberId)).find((s: any) => s.status === 'in_cart').id);

    const products = await post('/product-sets/draft', { member_id: memberId });
    expect(products.status).toBe(200);
    expect(Number(products.body.id)).toBe(draftId);
    expect(await setsOf(memberId)).toHaveLength(2);
  });

  it('a Draft that assigns a new plan is reused by the products editor (#2891)', async () => {
    const { memberId } = await memberWithPlan(false);
    const draftId = Number((await setsOf(memberId))[0].id);
    const res = await post('/product-sets/draft', { member_id: memberId });
    expect(res.status).toBe(200);
    expect(Number(res.body.id)).toBe(draftId);
    expect(await setsOf(memberId)).toHaveLength(1);
  });
});
