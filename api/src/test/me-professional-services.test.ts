// #1779 — `GET /me/professional-services`, the member's own balance per service.
// Integration: the balance is the booking gate's own derived one, so what is
// under test is the shape, the gym's switched-on services only, and isolation.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const ROOT = '/me/professional-services';
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;

async function memberIn(gid: string, clerkId: string): Promise<number> {
  await createTestMembership(gid, 'member', clerkId);
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gid, 'Services Member', `mps-${uniq()}@test.com`, clerkId],
  );
  return insertId;
}

async function service(gid: string, name: string, status: 'active' | 'inactive' = 'active'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)`,
    [gid, name],
  );
  await db.query(
    `INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, ?)`,
    [gid, insertId, status],
  );
  return insertId;
}

async function grant(gid: string, memberId: number, serviceId: number, sessions: number) {
  await db.query(
    `INSERT INTO professional_service_adjustments
       (gym_id, member_id, professional_service_id, delta, balance_before, balance_after, reason)
     VALUES (?, ?, ?, ?, 0, ?, 'test')`,
    [gid, memberId, serviceId, sessions, sessions],
  );
}

function asMember(gid: string, clerkId: string) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerkId } as any);
  return request.get(ROOT).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid);
}

let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Member Services Gym');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/professional-services', () => {
  it('returns 401 without auth', async () => {
    expect((await request.get(ROOT).set('x-gym-id', gymId)).status).toBe(401);
  });

  it('returns 403 for a gym role that is not a member', async () => {
    await createTestMembership(gymId, 'admin', 'mps-admin');
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'mps-admin' } as any);
    const res = await request.get(ROOT).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(403);
  });

  it('answers an empty list for a member with no sessions', async () => {
    await memberIn(gymId, 'mps-empty');
    await service(gymId, `Idle ${uniq()}`);
    const res = await asMember(gymId, 'mps-empty');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('reports total, used and remaining for a service the member holds sessions for', async () => {
    const memberId = await memberIn(gymId, 'mps-holder');
    const pt = await service(gymId, `Personal Training ${uniq()}`);
    await grant(gymId, memberId, pt, 5);
    const res = await asMember(gymId, 'mps-holder');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({ professional_service_id: pt, total: 5, used: 0, remaining: 5 }),
    ]);
  });

  it('leaves out a service the gym switched off and another member’s sessions', async () => {
    const memberId = await memberIn(gymId, 'mps-off');
    const other = await memberIn(gymId, 'mps-other');
    const off = await service(gymId, `Switched off ${uniq()}`, 'inactive');
    const on = await service(gymId, `Switched on ${uniq()}`);
    await grant(gymId, memberId, off, 3);
    await grant(gymId, other, on, 4);
    const res = await asMember(gymId, 'mps-off');
    expect(res.body.items).toEqual([]);
  });
});
