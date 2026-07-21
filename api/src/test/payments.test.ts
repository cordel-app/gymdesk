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

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Pay Member', ?)`,
    [gymId, `paymember-${Date.now()}@test.com`],
  );
  return insertId;
}

async function getChargeTypeId(code = 'membership_fee'): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM charge_types WHERE code = ?', [code]);
  return rows[0].id;
}

async function insertBillingEvent(gymId: string, memberId: number, chargeTypeId: number) {
  const { insertId } = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, event_type, charge_type_id, source, actor_user_id, amount)
     VALUES (?, ?, 'payment_recorded', ?, 'employee', 'test-user', 100)`,
    [gymId, memberId, chargeTypeId],
  );
  return insertId;
}

describe('Payments', () => {
  let gymId: string;
  let otherGymId: string;
  let memberId: number;
  let chargeTypeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Payments Gym');
    otherGymId = await createTestGym('Other Payments Gym');
    await createTestMembership(gymId);
    await createTestMembership(otherGymId);
    memberId = await createMember(gymId);
    chargeTypeId = await getChargeTypeId('membership_fee');
    await insertBillingEvent(gymId, memberId, chargeTypeId);
  });

  // ─── GET /payments ───────────────────────────────────────────────────────────

  describe('GET /payments', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request.get('/payments').set('x-gym-id', gymId);
      expect(res.status).toBe(401);
    });

    it('returns 403 for member role', async () => {
      const memberOnlyGymId = await createTestGym('Member Role Gym Pay');
      await createTestMembership(memberOnlyGymId, 'member');
      const res = await request.get('/payments').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', memberOnlyGymId);
      expect(res.status).toBe(403);
    });

    it('returns paginated list for staff', async () => {
      const res = await request.get('/payments').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(res.body).toHaveProperty('total');
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it('excludes status_changed events', async () => {
      await db.query(
        `INSERT INTO billing_events (gym_id, member_id, event_type, source, actor_user_id, previous_status, new_status)
         VALUES (?, ?, 'status_changed', 'system', 'test-user', 'pending', 'active')`,
        [gymId, memberId],
      );
      const res = await request.get('/payments').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      const hasStatusChanged = res.body.items.some((i: any) => i.event_type === 'status_changed');
      expect(hasStatusChanged).toBe(false);
    });

    it('tenant isolation: gym A events not visible with gym B token', async () => {
      const res = await request.get('/payments').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGymId);
      expect(res.status).toBe(200);
      const hasGymAItem = res.body.items.some((i: any) => i.gym_id === gymId);
      expect(hasGymAItem).toBe(false);
    });

    it('filters by member_id', async () => {
      const res = await request
        .get(`/payments?member_id=${memberId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      expect(res.body.items.every((i: any) => i.member_id === memberId)).toBe(true);
    });
  });

  // ─── POST /payments ──────────────────────────────────────────────────────────

  describe('POST /payments', () => {
    it('creates a payment_recorded event', async () => {
      const res = await request
        .post('/payments')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ event_type: 'payment_recorded', member_id: memberId, charge_type_id: chargeTypeId, amount: 50 });
      expect(res.status).toBe(201);
      expect(res.body.event_type).toBe('payment_recorded');
      expect(res.body.member_id).toBe(memberId);
    });

    it('rejects missing member', async () => {
      const res = await request
        .post('/payments')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ event_type: 'payment_recorded', charge_type_id: chargeTypeId, amount: 50 });
      expect(res.status).toBe(400);
    });

    it('rejects invalid event_type', async () => {
      const res = await request
        .post('/payments')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ event_type: 'status_changed', member_id: memberId });
      expect(res.status).toBe(400);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await request
        .post('/payments')
        .set('x-gym-id', gymId)
        .send({ event_type: 'payment_recorded', member_id: memberId, charge_type_id: chargeTypeId, amount: 10 });
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /payments/member/:memberId ──────────────────────────────────────────

  describe('GET /payments/member/:memberId', () => {
    it('returns history for a member', async () => {
      const res = await request
        .get(`/payments/member/${memberId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.every((i: any) => i.member_id === memberId)).toBe(true);
    });

    it('excludes status_changed from member history', async () => {
      const res = await request
        .get(`/payments/member/${memberId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      expect(res.body.items.every((i: any) => i.event_type !== 'status_changed')).toBe(true);
    });

    it('tenant isolation: 404 for member from another gym', async () => {
      const otherMemberId = await createMember(otherGymId);
      const res = await request
        .get(`/payments/member/${otherMemberId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(404);
    });
  });
});
