// #788: the member's own stored card — read it, replace it without being
// charged, remove it once nothing is scheduled to be charged any more.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// A card replacement asks the provider for a zero-amount verification. The stub
// takes no amount at all — `createCardVerificationRequest` has no such
// parameter — which is the invariant that keeps this path from ever charging.
const createCardVerificationRequest = vi.fn();
vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({ createCardVerificationRequest }),
}));

let gymId: string;
let otherGymId: string;
let memberId: number;
let otherMemberId: number;
let planId: number;
let membershipId: number;

async function insertMember(gid: string, name: string, clerkUserId: string | null): Promise<number> {
  const email = `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)`,
    [gid, name, email, clerkUserId],
  );
  return insertId;
}

async function storeCard(gid: string, mid: number, token = 'tok_member', last4 = '4242') {
  await db.query(
    `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id, card_last4, card_brand)
     VALUES (?, ?, 'monei', ?, 'seq_member', ?, 'visa')
     ON DUPLICATE KEY UPDATE payment_token = VALUES(payment_token), card_last4 = VALUES(card_last4)`,
    [gid, mid, token, last4],
  );
}

async function clearCards() {
  await db.query('DELETE FROM payment_methods WHERE gym_id IN (?, ?)', [gymId, otherGymId]);
}

beforeAll(async () => {
  gymId = await createTestGym('Me Payment Method Gym');
  otherGymId = await createTestGym('Me Payment Method Other Gym');

  // Every route here is requireRole('member') — an exact role check.
  await createTestMembership(gymId, 'member');
  // The same login is an admin of the other gym, which is how the 403 below is
  // reached without inventing a second Clerk user.
  await createTestMembership(otherGymId, 'admin');

  // clerk_user_id is globally unique in `members`, so a row left behind by a
  // crashed run has to be adopted rather than inserted around.
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id)
     VALUES (?, 'Card Member', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, `card-owner-${Date.now()}@test.com`, TEST_USER_ID],
  );
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM members WHERE clerk_user_id = ?',
    [TEST_USER_ID],
  );
  memberId = rows[0].id;

  otherMemberId = await insertMember(gymId, 'Someone Else', null);

  const { insertId: pid } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `Card-Plan-${Date.now()}`],
  );
  planId = pid;

  const { insertId: umId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price, next_billing_date)
     VALUES (?, ?, ?, 'active', CURDATE(), '0.00', DATE_ADD(CURDATE(), INTERVAL 1 MONTH))`,
    [gymId, memberId, planId],
  );
  membershipId = umId;
});

beforeEach(async () => {
  createCardVerificationRequest.mockReset();
  createCardVerificationRequest.mockResolvedValue({ providerOrderId: 'monei-verif-1' });
  await db.query(
    `UPDATE user_memberships SET status = 'active', next_billing_date = DATE_ADD(CURDATE(), INTERVAL 1 MONTH) WHERE id = ?`,
    [membershipId],
  );
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/payment-method', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/me/payment-method').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a caller who is not a member of the gym', async () => {
    const res = await request
      .get('/me/payment-method')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(403);
  });

  it('reports no card when none is stored', async () => {
    await clearCards();
    const res = await request
      .get('/me/payment-method')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      payment_method: null,
      can_remove: false,
      // Reported only when there is a card to remove, so the member app never
      // explains why they cannot remove something they do not have.
      removal_blocked_reason: null,
    });
  });

  it('returns the card without the token that charges it', async () => {
    await clearCards();
    await storeCard(gymId, memberId, 'tok_secret', '4242');

    const res = await request
      .get('/me/payment-method')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.payment_method).toMatchObject({
      provider: 'monei', card_brand: 'visa', card_last4: '4242',
    });
    expect(JSON.stringify(res.body)).not.toContain('tok_secret');
    expect(JSON.stringify(res.body)).not.toContain('seq_member');
  });

  it('refuses removal while a membership is still scheduled to be charged', async () => {
    await clearCards();
    await storeCard(gymId, memberId);

    const res = await request
      .get('/me/payment-method')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.body.can_remove).toBe(false);
    expect(res.body.removal_blocked_reason).toBe('billable_membership');
  });

  it('allows removal once the membership is cancelled', async () => {
    await clearCards();
    await storeCard(gymId, memberId);
    await db.query(`UPDATE user_memberships SET status = 'cancelled' WHERE id = ?`, [membershipId]);

    const res = await request
      .get('/me/payment-method')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.body.can_remove).toBe(true);
    expect(res.body.removal_blocked_reason).toBeNull();
  });

  it('does not read another member’s card', async () => {
    await clearCards();
    await storeCard(gymId, otherMemberId, 'tok_other', '1111');

    const res = await request
      .get('/me/payment-method')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.body.payment_method).toBeNull();
  });
});

describe('POST /me/payment-method/replace-requests', () => {
  it('returns 401 without auth', async () => {
    const res = await request.post('/me/payment-method/replace-requests').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('creates a verification request that charges nothing', async () => {
    const res = await request
      .post('/me/payment-method/replace-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.checkoutUrl).toContain('/checkout?token=');
    expect(createCardVerificationRequest).toHaveBeenCalledTimes(1);

    // The provider was asked for a verification, and there is no amount to pass
    // one — #773's minor-units rule has nothing to get wrong here by design.
    const params = createCardVerificationRequest.mock.calls[0][0];
    expect(params).not.toHaveProperty('amount');
    expect(params.currency).toBe('EUR');
    // The return URL tells the member app's payment page which flow came back.
    expect(params.okUrl === '' || params.okUrl.includes('purpose=card_update')).toBe(true);

    const { rows } = await db.query<{
      source: string; amount: string; charge_type_id: number | null;
      consent_given_at: Date | null; initiated_by: string | null; status: string;
      page_token: string | null; user_membership_id: number;
    }>(
      'SELECT source, amount, charge_type_id, consent_given_at, initiated_by, status, page_token, user_membership_id FROM payment_requests WHERE id = ?',
      [res.body.id],
    );
    expect(rows[0].source).toBe('card_update');
    expect(Number(rows[0].amount)).toBe(0);
    expect(rows[0].charge_type_id).toBeNull();
    expect(rows[0].status).toBe('pending');
    expect(rows[0].page_token).not.toBeNull();
    // The member went through the consent themselves, and no staff member did.
    expect(rows[0].consent_given_at).not.toBeNull();
    expect(rows[0].initiated_by).toBeNull();
    expect(rows[0].user_membership_id).toBe(membershipId);
  });

  it('is available while the current cycle owes nothing', async () => {
    // The old way to store a card was the Start payment button, which only
    // appears when the cycle owes a fee — so a free month, a Promotion or a
    // Free Period made updating a card impossible. This must not depend on it.
    await db.query(
      'UPDATE user_memberships SET free_periods = 12, paid_periods = 12 WHERE id = ?',
      [membershipId],
    );
    const res = await request
      .post('/me/payment-method/replace-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    await db.query(
      'UPDATE user_memberships SET free_periods = NULL, paid_periods = NULL WHERE id = ?',
      [membershipId],
    );
  });

  it('keeps the verification out of the member’s payment history', async () => {
    const created = await request
      .post('/me/payment-method/replace-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(created.status).toBe(201);

    const history = await request
      .get('/me/payment-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(history.status).toBe(200);
    expect(history.body.map((r: { id: number }) => r.id)).not.toContain(created.body.id);
    expect(history.body.every((r: { source: string }) => r.source !== 'card_update')).toBe(true);
  });

  // The member app's return page has no payment to poll for — a verification
  // writes none — so it reads the latest attempt instead. Written directly here
  // rather than through a fourth POST, which the rate limit below refuses.
  it('reports the latest attempt so the return page can tell it settled', async () => {
    const { insertId } = await db.query(
      `INSERT INTO payment_requests
         (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
          status, provider, provider_order, source)
       VALUES (?, ?, ?, '0.00', 'EUR', NULL, 'pending', 'monei', UUID(), 'card_update')`,
      [gymId, membershipId, memberId],
    );

    const before = await request
      .get('/me/payment-method')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(before.body.last_update).toMatchObject({ id: insertId, status: 'pending' });

    await db.query(
      `UPDATE payment_requests SET status = 'completed', completed_at = UTC_TIMESTAMP() WHERE id = ?`,
      [insertId],
    );

    const after = await request
      .get('/me/payment-method')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(after.body.last_update.status).toBe('completed');
  });

  // Three replacement attempts an hour, keyed on the Clerk user — the same
  // budget a self-initiated payment gets, and its own limiter so a member
  // fixing their card cannot spend the one that lets them pay.
  it('rate-limits a fourth attempt within the hour', async () => {
    const res = await request
      .post('/me/payment-method/replace-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(429);
  });

  it('returns 400 for a member with no membership to store a card for', async () => {
    // A second gym, a second login: this member exists but has no assignment, so
    // there is no `payment_requests` row to write — and no recurring charge to
    // protect either.
    const bareGymId = await createTestGym('Me Payment Method Bare Gym');
    await createTestMembership(bareGymId, 'member', 'bare-card-user');
    await insertMember(bareGymId, 'Bare Member', 'bare-card-user');
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'bare-card-user' } as any);

    const res = await request
      .post('/me/payment-method/replace-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', bareGymId);
    expect(res.status).toBe(400);
    expect(createCardVerificationRequest).not.toHaveBeenCalled();
  });
});

describe('DELETE /me/payment-method', () => {
  it('returns 401 without auth', async () => {
    const res = await request.delete('/me/payment-method').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 404 when there is no card to remove', async () => {
    await clearCards();
    const res = await request
      .delete('/me/payment-method')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 409 while a membership is still scheduled to be charged', async () => {
    await clearCards();
    await storeCard(gymId, memberId, 'tok_kept');

    const res = await request
      .delete('/me/payment-method')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('billable_membership');

    const { rows } = await db.query(
      'SELECT id FROM payment_methods WHERE gym_id = ? AND member_id = ?',
      [gymId, memberId],
    );
    expect(rows).toHaveLength(1);
  });

  it('removes the card once nothing is scheduled to be charged', async () => {
    await clearCards();
    await storeCard(gymId, memberId);
    await storeCard(gymId, otherMemberId, 'tok_untouched', '1111');
    await db.query(`UPDATE user_memberships SET status = 'cancelled' WHERE id = ?`, [membershipId]);

    const res = await request
      .delete('/me/payment-method')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);

    const { rows } = await db.query<{ member_id: number }>(
      'SELECT member_id FROM payment_methods WHERE gym_id = ?',
      [gymId],
    );
    // Only the caller's own card went.
    expect(rows.map((r) => r.member_id)).toEqual([otherMemberId]);
  });
});
