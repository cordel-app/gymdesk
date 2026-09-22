// Tests for audit-logs.ts router — focused on the entity_id filter (#642)

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

async function insertAuditRow(
  gymId: string,
  entityType: string,
  entityId: number | string,
  entityName: string,
  action = 'update',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO audit_logs (gym_id, actor_user_id, actor_name, action, entity_type, entity_id, entity_name, source)
     VALUES (?, 'test-user-id', 'Test Actor', ?, ?, ?, ?, 'admin')`,
    [gymId, action, entityType, String(entityId), entityName],
  );
  return insertId as number;
}

interface AuditListResponse {
  items: { id: number; entity_type: string; entity_id: string | null; entity_name: string | null }[];
  total: number;
}

// ─── Auth and access guards ───────────────────────────────────────────────────

describe('Audit log auth', () => {
  let gymId: string;
  let gymNonAdmin: string;

  beforeAll(async () => {
    gymId = await createTestGym('Audit Auth Gym');
    await createTestMembership(gymId, 'admin');

    gymNonAdmin = await createTestGym('Audit Non Admin Gym');
    await createTestMembership(gymNonAdmin, 'front_desk');
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request.get('/audit-logs').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin role', async () => {
    const res = await request
      .get('/audit-logs')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNonAdmin);
    expect(res.status).toBe(403);
  });
});

// ─── entity_id filter (#642) ──────────────────────────────────────────────────

describe('GET /audit-logs?entity_id', () => {
  let gymId: string;
  let memberEntityId: number;
  let otherMemberEntityId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Audit Filter Gym');
    await createTestMembership(gymId, 'admin');

    memberEntityId = 4242;
    otherMemberEntityId = 9999;

    await insertAuditRow(gymId, 'member', memberEntityId, 'Ada Lovelace', 'create');
    await insertAuditRow(gymId, 'member', memberEntityId, 'Ada Lovelace', 'update');
    await insertAuditRow(gymId, 'member', otherMemberEntityId, 'Grace Hopper', 'update');
    // Same numeric id under a different entity type — must not leak into the result.
    await insertAuditRow(gymId, 'membership_plan', memberEntityId, 'Premium', 'update');
    // An id that is a prefix of memberEntityId, to prove the match is exact.
    await insertAuditRow(gymId, 'member', 42, 'Prefix Member', 'update');
  });

  it('returns only the rows for the requested entity id', async () => {
    const res = await request
      .get(`/audit-logs?entity_type=member&entity_id=${memberEntityId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    const body = res.body as AuditListResponse;
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.items.every((r) => r.entity_type === 'member')).toBe(true);
    expect(body.items.every((r) => r.entity_id === String(memberEntityId))).toBe(true);
  });

  it('matches the id exactly rather than as a substring', async () => {
    const res = await request
      .get('/audit-logs?entity_type=member&entity_id=42')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    const body = res.body as AuditListResponse;
    expect(body.total).toBe(1);
    expect(body.items[0].entity_name).toBe('Prefix Member');
  });

  it('keeps entity_id independent of entity_type', async () => {
    const res = await request
      .get(`/audit-logs?entity_id=${memberEntityId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    const body = res.body as AuditListResponse;
    // both member rows plus the membership_plan row sharing the id
    expect(body.total).toBe(3);
    expect(new Set(body.items.map((r) => r.entity_type))).toEqual(new Set(['member', 'membership_plan']));
  });

  it('is unaffected when the filter is omitted', async () => {
    const res = await request
      .get('/audit-logs?entity_type=member')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    expect((res.body as AuditListResponse).total).toBe(4);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('Audit log tenant isolation', () => {
  let gymA: string;
  let gymB: string;

  beforeAll(async () => {
    gymA = await createTestGym('Audit Isolation Gym A');
    await createTestMembership(gymA, 'admin');
    gymB = await createTestGym('Audit Isolation Gym B');
    await createTestMembership(gymB, 'admin');

    await insertAuditRow(gymB, 'member', 777, 'Gym B Member', 'update');
  });

  it('does not return another gym rows for the same entity id', async () => {
    const res = await request
      .get('/audit-logs?entity_type=member&entity_id=777')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);

    expect(res.status).toBe(200);
    const body = res.body as AuditListResponse;
    expect(body.total).toBe(0);
    expect(body.items).toHaveLength(0);
  });

  it('returns the row for its own gym', async () => {
    const res = await request
      .get('/audit-logs?entity_type=member&entity_id=777')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);

    expect(res.status).toBe(200);
    const body = res.body as AuditListResponse;
    expect(body.total).toBe(1);
    expect(body.items[0].entity_name).toBe('Gym B Member');
  });
});
