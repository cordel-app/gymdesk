// Tests for centers.ts router

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

// ─── Shared setup helpers ─────────────────────────────────────────────────────

async function createCenter(
  gymId: string,
  overrides: { name?: string; status?: string } = {},
): Promise<number> {
  const name = overrides.name ?? `Center ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { insertId } = await db.query(
    `INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)`,
    [gymId, name, overrides.status ?? 'active'],
  );
  return insertId as number;
}

async function createMember(gymId: string): Promise<number> {
  const email = `center-member-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`;
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Dependent Member', ?)`,
    [gymId, email],
  );
  return insertId as number;
}

// #436 fix: calendar_events is only a dependency for kind='session' rows
// (the materialised class-session occurrences); kind='event' rows must not block.
async function createCalendarEvent(
  gymId: string,
  centerId: number,
  kind: 'session' | 'event',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, kind, title, starts_at, ends_at)
     VALUES (?, ?, ?, 'Test Occurrence', NOW(), DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
    [gymId, centerId, kind],
  );
  return insertId as number;
}

// recordAudit() is fire-and-forget (not awaited by the router), so poll briefly
// rather than assuming the row exists the instant the HTTP response returns.
async function waitForAuditLog(
  gymId: string,
  entityType: string,
  entityId: number,
  action: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query(
      `SELECT * FROM audit_logs WHERE gym_id = ? AND entity_type = ? AND entity_id = ? AND action = ?
       ORDER BY id DESC LIMIT 1`,
      [gymId, entityType, String(entityId), action],
    );
    if (rows.length > 0) return rows[0] as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// ─── Auth and access guards ───────────────────────────────────────────────────

describe('Auth and access guards', () => {
  let gymId: string;
  let gymNoAccess: string;

  beforeAll(async () => {
    gymId = await createTestGym('Centers Auth Gym');
    await createTestMembership(gymId, 'admin');

    gymNoAccess = await createTestGym('Centers No Access Gym');
    // TEST_USER_ID has no membership in gymNoAccess
  });

  it('returns 401 without an Authorization header on GET /centers', async () => {
    const res = await request.get('/centers').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 401 without an Authorization header on POST /centers', async () => {
    const res = await request.post('/centers').set('x-gym-id', gymId).send({ name: 'X' });
    expect(res.status).toBe(401);
  });

  it('returns 403 when the user has no membership in the requested gym', async () => {
    const res = await request
      .get('/centers')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoAccess);
    expect(res.status).toBe(403);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('Tenant isolation', () => {
  let gymA: string;
  let gymB: string;
  let centerBId: number;

  beforeAll(async () => {
    gymA = await createTestGym('Centers Tenant Gym A');
    await createTestMembership(gymA, 'admin');
    gymB = await createTestGym('Centers Tenant Gym B');
    await createTestMembership(gymB, 'admin', 'other-user');
    centerBId = await createCenter(gymB, { name: 'Gym B Center' });
  });

  it('returns 403 when the user has no membership in gym B', async () => {
    // The gymB membership created above belongs to 'other-user', not TEST_USER_ID.
    const res = await request
      .get('/centers')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(403);
  });

  it('returns 404 when fetching a gym B center with gym A credentials', async () => {
    const res = await request
      .get(`/centers/${centerBId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(404);
  });

  it('does not include gym B centers in the gym A list', async () => {
    const res = await request
      .get('/centers')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(200);
    expect(res.body.map((c: any) => c.id)).not.toContain(centerBId);
  });

  it('returns 404 when deleting a gym B center with gym A credentials', async () => {
    const res = await request
      .delete(`/centers/${centerBId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(404);
  });
});

// ─── GET /centers ─────────────────────────────────────────────────────────────

describe('GET /centers', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Centers List Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 200 with an array', async () => {
    const res = await request
      .get('/centers')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns 400 for an invalid status filter', async () => {
    const res = await request
      .get('/centers?status=bogus')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('filters by status', async () => {
    const activeId = await createCenter(gymId, { status: 'active' });
    const inactiveId = await createCenter(gymId, { status: 'inactive' });

    const res = await request
      .get('/centers?status=inactive')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((c: any) => c.id);
    expect(ids).toContain(inactiveId);
    expect(ids).not.toContain(activeId);
  });

  it('does not include soft-deleted centers', async () => {
    const centerId = await createCenter(gymId);
    await db.query('UPDATE centers SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [centerId]);
    const res = await request
      .get('/centers')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.map((c: any) => c.id)).not.toContain(centerId);
  });
});

// ─── GET /centers/:id ─────────────────────────────────────────────────────────

describe('GET /centers/:id', () => {
  let gymId: string;
  let centerId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Centers Detail Gym');
    await createTestMembership(gymId, 'admin');
    centerId = await createCenter(gymId, { name: 'Detail Center' });
  });

  it('returns 200 with the center record', async () => {
    const res = await request
      .get(`/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(centerId);
    expect(res.body.name).toBe('Detail Center');
  });

  it('returns 404 for a non-existent center', async () => {
    const res = await request
      .get('/centers/999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a soft-deleted center', async () => {
    const deletedId = await createCenter(gymId, { name: 'Soon Deleted Center' });
    await db.query('UPDATE centers SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [deletedId]);
    const res = await request
      .get(`/centers/${deletedId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── POST /centers ────────────────────────────────────────────────────────────

describe('POST /centers', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Centers Create Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('creates a center and returns 201', async () => {
    const res = await request
      .post('/centers')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'New Center', code: 'NC1', phone: '+34600000000' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('New Center');
    expect(res.body.code).toBe('NC1');
    expect(res.body.status).toBe('active');
    expect(res.body.gym_id).toBe(gymId);

    const auditRow = await waitForAuditLog(gymId, 'center', res.body.id, 'create');
    expect(auditRow).not.toBeNull();
  });

  it('returns 400 when name is missing', async () => {
    const res = await request
      .post('/centers')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ code: 'NOP' });
    expect(res.status).toBe(400);
  });

  it('returns 409 on a duplicate name', async () => {
    await request
      .post('/centers')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Dup Center' });
    const res = await request
      .post('/centers')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Dup Center' });
    expect(res.status).toBe(409);
  });

  it('returns 403 for a non-admin role', async () => {
    const staffGymId = await createTestGym('Centers Create Staff Gym');
    await createTestMembership(staffGymId, 'front_desk');
    const res = await request
      .post('/centers')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGymId)
      .send({ name: 'Should Not Create' });
    expect(res.status).toBe(403);
  });
});

// ─── PUT /centers/:id ─────────────────────────────────────────────────────────

describe('PUT /centers/:id', () => {
  let gymId: string;
  let centerId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Centers Update Gym');
    await createTestMembership(gymId, 'admin');
    centerId = await createCenter(gymId, { name: 'Update Me Center' });
  });

  it('updates fields and returns the updated center', async () => {
    const res = await request
      .put(`/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Updated Center Name', phone: '+34611111111', status: 'inactive' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Center Name');
    expect(res.body.phone).toBe('+34611111111');
    expect(res.body.status).toBe('inactive');
  });

  it('returns 400 for an invalid theme_id', async () => {
    const res = await request
      .put(`/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ theme_id: 'not-a-real-theme-id' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent center', async () => {
    const res = await request
      .put('/centers/999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('returns 403 for a non-admin role', async () => {
    const staffGymId = await createTestGym('Centers Update Staff Gym');
    await createTestMembership(staffGymId, 'front_desk');
    const otherCenterId = await createCenter(staffGymId);
    const res = await request
      .put(`/centers/${otherCenterId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGymId)
      .send({ name: 'Should Not Update' });
    expect(res.status).toBe(403);
  });
});

// ─── DELETE /centers/:id — #436 regression: dependency check, soft-delete, recycle-bin ──

describe('DELETE /centers/:id', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Centers Delete Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 403 for a non-admin role', async () => {
    const staffGymId = await createTestGym('Centers Delete Staff Gym');
    await createTestMembership(staffGymId, 'front_desk');
    const otherCenterId = await createCenter(staffGymId);
    const res = await request
      .delete(`/centers/${otherCenterId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGymId);
    expect(res.status).toBe(403);
  });

  it('returns 204, soft-deletes the center, and sets the deleted_by fields', async () => {
    const centerId = await createCenter(gymId);
    const res = await request
      .delete(`/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);

    const { rows } = await db.query<{
      deleted_at: string | null;
      deleted_by_membership_id: number | null;
      deleted_by_name: string | null;
    }>(
      'SELECT deleted_at, deleted_by_membership_id, deleted_by_name FROM centers WHERE id = ?',
      [centerId],
    );
    expect(rows[0].deleted_at).not.toBeNull();
    expect(rows[0].deleted_by_membership_id).not.toBeNull();
    expect(rows[0]).toHaveProperty('deleted_by_name');
  });

  it('records a soft_delete audit_logs row', async () => {
    const centerId = await createCenter(gymId);
    const del = await request
      .delete(`/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(del.status).toBe(204);

    const auditRow = await waitForAuditLog(gymId, 'center', centerId, 'soft_delete');
    expect(auditRow).not.toBeNull();
  });

  it('deleted center no longer appears in GET /centers or GET /centers/:id', async () => {
    const centerId = await createCenter(gymId);
    await request
      .delete(`/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const list = await request
      .get('/centers')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list.status).toBe(200);
    expect(list.body.map((c: any) => c.id)).not.toContain(centerId);

    const single = await request
      .get(`/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(single.status).toBe(404);
  });

  it('returns 404 when deleting an already-deleted center', async () => {
    const centerId = await createCenter(gymId);
    await request
      .delete(`/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const res = await request
      .delete(`/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('appears in GET /recycle-bin and is restorable via the recover endpoint', async () => {
    const centerId = await createCenter(gymId, { name: 'Recyclable Center' });
    const del = await request
      .delete(`/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(del.status).toBe(204);

    const bin = await request
      .get('/recycle-bin?entity_type=center')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(bin.status).toBe(200);
    const item = bin.body.items.find((i: any) => i.entity_type === 'center' && i.id === centerId);
    expect(item).toBeDefined();
    expect(item.name).toBe('Recyclable Center');

    const recover = await request
      .post(`/recycle-bin/center/${centerId}/recover`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(recover.status).toBe(204);

    const { rows } = await db.query<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM centers WHERE id = ?',
      [centerId],
    );
    expect(rows[0].deleted_at).toBeNull();

    const single = await request
      .get(`/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(single.status).toBe(200);
  });

  // #436: firstDependentTable used to query the dropped `events` table and the
  // defunct class_sessions/bookings tables, so this always crashed with a 500.
  it('returns 409 "it still has member centers" when a member_centers row references the center', async () => {
    const centerId = await createCenter(gymId);
    const memberId = await createMember(gymId);
    await db.query(
      `INSERT INTO member_centers (gym_id, member_id, center_id, is_default) VALUES (?, ?, ?, 1)`,
      [gymId, memberId, centerId],
    );

    const res = await request
      .delete(`/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot delete center: it still has member centers.');

    const { rows } = await db.query<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM centers WHERE id = ?',
      [centerId],
    );
    expect(rows[0].deleted_at).toBeNull();
  });

  it('returns 409 "it still has class sessions" when a calendar_events row with kind=session references the center', async () => {
    const centerId = await createCenter(gymId);
    await createCalendarEvent(gymId, centerId, 'session');

    const res = await request
      .delete(`/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot delete center: it still has class sessions.');
  });

  it('does not block deletion when the only calendar_events row is kind=event', async () => {
    const centerId = await createCenter(gymId);
    await createCalendarEvent(gymId, centerId, 'event');

    const res = await request
      .delete(`/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });
});
