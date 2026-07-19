import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
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
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Test Member', ?)`,
    [gymId, `member-${Date.now()}@test.com`],
  );
  return insertId;
}

async function getChargeTypeId(code = 'membership_fee'): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM charge_types WHERE code = ?', [code]);
  return rows[0].id;
}

describe('Billing Events', () => {
  let gymId: string;
  let otherGymId: string;
  let memberId: number;
  let chargeTypeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Billing Gym');
    otherGymId = await createTestGym('Other Gym');
    await createTestMembership(gymId);
    await createTestMembership(otherGymId);

    memberId = await createMember(gymId);
    chargeTypeId = await getChargeTypeId('membership_fee');
  });

  describe('GET /billing-events', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request.get('/billing-events').set('x-gym-id', gymId);
      expect(res.status).toBe(401);
    });

    it('returns 403 for member role', async () => {
      // Use a separate gym where TEST_USER_ID has the 'member' role
      const memberOnlyGymId = await createTestGym('Member Role Gym');
      await createTestMembership(memberOnlyGymId, 'member');
      const res = await request
        .get('/billing-events')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', memberOnlyGymId);
      expect(res.status).toBe(403);
    });

    it('returns paginated list for staff', async () => {
      const res = await request
        .get('/billing-events')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('limit');
      expect(res.body).toHaveProperty('offset');
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it('filters by member_id', async () => {
      const res = await request
        .get(`/billing-events?member_id=${memberId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      res.body.items.forEach((item: any) => {
        expect(item.member_id).toBe(memberId);
      });
    });
  });

  describe('POST /billing-events', () => {
    it('creates a payment_recorded event', async () => {
      const res = await request
        .post('/billing-events')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({
          event_type: 'payment_recorded',
          member_id: memberId,
          charge_type_id: chargeTypeId,
          amount: 50.0,
          notes: 'Monthly fee',
        });
      expect(res.status).toBe(201);
      expect(res.body.event_type).toBe('payment_recorded');
      expect(res.body.member_id).toBe(memberId);
      expect(parseFloat(res.body.amount)).toBe(50.0);
      expect(res.body.actor_user_id).toBe(TEST_USER_ID);
    });

    it('creates an adjustment event', async () => {
      const res = await request
        .post('/billing-events')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({
          event_type: 'adjustment',
          member_id: memberId,
          charge_type_id: chargeTypeId,
          amount: -10.0,
          notes: 'Discount applied',
        });
      expect(res.status).toBe(201);
      expect(res.body.event_type).toBe('adjustment');
    });

    it('rejects status_changed event (system-only)', async () => {
      const res = await request
        .post('/billing-events')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({
          event_type: 'status_changed',
          member_id: memberId,
          amount: 0,
        });
      expect(res.status).toBe(400);
    });

    it('rejects payment_recorded without amount', async () => {
      const res = await request
        .post('/billing-events')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({
          event_type: 'payment_recorded',
          member_id: memberId,
          charge_type_id: chargeTypeId,
        });
      expect(res.status).toBe(400);
    });

    it('rejects when neither member_id nor user_membership_id provided', async () => {
      const res = await request
        .post('/billing-events')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({
          event_type: 'payment_recorded',
          charge_type_id: chargeTypeId,
          amount: 50,
        });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /billing-events/member/:memberId', () => {
    beforeAll(async () => {
      // Insert a known event for this member
      await db.query(
        `INSERT INTO billing_events (gym_id, member_id, event_type, source, actor_user_id, amount)
         VALUES (?, ?, 'payment_recorded', 'admin', ?, 25.00)`,
        [gymId, memberId, TEST_USER_ID],
      );
    });

    it('returns member history', async () => {
      const res = await request
        .get(`/billing-events/member/${memberId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(res.body.items.length).toBeGreaterThan(0);
      res.body.items.forEach((item: any) => {
        expect(item.member_id).toBe(memberId);
      });
    });

    it('returns 404 for unknown member', async () => {
      const res = await request
        .get('/billing-events/member/999999')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(404);
    });
  });

  describe('Tenant isolation', () => {
    it('GET /billing-events does not leak events across gyms', async () => {
      // Insert an event in gymId
      await db.query(
        `INSERT INTO billing_events (gym_id, member_id, event_type, source, actor_user_id, amount)
         VALUES (?, ?, 'adjustment', 'admin', ?, 5.00)`,
        [gymId, memberId, TEST_USER_ID],
      );

      // Query with otherGymId — should get 0 items from gymId
      const res = await request
        .get('/billing-events')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', otherGymId);
      expect(res.status).toBe(200);
      const ids = res.body.items.map((i: any) => i.gym_id);
      expect(ids.every((id: string) => id === otherGymId)).toBe(true);
    });

    it('GET /billing-events/member/:memberId returns 404 for member from another gym', async () => {
      const res = await request
        .get(`/billing-events/member/${memberId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', otherGymId);
      expect(res.status).toBe(404);
    });

    it('POST /billing-events returns 404 when member belongs to a different gym', async () => {
      const res = await request
        .post('/billing-events')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', otherGymId)
        .send({
          event_type: 'payment_recorded',
          member_id: memberId,
          charge_type_id: chargeTypeId,
          amount: 50,
        });
      expect(res.status).toBe(404);
    });
  });
});
