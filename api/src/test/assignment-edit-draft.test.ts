// #2091 — ⋮ → Edit on a running plan copies the Active version's own configuration.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestDraftAssignment,
  createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let otherGymId: string;
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

beforeAll(async () => {
  gymId = await createTestGym('Edit Draft Gym');
  otherGymId = await createTestGym('Edit Draft Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const post = (path: string, gym = gymId) =>
  request.post(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function activeAssignment() {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `Plan-${uniq()}`]);
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Edit Draft', `ed-${uniq()}@test.com`]);
  const umId = await createTestDraftAssignment(gymId, memberId, planId);
  await activateTestAssignment(gymId, umId);
  return { planId, memberId, umId };
}

describe('POST /user-memberships/:id/edit-draft', () => {
  it('creates a Draft copied from the Active version and leaves the Active one untouched', async () => {
    const { memberId, umId } = await activeAssignment();
    // The Active version's frozen fee differs from anything the catalogue holds.
    await db.query(
      `UPDATE plan_snapshots snap JOIN product_sets ps ON ps.id = snap.product_set_id
          SET snap.membership_fee_price = 77.5
        WHERE ps.gym_id = ? AND ps.owner_member_id = ? AND ps.status = 'active'`, [gymId, memberId]);

    const res = await post(`/user-memberships/${umId}/edit-draft`);
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(umId);

    const { rows: sets } = await db.query<any>(
      `SELECT ps.status, ps.user_membership_id, snap.membership_fee_price
         FROM product_sets ps JOIN plan_snapshots snap ON snap.product_set_id = ps.id
        WHERE ps.gym_id = ? AND ps.owner_member_id = ? ORDER BY ps.version`, [gymId, memberId]);
    expect(sets.map((s: any) => s.status)).toEqual(['active', 'draft']);
    expect(Number(sets[1].membership_fee_price)).toBe(77.5);
    expect(Number(sets[1].user_membership_id)).toBe(res.body.id);
    const { rows: um } = await db.query<any>('SELECT status FROM user_memberships WHERE id = ?', [umId]);
    expect(um[0].status).toBe('active');
  });

  it('is idempotent: a second call returns the same Draft', async () => {
    const { umId } = await activeAssignment();
    const first = await post(`/user-memberships/${umId}/edit-draft`);
    const second = await post(`/user-memberships/${umId}/edit-draft`);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it('is tenant-scoped and needs auth', async () => {
    const { umId } = await activeAssignment();
    expect((await post(`/user-memberships/${umId}/edit-draft`, otherGymId)).status).toBe(404);
    expect((await request.post(`/user-memberships/${umId}/edit-draft`)).status).toBe(401);
  });
});
