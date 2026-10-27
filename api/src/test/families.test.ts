// #2123 stage 1: Family model — /members/:memberId/family.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let gymId: string;
let otherGymId: string;

async function member(gym: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gym, name, `fam-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`]);
  return insertId as number;
}
const api = (gym: string) => ({
  get: (p: string) => request.get(p).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym),
  post: (p: string, b: object = {}) => request.post(p).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send(b),
  put: (p: string, b: object = {}) => request.put(p).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send(b),
  del: (p: string) => request.delete(p).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym),
});

beforeAll(async () => {
  gymId = await createTestGym('Families Gym');
  otherGymId = await createTestGym('Families Other Gym');
  await createTestMembership(gymId);
  await createTestMembership(otherGymId);
});

describe('families', () => {
  it('requires authentication', async () => {
    const res = await request.get('/members/1/family');
    expect(res.status).toBe(401);
  });

  it('a member without a family reads { family: null }', async () => {
    const m = await member(gymId, 'Solo');
    const res = await api(gymId).get(`/members/${m}/family`);
    expect(res.status).toBe(200);
    expect(res.body.family).toBeNull();
  });

  it('creates a family with the member as its single owner, and adds/removes members', async () => {
    const owner = await member(gymId, 'Owner');
    const kid = await member(gymId, 'Kid');
    const created = await api(gymId).post(`/members/${owner}/family`);
    expect(created.status).toBe(201);
    expect(created.body.family.owner_member_id).toBe(owner);
    expect(created.body.family.payer_member_id).toBe(owner);

    const dup = await api(gymId).post(`/members/${owner}/family`);
    expect(dup.status).toBe(409);

    const added = await api(gymId).post(`/members/${owner}/family/members`, { member_id: kid });
    expect(added.status).toBe(201);
    expect(added.body.family.members.map((x: any) => [x.member_id, x.is_owner])).toEqual([[owner, true], [kid, false]]);

    // readable from either member
    const fromKid = await api(gymId).get(`/members/${kid}/family`);
    expect(fromKid.body.family.id).toBe(created.body.family.id);

    // a member cannot be in two families
    const other = await member(gymId, 'Other Owner');
    await api(gymId).post(`/members/${other}/family`);
    const clash = await api(gymId).post(`/members/${other}/family/members`, { member_id: kid });
    expect(clash.status).toBe(409);

    const removed = await api(gymId).del(`/members/${owner}/family/members/${kid}`);
    expect(removed.status).toBe(200);
    expect(removed.body.family.members).toHaveLength(1);
    const gone = await api(gymId).get(`/members/${kid}/family`);
    expect(gone.body.family).toBeNull();
  });

  it('keeps exactly one owner: owner cannot be removed while others remain; ownership changes', async () => {
    const a = await member(gymId, 'A');
    const b = await member(gymId, 'B');
    await api(gymId).post(`/members/${a}/family`);
    await api(gymId).post(`/members/${a}/family/members`, { member_id: b });

    const refused = await api(gymId).del(`/members/${a}/family/members/${a}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('owner_cannot_be_removed');

    const outsider = await member(gymId, 'Outsider');
    const bad = await api(gymId).put(`/members/${a}/family/owner`, { member_id: outsider });
    expect(bad.status).toBe(400);

    const changed = await api(gymId).put(`/members/${a}/family/owner`, { member_id: b });
    expect(changed.status).toBe(200);
    expect(changed.body.family.owner_member_id).toBe(b);
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM family_members WHERE is_owner = 1 AND family_id = ?', [changed.body.family.id]);
    expect(Number((rows[0] as any).n)).toBe(1);

    // the database itself refuses a second owner
    await expect(db.query('UPDATE family_members SET is_owner = 1 WHERE family_id = ? AND member_id = ?', [changed.body.family.id, a]))
      .rejects.toThrow();
  });

  it('dissolves a family; removing the sole member dissolves it too', async () => {
    const a = await member(gymId, 'Dissolve A');
    const b = await member(gymId, 'Dissolve B');
    await api(gymId).post(`/members/${a}/family`);
    await api(gymId).post(`/members/${a}/family/members`, { member_id: b });
    const del = await api(gymId).del(`/members/${a}/family`);
    expect(del.status).toBe(204);
    expect((await api(gymId).get(`/members/${b}/family`)).body.family).toBeNull();

    const solo = await member(gymId, 'Solo Owner');
    const c = await api(gymId).post(`/members/${solo}/family`);
    const rm = await api(gymId).del(`/members/${solo}/family/members/${solo}`);
    expect(rm.status).toBe(200);
    expect(rm.body.family).toBeNull();
    const { rows } = await db.query('SELECT id FROM families WHERE id = ?', [c.body.family.id]);
    expect(rows).toHaveLength(0);
  });

  it('isolates tenants: no cross-gym members or families', async () => {
    const mine = await member(gymId, 'Tenant A');
    const foreign = await member(otherGymId, 'Tenant B');
    await api(gymId).post(`/members/${mine}/family`);

    expect((await api(gymId).get(`/members/${foreign}/family`)).status).toBe(404);
    expect((await api(gymId).post(`/members/${foreign}/family`)).status).toBe(404);
    const add = await api(gymId).post(`/members/${mine}/family/members`, { member_id: foreign });
    expect(add.status).toBe(404);
    // the other gym cannot read my family
    expect((await api(otherGymId).get(`/members/${mine}/family`)).status).toBe(404);
  });
});
