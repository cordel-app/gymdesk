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
    // #2670: the member who left owns a family of their own
    const gone = await api(gymId).get(`/members/${kid}/family`);
    expect(gone.body.family.members.map((x: any) => [x.member_id, x.is_owner])).toEqual([[kid, true]]);
    expect(gone.body.family.id).not.toBe(created.body.family.id);
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

  it('dissolving a family gives each member a family of their own (#2670)', async () => {
    const a = await member(gymId, 'Dissolve A');
    const b = await member(gymId, 'Dissolve B');
    const created = await api(gymId).post(`/members/${a}/family`);
    await api(gymId).post(`/members/${a}/family/members`, { member_id: b });
    const del = await api(gymId).del(`/members/${a}/family`);
    expect(del.status).toBe(204);
    for (const m of [a, b]) {
      const f = (await api(gymId).get(`/members/${m}/family`)).body.family;
      expect(f.id).not.toBe(created.body.family.id);
      expect(f.members.map((x: any) => [x.member_id, x.is_owner])).toEqual([[m, true]]);
    }
  });

  it('a member alone in their family can neither leave nor dissolve it (#2670)', async () => {
    const solo = await member(gymId, 'Solo Owner');
    const c = await api(gymId).post(`/members/${solo}/family`);
    const rm = await api(gymId).del(`/members/${solo}/family/members/${solo}`);
    expect(rm.status).toBe(409);
    expect(rm.body.code).toBe('family_required');
    const dis = await api(gymId).del(`/members/${solo}/family`);
    expect(dis.status).toBe(409);
    expect(dis.body.code).toBe('family_required');
    const { rows } = await db.query('SELECT member_id FROM family_members WHERE family_id = ?', [c.body.family.id]);
    expect(rows.map((r: any) => r.member_id)).toEqual([solo]);
  });

  it('a member created through the API owns a family of their own, and may join another one (#2670)', async () => {
    const { insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, 'Family Center']);
    const centers = [{ id: centerId as number }];
    const res = await api(gymId).post('/members', {
      name: 'Created Member', email: `fam-new-${Date.now()}@test.com`,
      center_ids: [centers[0].id], default_center_id: centers[0].id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const own = (await api(gymId).get(`/members/${res.body.id}/family`)).body.family;
    expect(own.name).toBe('Created Member');
    expect(own.members.map((x: any) => [x.member_id, x.is_owner])).toEqual([[res.body.id, true]]);

    const parent = await member(gymId, 'Joining Parent');
    const fam = await api(gymId).post(`/members/${parent}/family`);
    const joined = await api(gymId).post(`/members/${parent}/family/members`, { member_id: res.body.id });
    expect(joined.status).toBe(201);
    expect(joined.body.family.id).toBe(fam.body.family.id);
    // the solo family it left is gone, and it is in exactly one family
    const { rows } = await db.query('SELECT id FROM families WHERE id = ?', [own.id]);
    expect(rows).toHaveLength(0);
    const { rows: links } = await db.query('SELECT family_id FROM family_members WHERE member_id = ?', [res.body.id]);
    expect(links.map((r: any) => r.family_id)).toEqual([fam.body.family.id]);

    // a member of a family with others still cannot be moved into another one
    const third = await member(gymId, 'Third Parent');
    await api(gymId).post(`/members/${third}/family`);
    const clash = await api(gymId).post(`/members/${third}/family/members`, { member_id: res.body.id });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('already_in_family');
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
