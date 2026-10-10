// #787 — receipts for every payment that was actually received.
//
// Until this ticket `POST /payments/:id/receipt` answered
// `400 'Receipts can only be generated for payment_recorded events'`, so a fee
// collected by the nightly run — which writes a `recurring_payment` — could
// never be receipted, for the staff or for the member. Once a gym bills
// monthly that is every payment except the first.
//
// Integration rather than unit: the predicate itself is pure and covered by
// `receipt-eligibility.unit.test.ts`. What is under test here is the route
// wiring — which events the endpoint accepts, that the number allocated is
// gapless and idempotent, and that neither the staff route nor the member one
// leaks across gyms.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request, ensureTestProductSet } from './helpers';

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ── Local setup helpers ───────────────────────────────────────────────────────

async function chargeTypeId(code = 'membership_fee'): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM charge_types WHERE code = ?', [code]);
  return rows[0].id;
}

async function createMember(gymId: string, clerkUserId: string | null = null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'Receipt Member', ?, ?)`,
    [gymId, `receipt-${uniq()}@test.com`, clerkUserId],
  );
  return insertId;
}

/** An assignment to hang the events and their transactions off. */
async function createAssignment(gymId: string, memberId: number): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `Receipt-Plan-${uniq()}`],
  );
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', '2020-01-01', '29.99')`,
    [gymId, memberId, planId],
  );
  return insertId;
}

/** A ledger row of any type, optionally with one transaction pointing at it. */
async function createEvent(
  ctx: { gymId: string; memberId: number; umId: number },
  eventType: string,
  opts: { amount?: string; txStatus?: 'completed' | 'failed' | 'expired' | 'pending' } = {},
): Promise<number> {
  const { gymId, memberId, umId } = ctx;
  const amount = opts.amount ?? '29.99';
  const ctId = await chargeTypeId();
  const { insertId } = await db.query(
    `INSERT INTO billing_events
       (gym_id, member_id, user_membership_id, product_set_id, event_type, charge_type_id, source, actor_user_id, amount)
     VALUES (?, ?, ?, ?, ?, ?, 'system', NULL, ?)`,
    [gymId, memberId, umId, await ensureTestProductSet(gymId, memberId, umId), eventType, ctId, amount],
  );
  if (opts.txStatus) {
    await db.query(
      `INSERT INTO payment_requests
         (gym_id, user_membership_id, member_id, amount, currency, charge_type_id, billing_event_id,
          status, provider, provider_order, source, created_at)
       VALUES (?, ?, ?, ?, 'EUR', ?, ?, ?, 'monei', ?, 'billing_run', UTC_TIMESTAMP())`,
      [gymId, umId, memberId, amount, ctId, insertId, opts.txStatus, `order-${uniq()}`],
    );
  }
  return insertId;
}

/** Appends a later transaction, as Retry / Manual payment do on a failed event. */
async function appendTransaction(
  ctx: { gymId: string; memberId: number; umId: number },
  eventId: number,
  status: 'completed' | 'failed',
): Promise<void> {
  const ctId = await chargeTypeId();
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id, billing_event_id,
        status, provider, provider_order, source, created_at)
     VALUES (?, ?, ?, '29.99', 'EUR', ?, ?, ?, 'monei', ?, 'admin',
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 SECOND))`,
    [ctx.gymId, ctx.umId, ctx.memberId, ctId, eventId, status, `order-${uniq()}`],
  );
}

const postReceipt = (gymId: string, eventId: number) =>
  request.post(`/payments/${eventId}/receipt`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

const getReceipt = (gymId: string, eventId: number) =>
  request.get(`/payments/${eventId}/receipt`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

const getDetails = (gymId: string, eventId: number) =>
  request.get(`/payments/billing-events/${eventId}`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function receiptNumberOf(eventId: number): Promise<string | null> {
  const { rows } = await db.query<{ receipt_number: string | null }>(
    'SELECT receipt_number FROM billing_events WHERE id = ?', [eventId],
  );
  return rows[0].receipt_number;
}

// ── Which events may be receipted ─────────────────────────────────────────────

describe('POST /payments/:id/receipt — eligibility (#787)', () => {
  let gymId: string;
  let ctx: { gymId: string; memberId: number; umId: number };

  beforeAll(async () => {
    gymId = await createTestGym('Receipt Eligibility Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    ctx = { gymId, memberId, umId: await createAssignment(gymId, memberId) };
  });

  it('issues for a recurring_payment settled by the nightly run', async () => {
    const eventId = await createEvent(ctx, 'recurring_payment', { txStatus: 'completed' });

    const res = await postReceipt(gymId, eventId);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(await receiptNumberOf(eventId)).toMatch(/^\d{4}-\d{4}$/);
  });

  it('still issues for a cash payment_recorded with no transaction', async () => {
    // The behaviour #114 shipped — widening the predicate must not lose it.
    const eventId = await createEvent(ctx, 'payment_recorded');

    expect((await postReceipt(gymId, eventId)).status).toBe(200);
    expect(await receiptNumberOf(eventId)).not.toBeNull();
  });

  it('issues for a failed_billing later settled by Retry or Manual payment', async () => {
    // #640's actions never append a second Billing Event, so the money sits on
    // the rejected row and there is nothing else to issue against.
    const eventId = await createEvent(ctx, 'failed_billing', { txStatus: 'failed' });
    expect((await postReceipt(gymId, eventId)).status).toBe(400);

    await appendTransaction(ctx, eventId, 'completed');

    expect((await postReceipt(gymId, eventId)).status).toBe(200);
    expect(await receiptNumberOf(eventId)).not.toBeNull();
  });

  it('refuses a recurring_payment the provider rejected', async () => {
    const eventId = await createEvent(ctx, 'recurring_payment', { txStatus: 'failed' });

    const res = await postReceipt(gymId, eventId);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("'failed'");
    expect(await receiptNumberOf(eventId)).toBeNull();
  });

  it('refuses a recurring_payment whose transaction is still pending', async () => {
    const eventId = await createEvent(ctx, 'recurring_payment', { txStatus: 'pending' });

    expect((await postReceipt(gymId, eventId)).status).toBe(400);
    expect(await receiptNumberOf(eventId)).toBeNull();
  });

  it('refuses a waived cycle', async () => {
    // A waived cycle takes no money: it calls no provider and writes no
    // transaction, so there is nothing to put on a receipt.
    const eventId = await createEvent(ctx, 'waived_billing', { amount: '0.00' });

    const res = await postReceipt(gymId, eventId);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('waived_billing');
    expect(await receiptNumberOf(eventId)).toBeNull();
  });

  it('refuses an adjustment', async () => {
    const eventId = await createEvent(ctx, 'adjustment');

    expect((await postReceipt(gymId, eventId)).status).toBe(400);
    expect(await receiptNumberOf(eventId)).toBeNull();
  });

  it('refuses a paid event with no amount', async () => {
    const eventId = await createEvent(ctx, 'recurring_payment',
      { amount: '0.00', txStatus: 'completed' });

    const res = await postReceipt(gymId, eventId);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('amount');
  });
});

// ── Numbering ─────────────────────────────────────────────────────────────────

describe('receipt numbering (#787)', () => {
  let gymId: string;
  let ctx: { gymId: string; memberId: number; umId: number };

  beforeAll(async () => {
    gymId = await createTestGym('Receipt Numbering Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    ctx = { gymId, memberId, umId: await createAssignment(gymId, memberId) };
  });

  it('numbers recurring charges gaplessly in the same per-gym sequence as cash payments', async () => {
    const cashId = await createEvent(ctx, 'payment_recorded');
    const recurringId = await createEvent(ctx, 'recurring_payment', { txStatus: 'completed' });

    expect((await postReceipt(gymId, cashId)).status).toBe(200);
    expect((await postReceipt(gymId, recurringId)).status).toBe(200);

    const first = (await receiptNumberOf(cashId))!;
    const second = (await receiptNumberOf(recurringId))!;
    const [year, a] = first.split('-');
    const [, b] = second.split('-');
    // One sequence, not one per event type: consecutive, same year.
    expect(second.startsWith(`${year}-`)).toBe(true);
    expect(Number(b)).toBe(Number(a) + 1);
  });

  it('is idempotent — a second POST returns the same number and burns none', async () => {
    const eventId = await createEvent(ctx, 'recurring_payment', { txStatus: 'completed' });

    await postReceipt(gymId, eventId);
    const issued = await receiptNumberOf(eventId);
    const { rows: before } = await db.query<{ last_seq: number }>(
      'SELECT last_seq FROM receipt_sequences WHERE gym_id = ?', [gymId],
    );

    expect((await postReceipt(gymId, eventId)).status).toBe(200);

    expect(await receiptNumberOf(eventId)).toBe(issued);
    const { rows: after } = await db.query<{ last_seq: number }>(
      'SELECT last_seq FROM receipt_sequences WHERE gym_id = ?', [gymId],
    );
    expect(after[0].last_seq).toBe(before[0].last_seq);
  });

  it('refuses concurrent issuance without allocating two numbers', async () => {
    const eventId = await createEvent(ctx, 'recurring_payment', { txStatus: 'completed' });

    const [a, b] = await Promise.all([postReceipt(gymId, eventId), postReceipt(gymId, eventId)]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Whichever lost the race read the winner's number under its own lock
    // rather than spending the next one on a second receipt for one payment.
    const { rows } = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND receipt_number IS NOT NULL', [gymId],
    );
    const { rows: sequence } = await db.query<{ last_seq: number }>(
      'SELECT last_seq FROM receipt_sequences WHERE gym_id = ?', [gymId],
    );
    expect(sequence[0].last_seq).toBe(rows[0].n);
  });
});

// ── GET, Details flag, tenancy and auth ───────────────────────────────────────

describe('receipt reads and access (#787)', () => {
  let gymId: string;
  let ctx: { gymId: string; memberId: number; umId: number };

  beforeAll(async () => {
    gymId = await createTestGym('Receipt Access Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    ctx = { gymId, memberId, umId: await createAssignment(gymId, memberId) };
  });

  it('GET returns the PDF once issued, and 404 before', async () => {
    const eventId = await createEvent(ctx, 'recurring_payment', { txStatus: 'completed' });

    expect((await getReceipt(gymId, eventId)).status).toBe(404);

    await postReceipt(gymId, eventId);

    const res = await getReceipt(gymId, eventId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('the Details view flags a settled recurring charge as receipt-able', async () => {
    const paid = await createEvent(ctx, 'recurring_payment', { txStatus: 'completed' });
    const rejected = await createEvent(ctx, 'recurring_payment', { txStatus: 'failed' });
    const waived = await createEvent(ctx, 'waived_billing', { amount: '0.00' });

    expect((await getDetails(gymId, paid)).body.can_issue_receipt).toBe(true);
    expect((await getDetails(gymId, rejected)).body.can_issue_receipt).toBe(false);
    expect((await getDetails(gymId, waived)).body.can_issue_receipt).toBe(false);
  });

  it('does not issue a receipt for another gym’s event', async () => {
    const otherGymId = await createTestGym('Receipt Other Gym');
    await createTestMembership(otherGymId);
    const otherMemberId = await createMember(otherGymId);
    const otherCtx = {
      gymId: otherGymId,
      memberId: otherMemberId,
      umId: await createAssignment(otherGymId, otherMemberId),
    };
    const otherEventId = await createEvent(otherCtx, 'recurring_payment', { txStatus: 'completed' });

    expect((await postReceipt(gymId, otherEventId)).status).toBe(404);
    expect((await getReceipt(gymId, otherEventId)).status).toBe(404);
    expect(await receiptNumberOf(otherEventId)).toBeNull();
  });

  it('returns 401 without authentication', async () => {
    const eventId = await createEvent(ctx, 'recurring_payment', { txStatus: 'completed' });

    expect((await request.post(`/payments/${eventId}/receipt`).set('x-gym-id', gymId)).status).toBe(401);
  });
});

// ── The member's own receipts ─────────────────────────────────────────────────

describe('GET /me/receipts/:billingEventId (#787)', () => {
  let gymId: string;
  let ctx: { gymId: string; memberId: number; umId: number };

  const meReceipt = (gym: string, eventId: number) =>
    request.get(`/me/receipts/${eventId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

  beforeAll(async () => {
    gymId = await createTestGym('Receipt Member Gym');
    await createTestMembership(gymId, 'member');
    const memberId = await createMember(gymId, TEST_USER_ID);
    ctx = { gymId, memberId, umId: await createAssignment(gymId, memberId) };
  });

  it('serves the member their own recurring charge’s receipt', async () => {
    const eventId = await createEvent(ctx, 'recurring_payment', { txStatus: 'completed' });
    await db.query(
      `UPDATE billing_events SET receipt_number = '2026-9001', receipt_issued_at = UTC_TIMESTAMP() WHERE id = ?`,
      [eventId],
    );

    const res = await meReceipt(gymId, eventId);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('404s for an event that has no receipt yet', async () => {
    const eventId = await createEvent(ctx, 'recurring_payment', { txStatus: 'completed' });

    expect((await meReceipt(gymId, eventId)).status).toBe(404);
  });

  it('404s for another member’s receipt', async () => {
    const otherMemberId = await createMember(gymId);
    const otherCtx = {
      gymId,
      memberId: otherMemberId,
      umId: await createAssignment(gymId, otherMemberId),
    };
    const eventId = await createEvent(otherCtx, 'recurring_payment', { txStatus: 'completed' });
    await db.query(
      `UPDATE billing_events SET receipt_number = '2026-9002', receipt_issued_at = UTC_TIMESTAMP() WHERE id = ?`,
      [eventId],
    );

    expect((await meReceipt(gymId, eventId)).status).toBe(404);
  });
});
