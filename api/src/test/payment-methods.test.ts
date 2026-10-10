// Tests for payment-methods.ts router

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request, seedScheduledEvent } from './helpers';

// #788: the card-replacement flow talks to the provider through
// createCardVerificationRequest(), which takes no amount at all — the row's own
// `amount` is 0.00 only because the column is NOT NULL. Mock the provider so no
// real HTTP reaches Monei, and so the stub can be inspected for what it was (and
// was not) handed.
const createCardVerificationRequest = vi.fn().mockResolvedValue({
  providerOrderId: 'monei-verif-1',
});

vi.mock('../payments', () => ({
  getPaymentProvider: () => ({ createCardVerificationRequest }),
}));

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ─── Local setup helpers ─────────────────────────────────────────────────────

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function createMember(gymId: string, name = 'PM Test Member'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
    [gymId, name, `pm-${uniq()}@test.com`],
  );
  return insertId;
}

async function createMembershipPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `PM-Plan-${uniq()}`],
  );
  return insertId;
}

/**
 * An assignment. `nextBillingDate` is what makes it *billable* for
 * cardRemovalBlock() — an `active` row with no next billing date blocks nothing.
 */
async function createUserMembership(
  gymId: string,
  memberId: number,
  status: 'active' | 'paused' | 'cancelled' | 'expired' = 'active',
  nextBillingDate: string | null = null,
): Promise<number> {
  const planId = await createMembershipPlan(gymId);
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, ?, CURDATE(), '29.99')`,
    [gymId, memberId, planId, status],
  );
  // #1325 PR 3c: "scheduled to be charged" is a scheduled event of the member's set.
  if (nextBillingDate) await seedScheduledEvent(gymId, memberId, insertId, nextBillingDate);
  return insertId;
}

async function storeCard(
  gymId: string,
  memberId: number,
  opts: { brand?: string; last4?: string; updatedAt?: string | null } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO payment_methods
       (gym_id, member_id, provider, payment_token, sequence_id, card_brand, card_last4, updated_at)
     VALUES (?, ?, 'monei', 'tok-secret-123', 'seq-secret-456', ?, ?, ?)`,
    [gymId, memberId, opts.brand ?? 'visa', opts.last4 ?? '4242', opts.updatedAt ?? null],
  );
}

// ─── Auth, tenant and module-access guards ───────────────────────────────────

describe('Auth and access guards', () => {
  let gymId: string;
  let gymNoAccess: string;
  let gymReadOnly: string;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PM Auth Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
    await createUserMembership(gymId, memberId);

    // trainer_performance has NONE access to the PAYMENTS module.
    gymNoAccess = await createTestGym('PM No Access Gym');
    await createTestMembership(gymNoAccess, 'trainer_performance');

    // accountant has R (read-only) access to PAYMENTS — GET yes, POST no.
    gymReadOnly = await createTestGym('PM Read Only Gym');
    await createTestMembership(gymReadOnly, 'accountant');
  });

  it('returns 401 without an Authorization header (GET)', async () => {
    const res = await request.get(`/payment-methods?member_id=${memberId}`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 401 without an Authorization header (POST)', async () => {
    const res = await request
      .post('/payment-methods/replace-requests')
      .set('x-gym-id', gymId)
      .send({ member_id: memberId });
    expect(res.status).toBe(401);
  });

  it('returns 403 when the user has no membership in the requested gym', async () => {
    const otherGym = await createTestGym('PM Tenant Guard Gym');
    const res = await request
      .get(`/payment-methods?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGym);
    expect(res.status).toBe(403);
  });

  it('returns 403 when the role has NONE access to PAYMENTS (trainer_performance)', async () => {
    const res = await request
      .get(`/payment-methods?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoAccess);
    expect(res.status).toBe(403);
  });

  it('lets a read-only PAYMENTS role (accountant) read the card on file', async () => {
    const roMemberId = await createMember(gymReadOnly);
    const res = await request
      .get(`/payment-methods?member_id=${roMemberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymReadOnly);
    expect(res.status).toBe(200);
  });

  it('returns 403 on POST /replace-requests for a read-only PAYMENTS role (accountant)', async () => {
    const roMemberId = await createMember(gymReadOnly);
    await createUserMembership(gymReadOnly, roMemberId);
    const res = await request
      .post('/payment-methods/replace-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymReadOnly)
      .send({ member_id: roMemberId });
    expect(res.status).toBe(403);

    const { rows } = await db.query(
      'SELECT id FROM payment_requests WHERE member_id = ?', [roMemberId],
    );
    expect(rows).toEqual([]);
  });
});

// ─── GET /payment-methods ────────────────────────────────────────────────────

describe('GET /payment-methods', () => {
  let gymId: string;
  let otherGymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('PM Read Gym');
    otherGymId = await createTestGym('PM Read Other Gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');
  });

  it('returns 400 when member_id is missing', async () => {
    const res = await request
      .get('/payment-methods')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('returns 400 when member_id is not a positive integer', async () => {
    for (const bad of ['abc', '0', '-3', '1.5']) {
      const res = await request
        .get(`/payment-methods?member_id=${bad}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status, `member_id=${bad}`).toBe(400);
    }
  });

  it('returns 404 for a member id that does not exist', async () => {
    const res = await request
      .get('/payment-methods?member_id=999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('tenant isolation: returns 404 for a member of another gym', async () => {
    const foreignMemberId = await createMember(otherGymId, 'PM Foreign Member');
    await storeCard(otherGymId, foreignMemberId, { last4: '9999' });

    const res = await request
      .get(`/payment-methods?member_id=${foreignMemberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('9999');
  });

  it('returns 404 for a soft-deleted member', async () => {
    const memberId = await createMember(gymId);
    await db.query('UPDATE members SET deleted_at = NOW() WHERE id = ?', [memberId]);
    const res = await request
      .get(`/payment-methods?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns a null payment_method when no card is stored', async () => {
    const memberId = await createMember(gymId);
    const res = await request
      .get(`/payment-methods?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.payment_method).toBeNull();
    expect(res.body.member_can_remove).toBe(false);
    expect(res.body.removal_blocked_reason).toBeNull();
  });

  it('returns the stored card without the token that can charge it', async () => {
    const memberId = await createMember(gymId);
    await storeCard(gymId, memberId, { brand: 'mastercard', last4: '1234' });

    const res = await request
      .get(`/payment-methods?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.payment_method).toMatchObject({
      provider: 'monei',
      card_brand: 'mastercard',
      card_last4: '1234',
    });
    expect(res.body.payment_method).toHaveProperty('since');

    // The credentials must never cross the wire, by key or by value.
    expect(Object.keys(res.body.payment_method).sort())
      .toEqual(['card_brand', 'card_last4', 'provider', 'since']);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('payment_token');
    expect(body).not.toContain('sequence_id');
    expect(body).not.toContain('tok-secret-123');
    expect(body).not.toContain('seq-secret-456');
  });

  it('since is COALESCE(updated_at, created_at) — the last upsert wins', async () => {
    const replacedId = await createMember(gymId);
    await storeCard(gymId, replacedId, { updatedAt: '2031-02-03 04:05:06' });
    await db.query(
      "UPDATE payment_methods SET created_at = '2020-01-01 00:00:00' WHERE member_id = ?",
      [replacedId],
    );

    const replaced = await request
      .get(`/payment-methods?member_id=${replacedId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(replaced.status).toBe(200);
    expect(String(replaced.body.payment_method.since)).toContain('2031-02-03');

    // Never replaced: the row's own age is what the card on file dates from.
    const originalId = await createMember(gymId);
    await storeCard(gymId, originalId, { updatedAt: null });
    await db.query(
      "UPDATE payment_methods SET created_at = '2021-06-07 08:09:10' WHERE member_id = ?",
      [originalId],
    );

    const original = await request
      .get(`/payment-methods?member_id=${originalId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(original.status).toBe(200);
    expect(String(original.body.payment_method.since)).toContain('2021-06-07');
  });

  it('allows removal when a card is stored and nothing is scheduled to be charged', async () => {
    const memberId = await createMember(gymId);
    await storeCard(gymId, memberId);
    // A cancelled assignment (its version's future events were replaced), and
    // an active one with nothing scheduled: nothing blocks removal.
    await createUserMembership(gymId, memberId, 'cancelled', null);
    await createUserMembership(gymId, memberId, 'active', null);

    const res = await request
      .get(`/payment-methods?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.payment_method).not.toBeNull();
    expect(res.body.removal_blocked_reason).toBeNull();
    expect(res.body.member_can_remove).toBe(true);
  });

  it("blocks removal with 'billable_membership' for an active assignment with a next billing date", async () => {
    const memberId = await createMember(gymId);
    await storeCard(gymId, memberId);
    await createUserMembership(gymId, memberId, 'active', '2099-03-01');

    const res = await request
      .get(`/payment-methods?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.removal_blocked_reason).toBe('billable_membership');
    expect(res.body.member_can_remove).toBe(false);
  });

  it("blocks removal for a paused assignment too — a resumed one gets billed", async () => {
    const memberId = await createMember(gymId);
    await storeCard(gymId, memberId);
    await createUserMembership(gymId, memberId, 'paused', '2099-04-01');

    const res = await request
      .get(`/payment-methods?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.removal_blocked_reason).toBe('billable_membership');
    expect(res.body.member_can_remove).toBe(false);
  });

  it('reports no block when there is no card to remove, billable membership or not', async () => {
    const memberId = await createMember(gymId);
    await createUserMembership(gymId, memberId, 'active', '2099-05-01');

    const res = await request
      .get(`/payment-methods?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.payment_method).toBeNull();
    expect(res.body.removal_blocked_reason).toBeNull();
    expect(res.body.member_can_remove).toBe(false);
  });

  it('tenant isolation: a card stored for the same member id in another gym is not read', async () => {
    // Two gyms, two different members; the block/card lookup is gym-scoped.
    const mineId = await createMember(gymId, 'PM Scoped Member');
    const theirsId = await createMember(otherGymId, 'PM Scoped Other');
    await storeCard(otherGymId, theirsId, { last4: '7777' });

    const res = await request
      .get(`/payment-methods?member_id=${mineId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.payment_method).toBeNull();
  });
});

// ─── POST /payment-methods/replace-requests ──────────────────────────────────

describe('POST /payment-methods/replace-requests', () => {
  let gymId: string;
  let otherGymId: string;
  let memberId: number;
  let userMembershipId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PM Replace Gym');
    otherGymId = await createTestGym('PM Replace Other Gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');

    memberId = await createMember(gymId);
    userMembershipId = await createUserMembership(gymId, memberId, 'active', '2099-06-01');
  });

  it('returns 400 when member_id is missing or invalid', async () => {
    for (const body of [{}, { member_id: 'abc' }, { member_id: 0 }, { member_id: -1 }]) {
      const res = await request
        .post('/payment-methods/replace-requests')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('returns 404 for a member id that does not exist', async () => {
    const res = await request
      .post('/payment-methods/replace-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: 999999 });
    expect(res.status).toBe(404);
  });

  it("tenant isolation: returns 404 for another gym's member", async () => {
    const res = await request
      .post('/payment-methods/replace-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId)
      .send({ member_id: memberId });
    expect(res.status).toBe(404);

    const { rows } = await db.query(
      "SELECT id FROM payment_requests WHERE member_id = ? AND gym_id = ?",
      [memberId, otherGymId],
    );
    expect(rows).toEqual([]);
  });

  it('returns 400 when the member has no membership to store a card for', async () => {
    const orphanId = await createMember(gymId, 'PM No Membership');
    const res = await request
      .post('/payment-methods/replace-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: orphanId });
    expect(res.status).toBe(400);

    const { rows } = await db.query('SELECT id FROM payment_requests WHERE member_id = ?', [orphanId]);
    expect(rows).toEqual([]);
  });

  it('returns 201 with id and checkoutUrl and writes a non-charging card_update row', async () => {
    const res = await request
      .post('/payment-methods/replace-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId });
    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe('number');
    expect(typeof res.body.checkoutUrl).toBe('string');
    expect(res.body.checkoutUrl).toContain('/checkout?token=');

    const { rows } = await db.query<{
      gym_id: string;
      member_id: number;
      user_membership_id: number;
      source: string;
      amount: string;
      charge_type_id: number | null;
      consent_given_at: Date | null;
      initiated_by: string | null;
      page_token: string | null;
      status: string;
      provider_ref: string | null;
    }>(
      `SELECT gym_id, member_id, user_membership_id, source, amount, charge_type_id,
              consent_given_at, initiated_by, page_token, status, provider_ref
         FROM payment_requests WHERE id = ?`,
      [res.body.id],
    );
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.gym_id).toBe(gymId);
    expect(row.member_id).toBe(memberId);
    expect(row.user_membership_id).toBe(userMembershipId);
    expect(row.source).toBe('card_update');
    // Nothing is charged: a verification bills nothing, and `charge_type_id` is
    // NULL because no charge type honestly describes it (migration 195).
    expect(Number(row.amount)).toBe(0);
    expect(row.charge_type_id).toBeNull();
    // The staff sending the link does not consent on the member's behalf.
    expect(row.consent_given_at).toBeNull();
    expect(row.initiated_by).toBe(TEST_USER_ID);
    expect(row.page_token).toBeTruthy();
    expect(res.body.checkoutUrl).toContain(row.page_token!);
    expect(row.status).toBe('pending');
    expect(row.provider_ref).toBe('monei-verif-1');
  });

  it('asks the provider for a verification, with no amount anywhere in the call', async () => {
    createCardVerificationRequest.mockClear();
    // The return URLs are environment configuration and are unset in the test
    // env, where withPurposeParam() deliberately leaves them empty ("no
    // redirect configured"). Set them so the tagging branch is exercised.
    const prevOk = process.env.PAYMENT_OK_URL;
    const prevKo = process.env.PAYMENT_KO_URL;
    process.env.PAYMENT_OK_URL = 'https://member.test/payment/return?x=1';
    process.env.PAYMENT_KO_URL = 'https://member.test/payment/return#failed';

    try {
      const res = await request
        .post('/payment-methods/replace-requests')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ member_id: memberId });
      expect(res.status).toBe(201);

      expect(createCardVerificationRequest).toHaveBeenCalledTimes(1);
      const arg = createCardVerificationRequest.mock.calls[0][0];
      // No amount reaches the provider — a verification cannot charge however
      // this path is called.
      expect(arg).not.toHaveProperty('amount');
      expect(Object.keys(arg)).not.toContain('amount');
      expect(arg.currency).toBe('EUR');
      // The member app's return page has to tell a replaced card from a paid fee.
      expect(arg.okUrl).toBe('https://member.test/payment/return?x=1&purpose=card_update');
      expect(arg.koUrl).toBe('https://member.test/payment/return?purpose=card_update#failed');
    } finally {
      if (prevOk === undefined) delete process.env.PAYMENT_OK_URL;
      else process.env.PAYMENT_OK_URL = prevOk;
      if (prevKo === undefined) delete process.env.PAYMENT_KO_URL;
      else process.env.PAYMENT_KO_URL = prevKo;
    }
  });

  it('can be raised for a member whose only assignment is cancelled', async () => {
    const lapsedId = await createMember(gymId, 'PM Lapsed Member');
    await createUserMembership(gymId, lapsedId, 'cancelled', null);

    const res = await request
      .post('/payment-methods/replace-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: lapsedId });
    expect(res.status).toBe(201);
  });

  it('prefers the active assignment when the member has several', async () => {
    const multiId = await createMember(gymId, 'PM Multi Member');
    await createUserMembership(gymId, multiId, 'expired', null);
    const activeId = await createUserMembership(gymId, multiId, 'active', '2099-07-01');

    const res = await request
      .post('/payment-methods/replace-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: multiId });
    expect(res.status).toBe(201);

    const { rows } = await db.query<{ user_membership_id: number }>(
      'SELECT user_membership_id FROM payment_requests WHERE id = ?', [res.body.id],
    );
    expect(rows[0].user_membership_id).toBe(activeId);
  });

  // The exclusion is part of #788: a card replacement must never read as a
  // payment on any financial surface.
  it('does not appear in GET /payment-requests for the member', async () => {
    const listedId = await createMember(gymId, 'PM Excluded Member');
    await createUserMembership(gymId, listedId, 'active', '2099-08-01');

    const created = await request
      .post('/payment-methods/replace-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: listedId });
    expect(created.status).toBe(201);

    const list = await request
      .get(`/payment-requests?member_id=${listedId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.some((pr: any) => pr.id === created.body.id)).toBe(false);
    expect(list.body.some((pr: any) => pr.source === 'card_update')).toBe(false);

    // The row exists — it is the list that excludes it, not the write that failed.
    const { rows } = await db.query<{ source: string }>(
      'SELECT source FROM payment_requests WHERE id = ?', [created.body.id],
    );
    expect(rows[0].source).toBe('card_update');
  });
});
