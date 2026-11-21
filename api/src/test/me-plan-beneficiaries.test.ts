// #3091: the Members App lets the contracting member choose who the plan covers, judged by the
// staff assignment's own rule (`beneficiarySelectionError()`): the member is not forced in, the
// count must meet the plan's Members per Membership, and everyone is drawn from their family.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestFamily, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
const stamp = Date.now();
let ownerClerk: string;
let owner: number;
let child: number;
let stranger: number;
let planOne: number;
let planTwo: number;

async function member(name: string, clerk: string | null): Promise<number> {
  if (clerk) await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, name, `${name}-${stamp}@test.com`, clerk]);
  return insertId as number;
}

async function plan(name: string, limit: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', ?)`, [gymId, name, limit]);
  return insertId as number;
}

function post(path: string, body: object) {
  vi.mocked(verifyToken).mockResolvedValue({ sub: ownerClerk } as any);
  return request.post(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send(body);
}

async function discard(setId: number) {
  vi.mocked(verifyToken).mockResolvedValue({ sub: ownerClerk } as any);
  await request.delete(`/me/product-sets/${setId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
}

async function coverage(setId: number): Promise<{ ids: number[]; ownerIsBeneficiary: number }> {
  const { rows } = await db.query<any>(
    `SELECT s.owner_is_beneficiary, b.member_id
       FROM product_set_plan_snapshots j JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
       LEFT JOIN plan_snapshot_beneficiaries b ON b.plan_snapshot_id = s.id
      WHERE j.product_set_id = ?`, [setId]);
  return { ids: rows.map((r: any) => Number(r.member_id)).filter(Boolean).sort(), ownerIsBeneficiary: Number(rows[0]?.owner_is_beneficiary) };
}

beforeAll(async () => {
  gymId = await createTestGym('Member Plan Beneficiaries Gym');
  ownerClerk = `mpb-owner-${stamp}`;
  owner = await member('Owner', ownerClerk);
  child = await member('Child', null);
  stranger = await member('Stranger', null);
  await createTestFamily(gymId, owner, [child]);
  planOne = await plan('Single', '1');
  planTwo = await plan('Duo', '2');
});

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('beneficiaries chosen while contracting (#3091)', () => {
  it('lists the owner family (the member first) and each plan\'s member limit', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: ownerClerk } as any);
    const res = await request.get('/me/membership-plans').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.family_members.map((m: any) => m.member_id)).toEqual([owner, child]);
    expect(res.body.plans.find((p: any) => p.id === planTwo).member_limit).toBe('2');
  });

  it('lets the member leave themselves out and cover a family member', async () => {
    const res = await post(`/me/membership-plans/${planOne}/assign`, { beneficiary_member_ids: [child] });
    expect(res.status).toBe(201);
    const cov = await coverage(res.body.id);
    expect(cov.ids).toEqual([child]);
    expect(cov.ownerIsBeneficiary).toBe(0);
    await discard(res.body.id);
  });

  it('refuses a selection that does not meet the plan\'s member count', async () => {
    const res = await post(`/me/membership-plans/${planTwo}/assign`, { beneficiary_member_ids: [owner] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('beneficiary_count');
    const none = await post(`/me/membership-plans/${planOne}/assign`, { beneficiary_member_ids: [] });
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('beneficiaries_required');
  });

  it('refuses someone outside the member\'s family', async () => {
    const res = await post(`/me/membership-plans/${planOne}/assign`, { beneficiary_member_ids: [stranger] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('beneficiary_not_in_family');
  });

  it('covers the member and the child on a two-member plan, and keeps the old default when no ids are sent', async () => {
    const duo = await post(`/me/membership-plans/${planTwo}/assign`, { beneficiary_member_ids: [owner, child] });
    expect(duo.status).toBe(201);
    expect((await coverage(duo.body.id)).ids).toEqual([owner, child].sort());
    await discard(duo.body.id);
    const legacy = await post(`/me/membership-plans/${planOne}/assign`, {});
    expect(legacy.status).toBe(201);
    expect((await coverage(legacy.body.id)).ids).toEqual([owner]);
  });
});
