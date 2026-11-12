// #2126 stage 3p — completing a one-time purchase (the payment webhook's `completeProductPurchase()`)
// and cancelling an abandoned one (`POST /billing/cleanup`'s `cancelAbandonedPurchases()`) find the
// purchase in the Product snapshot tables (`product_oneoff_snapshots` / `product_session_snapshots`),
// the purchase record joined only for its `payment_request_id`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { db } from '../infra/db';
import { syncProductSnapshotForPurchase } from './purchaseSnapshotFixture';
import { cancelAbandonedPurchases, completeProductPurchase } from '../api/me-products';
import { cleanupTestGyms, createTestGym, linkTestPurchaseRequestToEvent } from './helpers';

let gymId: string;
let memberId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

/** A purchase of `type` with its payment request, synced onto its Product snapshot. */
async function purchase(opts: {
  type: 'other' | 'sessions'; requestStatus: string; validityDays?: number | null;
}): Promise<{ purchaseId: number; requestId: number }> {
  const productId = (await db.query<any>(
    `INSERT INTO products (gym_id, name, type, amount, billing_frequency, status, enrollment_status)
     VALUES (?, ?, ?, '20.00', 'once', 'active', 'public')`, [gymId, `Item ${uniq()}`, opts.type])).insertId;
  const token = crypto.randomUUID();
  const requestId = (await db.query<any>(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, provider_ref, page_token, page_token_expires, source)
     VALUES (?, NULL, ?, '20.00', 'EUR', NULL, ?, 'monei', UUID(), ?, ?,
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE), 'product_purchase')`,
    [gymId, memberId, opts.requestStatus, `pay_${token}`, token])).insertId;
  await linkTestPurchaseRequestToEvent(gymId, memberId, requestId);
  const purchaseId = (await db.query<any>(
    `INSERT INTO member_products_oneoff_snapshot
       (gym_id, member_id, product_id, status, product_name, product_type, billing_frequency,
        units, amount, currency, payment_request_id, validity_days, created_by)
     VALUES (?, ?, ?, 'pending_payment', 'Item', ?, 'once', ?, '20.00', 'EUR', ?, ?, 'Test')`,
    [gymId, memberId, productId, opts.type, opts.type === 'sessions' ? 10 : null, requestId,
      opts.validityDays ?? null])).insertId;
  await db.transaction((tx) => syncProductSnapshotForPurchase(tx, gymId, purchaseId));
  return { purchaseId, requestId };
}

async function state(purchaseId: number) {
  const { rows } = await db.query<any>(
    `SELECT status, DATE_FORMAT(valid_until, '%Y-%m-%d') AS valid_until, purchased_at
       FROM member_products_oneoff_snapshot WHERE id = ?`, [purchaseId]);
  const { rows: snap } = await db.query<any>(
    `SELECT status FROM product_oneoff_snapshots WHERE source_id = ?
     UNION ALL SELECT status FROM product_session_snapshots WHERE source_id = ?`, [purchaseId, purchaseId]);
  return { ...rows[0], snapshot_status: snap[0]?.status ?? null };
}

beforeAll(async () => {
  gymId = await createTestGym();
  memberId = (await db.query<any>('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Buyer', `pcs-${uniq()}@test.com`])).insertId;
});

afterAll(async () => {
  await db.query('DELETE FROM member_products_oneoff_snapshot WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('completeProductPurchase() (#2126 stage 3p)', () => {
  it('completes a pending purchase found through its snapshot, for a Sessions package and any other Product', async () => {
    for (const type of ['other', 'sessions'] as const) {
      const p = await purchase({ type, requestStatus: 'pending', validityDays: 30 });
      const changed = await db.transaction((tx) => completeProductPurchase(tx, gymId, p.requestId));
      expect(changed).toBe(1);
      const s = await state(p.purchaseId);
      expect(s.status).toBe('active');
      expect(s.snapshot_status).toBe('active');
      expect(s.purchased_at).not.toBeNull();
      // valid_until comes from the snapshot's validity_days (30 days, last day inclusive).
      expect(s.valid_until).not.toBeNull();
    }
  });

  it('is idempotent: a second delivery changes nothing', async () => {
    const p = await purchase({ type: 'other', requestStatus: 'pending' });
    expect(await db.transaction((tx) => completeProductPurchase(tx, gymId, p.requestId))).toBe(1);
    expect(await db.transaction((tx) => completeProductPurchase(tx, gymId, p.requestId))).toBe(0);
  });

  it("does not complete another gym's purchase", async () => {
    const p = await purchase({ type: 'other', requestStatus: 'pending' });
    const otherGym = await createTestGym();
    expect(await db.transaction((tx) => completeProductPurchase(tx, otherGym, p.requestId))).toBe(0);
    expect((await state(p.purchaseId)).status).toBe('pending_payment');
  });
});

describe('cancelAbandonedPurchases() (#2126 stage 3p)', () => {
  it('cancels a pending purchase whose payment expired or failed, and its snapshot with it', async () => {
    const expired = await purchase({ type: 'other', requestStatus: 'expired' });
    const failed = await purchase({ type: 'sessions', requestStatus: 'failed' });
    const live = await purchase({ type: 'other', requestStatus: 'pending' });
    await cancelAbandonedPurchases();
    for (const p of [expired, failed]) {
      const s = await state(p.purchaseId);
      expect(s.status).toBe('cancelled');
      expect(s.snapshot_status).toBe('cancelled');
    }
    const s = await state(live.purchaseId);
    expect(s.status).toBe('pending_payment');
    expect(s.snapshot_status).toBe('pending_payment');
  });
});
