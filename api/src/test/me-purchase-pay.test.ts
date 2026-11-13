// #1862 / #2126 stage 3m — `POST /me/purchases/:id/pay` reissues the hosted page for the member's
// own one-time purchase awaiting payment. Since stage 3m the purchase is found in the Product
// snapshot tables (`product_oneoff_snapshots` / `product_session_snapshots`), the purchase record
// joined only for its `payment_request_id`.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, linkTestPurchaseRequestToEvent } from './helpers';
import { legacyProductInsert } from './legacyProductFixture';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const MEMBER_CLERK = `mpp-member-${uniq()}`;
const OTHER_CLERK = `mpp-other-${uniq()}`;
let memberId: number;
let otherId: number;

function asMember(clerk: string, r: any) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
}

async function member(name: string, clerk: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, name, `mpp-${uniq()}@test.com`, clerk]);
  return insertId;
}

/** A purchase of `type` with its payment request, synced onto its Product snapshot. */
async function purchase(opts: {
  owner: number; type: 'other' | 'sessions'; status: string; requestStatus: string;
}): Promise<{ purchaseId: number; requestId: number; pageToken: string }> {
  const productId = (await db.query<any>(
    `INSERT INTO products (gym_id, name, type, amount, billing_frequency, status, enrollment_status)
     VALUES (?, ?, ?, '20.00', 'once', 'active', 'public')`, [gymId, `Item ${uniq()}`, opts.type])).insertId;
  const pageToken = crypto.randomUUID();
  const requestId = (await db.query<any>(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, provider_ref, page_token, page_token_expires, source)
     VALUES (?, NULL, ?, '20.00', 'EUR', NULL, ?, 'monei', UUID(), ?, ?,
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE), 'product_purchase')`,
    [gymId, opts.owner, opts.requestStatus, `pay_${pageToken}`, pageToken])).insertId;
  await linkTestPurchaseRequestToEvent(gymId, opts.owner, requestId);
  const purchaseId = (await legacyProductInsert(`INSERT INTO member_products_oneoff_snapshot
       (gym_id, member_id, product_id, status, product_name, product_type, billing_frequency,
        units, amount, currency, payment_request_id, created_by)
     VALUES (?, ?, ?, ?, 'Item', ?, 'once', ?, '20.00', 'EUR', ?, 'Test')`,
    [gymId, opts.owner, productId, opts.status, opts.type, opts.type === 'sessions' ? 10 : null, requestId])).insertId;
  return { purchaseId, requestId, pageToken };
}

beforeAll(async () => {
  gymId = await createTestGym();
  await createTestMembership(gymId, 'member', MEMBER_CLERK);
  await createTestMembership(gymId, 'member', OTHER_CLERK);
  memberId = await member('Payer', MEMBER_CLERK);
  otherId = await member('Someone else', OTHER_CLERK);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('POST /me/purchases/:id/pay (#2126 stage 3m)', () => {
  it('reissues the page token of a pending purchase, for a Sessions package and any other Product', async () => {
    for (const type of ['other', 'sessions'] as const) {
      const p = await purchase({ owner: memberId, type, status: 'pending_payment', requestStatus: 'pending' });
      const res = await asMember(MEMBER_CLERK, request.post(`/me/purchases/${p.purchaseId}/pay`));
      expect(res.status).toBe(200);
      expect(res.body.checkoutUrl).toContain('token=');
      const { rows } = await db.query<any>('SELECT page_token FROM payment_requests WHERE id = ?', [p.requestId]);
      expect(rows[0].page_token).not.toBe(p.pageToken);
      expect(res.body.checkoutUrl).toContain(rows[0].page_token);
    }
  });

  it("answers 404 for another member's purchase and leaves its token alone", async () => {
    const p = await purchase({ owner: otherId, type: 'other', status: 'pending_payment', requestStatus: 'pending' });
    const res = await asMember(MEMBER_CLERK, request.post(`/me/purchases/${p.purchaseId}/pay`));
    expect(res.status).toBe(404);
    const { rows } = await db.query<any>('SELECT page_token FROM payment_requests WHERE id = ?', [p.requestId]);
    expect(rows[0].page_token).toBe(p.pageToken);
  });

  it('answers 404 for a purchase that is not awaiting payment', async () => {
    const paid = await purchase({ owner: memberId, type: 'other', status: 'active', requestStatus: 'completed' });
    expect((await asMember(MEMBER_CLERK, request.post(`/me/purchases/${paid.purchaseId}/pay`))).status).toBe(404);
    const expired = await purchase({ owner: memberId, type: 'other', status: 'pending_payment', requestStatus: 'expired' });
    expect((await asMember(MEMBER_CLERK, request.post(`/me/purchases/${expired.purchaseId}/pay`))).status).toBe(404);
  });
});
