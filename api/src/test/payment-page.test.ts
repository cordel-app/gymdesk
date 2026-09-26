import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { defaultTokens } from '../domain/themeTokens';
import { cleanupTestGyms, createTestGym, request } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function createMember(gymId: string, name = 'Token Test Member'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
    [gymId, name, `token-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId;
}

async function createMembershipPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `Token-Plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`],
  );
  return insertId;
}

async function createUserMembership(
  gymId: string,
  memberId: number,
  planId: number,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', CURDATE(), '29.99')`,
    [gymId, memberId, planId],
  );
  return insertId;
}

async function getChargeTypeId(code = 'membership_fee'): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM charge_types WHERE code = ?', [code]);
  return rows[0].id;
}

async function insertPendingRequest(opts: {
  gymId: string;
  userMembershipId: number;
  memberId: number;
  chargeTypeId: number;
  pageToken: string;
  providerRef?: string | null;
  expiresSql?: string;
}): Promise<number> {
  const expires = opts.expiresSql ?? 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)';
  const { insertId } = await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, provider_ref, page_token, page_token_expires, source)
     VALUES (?, ?, ?, '29.99', 'EUR', ?, 'pending', 'monei',
             UUID(), ?, ?, ${expires}, 'admin')`,
    [opts.gymId, opts.userMembershipId, opts.memberId, opts.chargeTypeId, opts.providerRef ?? null, opts.pageToken],
  );
  return insertId;
}

/** #788: a card verification request — zero amount, no charge type. */
async function insertPendingCardUpdate(opts: {
  gymId: string;
  userMembershipId: number;
  memberId: number;
  pageToken: string;
  providerRef: string;
}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, provider_ref, page_token, page_token_expires, source)
     VALUES (?, ?, ?, '0.00', 'EUR', NULL, 'pending', 'monei',
             UUID(), ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE), 'card_update')`,
    [opts.gymId, opts.userMembershipId, opts.memberId, opts.providerRef, opts.pageToken],
  );
  return insertId;
}

describe('GET /payment-page/token/:token', () => {
  let gymId: string;
  let memberId: number;
  let userMembershipId: number;
  let chargeTypeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Payment Page Gym');
    memberId = await createMember(gymId, 'Ana Token');
    const planId = await createMembershipPlan(gymId);
    userMembershipId = await createUserMembership(gymId, memberId, planId);
    chargeTypeId = await getChargeTypeId();
    await db.query(
      `INSERT INTO billing_policies
         (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
       VALUES (?, ?, 1, 'month')`,
      [gymId, planId],
    );
  });

  it('returns display fields and Monei paymentId without Clerk auth', async () => {
    const pageToken = crypto.randomUUID();
    await insertPendingRequest({
      gymId, userMembershipId, memberId, chargeTypeId,
      pageToken, providerRef: 'pay_monei_abc',
    });

    const res = await request.get(`/payment-page/token/${pageToken}`);
    expect(res.status).toBe(200);
    expect(res.body.paymentId).toBe('pay_monei_abc');
    expect(res.body.gymName).toBe('Payment Page Gym');
    expect(res.body.memberName).toBe('Ana Token');
    expect(res.body.amount).toBeCloseTo(29.99);
    expect(res.body.currency).toBe('EUR');
    expect(res.body.billingInterval).toBe('1 month');
    expect(res.body.logoUrl).toBeNull();
    expect(res.body.logoContainsGymName).toBe(false);
    expect(res.body.themeColors).toBeNull();
    expect(res.body).not.toHaveProperty('id');
    expect(res.body).not.toHaveProperty('gym_id');
    expect(res.body).not.toHaveProperty('member_id');
  });

  it('tells a membership-fee page from a card verification (#788)', async () => {
    const feeToken = crypto.randomUUID();
    await insertPendingRequest({
      gymId, userMembershipId, memberId, chargeTypeId,
      pageToken: feeToken, providerRef: 'pay_fee',
    });
    const fee = await request.get(`/payment-page/token/${feeToken}`);
    expect(fee.body.purpose).toBe('membership_fee');

    const cardToken = crypto.randomUUID();
    await insertPendingCardUpdate({
      gymId, userMembershipId, memberId, pageToken: cardToken, providerRef: 'pay_verif',
    });
    const card = await request.get(`/payment-page/token/${cardToken}`);
    expect(card.status).toBe(200);
    // Told, not inferred from the amount: a fee resolved to 0 is not payable at
    // all, so a page guessing from the number would offer "save card" for a free
    // cycle. The page still gets everything it renders — the gym, the member and
    // the billing interval the consent sentence names.
    expect(card.body.purpose).toBe('card_update');
    expect(card.body.paymentId).toBe('pay_verif');
    expect(card.body.amount).toBe(0);
    expect(card.body.billingInterval).toBe('1 month');
    // The page redirects here itself when there is no 3DS hop, so the return URL
    // has to carry what came back — or the member app polls a payment a
    // verification never writes.
    if (card.body.okUrl) expect(card.body.okUrl).toContain('purpose=card_update');
    if (fee.body.okUrl) expect(fee.body.okUrl).not.toContain('purpose=');
  });

  it('includes themeColors when the gym has a theme with color tokens (#489 stage 4)', async () => {
    const tokens = defaultTokens();
    tokens.colors.pageBackground = '#111111';
    tokens.colors.primaryButton = '#222222';
    await db.query(
      `INSERT INTO themes (id, gym_id, name, status, tokens, created_at)
       VALUES (UUID(), NULL, 'Payment Colors Theme', 'active', ?, UTC_TIMESTAMP())`,
      [JSON.stringify(tokens)],
    );
    const { rows: themeRows } = await db.query<{ id: string }>(
      "SELECT id FROM themes WHERE gym_id IS NULL AND name = 'Payment Colors Theme' LIMIT 1",
    );
    const themeId = themeRows[0].id;
    await db.query('UPDATE gyms SET theme_id = ? WHERE id = ?', [themeId, gymId]);

    try {
      const pageToken = crypto.randomUUID();
      await insertPendingRequest({
        gymId, userMembershipId, memberId, chargeTypeId,
        pageToken, providerRef: 'pay_monei_colors',
      });

      const res = await request.get(`/payment-page/token/${pageToken}`);
      expect(res.status).toBe(200);
      expect(res.body.themeColors).toMatchObject({
        pageBackground: '#111111',
        primaryButton: '#222222',
        cardBackground: tokens.colors.cardBackground,
        textColor: tokens.colors.textColor,
      });
      // Internal-only token fields (typography, advanced) must not leak.
      expect(res.body.themeColors).not.toHaveProperty('sidebarBackground');
    } finally {
      await db.query('UPDATE gyms SET theme_id = NULL WHERE id = ?', [gymId]);
      await db.query('DELETE FROM themes WHERE id = ?', [themeId]);
    }
  });

  it('includes logoUrl and logoContainsGymName when the gym has a theme with a logo (#488)', async () => {
    await db.query(
      `INSERT INTO themes (id, gym_id, name, status, logo_mime, logo_bytes, logo_contains_gym_name, tokens, created_at)
       VALUES (UUID(), NULL, 'Payment Logo Theme', 'active', 'image/png', UNHEX('89504e47'), 1, '{}', UTC_TIMESTAMP())`,
    );
    const { rows: themeRows } = await db.query<{ id: string }>(
      "SELECT id FROM themes WHERE gym_id IS NULL AND name = 'Payment Logo Theme' LIMIT 1",
    );
    const themeId = themeRows[0].id;
    await db.query('UPDATE gyms SET theme_id = ? WHERE id = ?', [themeId, gymId]);

    try {
      const pageToken = crypto.randomUUID();
      await insertPendingRequest({
        gymId, userMembershipId, memberId, chargeTypeId,
        pageToken, providerRef: 'pay_monei_logo',
      });

      const res = await request.get(`/payment-page/token/${pageToken}`);
      expect(res.status).toBe(200);
      expect(res.body.logoUrl).toContain(`/themes/${themeId}/logo`);
      expect(res.body.logoContainsGymName).toBe(true);
      expect(res.body.themeColors).toBeNull();
    } finally {
      await db.query('UPDATE gyms SET theme_id = NULL WHERE id = ?', [gymId]);
      await db.query('DELETE FROM themes WHERE id = ?', [themeId]);
    }
  });

  it('consumes the token so a second request returns 404', async () => {
    const pageToken = crypto.randomUUID();
    await insertPendingRequest({
      gymId, userMembershipId, memberId, chargeTypeId,
      pageToken, providerRef: 'pay_monei_once',
    });

    const first = await request.get(`/payment-page/token/${pageToken}`);
    expect(first.status).toBe(200);

    const second = await request.get(`/payment-page/token/${pageToken}`);
    expect(second.status).toBe(404);
  });

  it('returns 404 for an expired token', async () => {
    const pageToken = crypto.randomUUID();
    await insertPendingRequest({
      gymId, userMembershipId, memberId, chargeTypeId,
      pageToken, providerRef: 'pay_monei_expired',
      expiresSql: 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)',
    });

    const res = await request.get(`/payment-page/token/${pageToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown token', async () => {
    const res = await request.get(`/payment-page/token/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the Monei paymentId was never stored', async () => {
    const pageToken = crypto.randomUUID();
    await insertPendingRequest({
      gymId, userMembershipId, memberId, chargeTypeId,
      pageToken, providerRef: null,
    });

    const res = await request.get(`/payment-page/token/${pageToken}`);
    expect(res.status).toBe(404);
  });
});
