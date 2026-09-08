// Tests for staff-centers.ts router
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// ─── Shared setup helpers ─────────────────────────────────────────────────────

async function createStaff(gymId: string, overrides: Record<string, unknown> = {}): Promise<number> {
  const email = (overrides.email as string) ?? `staff-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@gym.test`;
  const { insertId } = await db.query(
    `INSERT INTO staff (gym_id, first_name, last_name, email, profile, hire_date, employment_status, current_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 'available', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [
      gymId,
      (overrides.first_name as string) ?? 'Test',
      (overrides.last_name as string) ?? 'Staff',
      email,
      (overrides.profile as string) ?? 'Personal Trainer',
      (overrides.hire_date as string) ?? '2025-01-01',
    ],
  );
  return insertId as number;
}

async function createCenter(gymId: string, overrides: { name?: string; status?: string } = {}): Promise<number> {
  const name = overrides.name ?? `Center ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { insertId } = await db.query(
    `INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)`,
    [gymId, name, overrides.status ?? 'active'],
  );
  return insertId as number;
}

async function getStaffCenterRow(staffId: number, centerId: number): Promise<{ deleted_at: string | null; is_default: number } | undefined> {
  const { rows } = await db.query<{ deleted_at: string | null; is_default: number }>(
    'SELECT deleted_at, is_default FROM staff_centers WHERE staff_id = ? AND center_id = ?',
    [staffId, centerId],
  );
  return rows[0];
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let gymA: string;
let gymB: string;
let gymC: string; // TEST_USER_ID is admin of both gymA and gymC — used for cross-tenant reachability checks.

beforeAll(async () => {
  gymA = await createTestGym('Staff Centers Gym A');
  await createTestMembership(gymA, 'admin');

  gymB = await createTestGym('Staff Centers Gym B');
  await createTestMembership(gymB, 'admin', 'other-user');

  gymC = await createTestGym('Staff Centers Gym C');
  await createTestMembership(gymC, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ─── GET /staff/:staffId/centers ───────────────────────────────────────────────

describe('GET /staff/:staffId/centers', () => {
  it('returns 401 without auth', async () => {
    const staffId = await createStaff(gymA);
    const res = await request.get(`/staff/${staffId}/centers`).set('x-gym-id', gymA);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in this gym', async () => {
    const strangerGym = await createTestGym('Staff Centers Stranger Gym');
    const staffId = await createStaff(strangerGym);
    const res = await request
      .get(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', strangerGym);
    expect(res.status).toBe(403);
  });

  it('returns 200 with an empty array for a staff member with no centers assigned', async () => {
    const staffId = await createStaff(gymA);
    const res = await request
      .get(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns assigned centers with is_default, ordered is_default DESC, name ASC', async () => {
    const staffId = await createStaff(gymA);
    const alpha = await createCenter(gymA, { name: 'Alpha Center' });
    const beta = await createCenter(gymA, { name: 'Beta Center' });
    const gamma = await createCenter(gymA, { name: 'Gamma Center' });

    await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [alpha, beta, gamma], default_center_id: gamma });

    const res = await request
      .get(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);

    expect(res.status).toBe(200);
    expect(res.body.map((c: any) => c.center_id)).toEqual([gamma, alpha, beta]);
    expect(res.body[0].is_default).toBe(1);
    expect(res.body[1].is_default).toBe(0);
    expect(res.body[2].is_default).toBe(0);
  });

  it('does not leak a gym A staff member\'s centers when queried under a different gym membership', async () => {
    const staffId = await createStaff(gymA);
    const center = await createCenter(gymA, { name: 'Isolation Center' });
    await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [center] });

    // TEST_USER_ID is a legitimate admin of gymC, but this staff row belongs to
    // gymA — the query is scoped by the caller's gym_id, so nothing leaks through.
    const res = await request
      .get(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymC);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─── PUT /staff/:staffId/centers ───────────────────────────────────────────────

describe('PUT /staff/:staffId/centers', () => {
  it('returns 401 without auth', async () => {
    const staffId = await createStaff(gymA);
    const res = await request
      .put(`/staff/${staffId}/centers`)
      .set('x-gym-id', gymA)
      .send({ center_ids: [] });
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in this gym', async () => {
    const strangerGym = await createTestGym('Staff Centers PUT Stranger Gym');
    const staffId = await createStaff(strangerGym);
    const res = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', strangerGym)
      .send({ center_ids: [] });
    expect(res.status).toBe(403);
  });

  it('returns 403 for a non-admin role', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'staff-user' } as any);
    const staffGym = await createTestGym('Staff Centers Role Gym');
    await createTestMembership(staffGym, 'front_desk', 'staff-user');
    const staffId = await createStaff(staffGym);

    const res = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGym)
      .send({ center_ids: [] });
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown staffId', async () => {
    const res = await request
      .put('/staff/9999999/centers')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [] });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a soft-deleted staff member', async () => {
    const staffId = await createStaff(gymA);
    await db.query('UPDATE staff SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [staffId]);

    const res = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [] });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the staffId belongs to a different gym than the caller\'s', async () => {
    const staffIdInB = await createStaff(gymB);

    // TEST_USER_ID is a legitimate admin of gymC, but the staff row lives in gymB.
    const res = await request
      .put(`/staff/${staffIdInB}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymC)
      .send({ center_ids: [] });
    expect(res.status).toBe(404);
  });

  it('accepts an empty center_ids array — a staff member may have zero centers', async () => {
    const staffId = await createStaff(gymA);
    const res = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('auto-assigns the sole id as default when center_ids has exactly one entry', async () => {
    const staffId = await createStaff(gymA);
    const center = await createCenter(gymA, { name: 'Solo Center' });

    const res = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [center] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ center_id: center, is_default: 1 }),
    ]);
  });

  it('returns 400 when center_ids has more than one entry and default_center_id is missing', async () => {
    const staffId = await createStaff(gymA);
    const c1 = await createCenter(gymA);
    const c2 = await createCenter(gymA);

    const res = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [c1, c2] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when default_center_id is not one of center_ids', async () => {
    const staffId = await createStaff(gymA);
    const c1 = await createCenter(gymA);
    const c2 = await createCenter(gymA);
    const outsider = await createCenter(gymA);

    const res = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [c1, c2], default_center_id: outsider });
    expect(res.status).toBe(400);
  });

  it('returns 400 when a center_id does not exist', async () => {
    const staffId = await createStaff(gymA);
    const res = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [999999] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when a center_id belongs to a different gym', async () => {
    const staffId = await createStaff(gymA);
    const foreignCenter = await createCenter(gymB, { name: 'Foreign Center' });

    const res = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [foreignCenter] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when a soft-deleted center_id is supplied', async () => {
    const staffId = await createStaff(gymA);
    const center = await createCenter(gymA, { name: 'Soon Deleted Center' });
    await db.query('UPDATE centers SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [center]);

    const res = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [center] });
    expect(res.status).toBe(400);
  });

  it('assigns multiple centers with an explicit default and returns them ordered', async () => {
    const staffId = await createStaff(gymA);
    const alpha = await createCenter(gymA, { name: 'Ordering Alpha' });
    const beta = await createCenter(gymA, { name: 'Ordering Beta' });

    const res = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [alpha, beta], default_center_id: beta });

    expect(res.status).toBe(200);
    expect(res.body.map((c: any) => c.center_id)).toEqual([beta, alpha]);
    expect(res.body[0].is_default).toBe(1);
    expect(res.body[1].is_default).toBe(0);
  });

  it('re-PUT with a different set replaces assignments — removed centers are soft-deleted, not left dangling', async () => {
    const staffId = await createStaff(gymA);
    const c1 = await createCenter(gymA, { name: 'Keep Center' });
    const c2 = await createCenter(gymA, { name: 'Drop Center' });
    const c3 = await createCenter(gymA, { name: 'New Center' });

    const first = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [c1, c2], default_center_id: c1 });
    expect(first.status).toBe(200);
    expect(first.body.map((c: any) => c.center_id).sort()).toEqual([c1, c2].sort());

    const second = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [c1, c3], default_center_id: c3 });
    expect(second.status).toBe(200);

    const getAfter = await request
      .get(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(getAfter.status).toBe(200);
    const ids = getAfter.body.map((c: any) => c.center_id);
    expect(ids).toContain(c1);
    expect(ids).toContain(c3);
    expect(ids).not.toContain(c2); // dropped from the new set — must not still appear

    // c2 must be soft-deleted in staff_centers, not deleted or left as an active row.
    const droppedRow = await getStaffCenterRow(staffId, c2);
    expect(droppedRow).toBeDefined();
    expect(droppedRow!.deleted_at).not.toBeNull();

    // c1 stays active but is no longer the default (c3 is now).
    const keptRow = await getStaffCenterRow(staffId, c1);
    expect(keptRow).toBeDefined();
    expect(keptRow!.deleted_at).toBeNull();
    expect(keptRow!.is_default).toBe(0);

    const newRow = await getStaffCenterRow(staffId, c3);
    expect(newRow).toBeDefined();
    expect(newRow!.deleted_at).toBeNull();
    expect(newRow!.is_default).toBe(1);
  });

  it('re-assigning a previously removed center (re-adding it later) revives the soft-deleted row', async () => {
    const staffId = await createStaff(gymA);
    const c1 = await createCenter(gymA, { name: 'Revive Center' });
    const c2 = await createCenter(gymA, { name: 'Other Center' });

    await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [c1] });

    // Drop c1.
    await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [c2] });

    // Re-add c1 alongside c2.
    const res = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [c1, c2], default_center_id: c1 });

    expect(res.status).toBe(200);
    expect(res.body.map((c: any) => c.center_id).sort()).toEqual([c1, c2].sort());

    const revivedRow = await getStaffCenterRow(staffId, c1);
    expect(revivedRow).toBeDefined();
    expect(revivedRow!.deleted_at).toBeNull();
    expect(revivedRow!.is_default).toBe(1);
  });

  it('clears all assignments when re-PUT with an empty center_ids array', async () => {
    const staffId = await createStaff(gymA);
    const center = await createCenter(gymA, { name: 'To Be Cleared' });

    await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [center] });

    const res = await request
      .put(`/staff/${staffId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ center_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);

    const row = await getStaffCenterRow(staffId, center);
    expect(row).toBeDefined();
    expect(row!.deleted_at).not.toBeNull();
  });
});
