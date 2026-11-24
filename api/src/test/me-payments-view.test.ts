// #3297 — the Members App's Payments tab groups the member's own ledger by each
// payment's scheduled execution date. `GET /me/billing-events` therefore reports
// a persisted, not-yet-executed obligation as `scheduled` (never `recorded`),
// the date each payment is (or was) executed on, and whether the money collected
// and refunded was the full amount or part of it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, ensureTestProductSet, request,
} from './helpers';

const stamp = Date.now();
const ALICE = `mpv-alice-${stamp}`;
const BOB = `mpv-bob-${stamp}`;
let gymId: string;
let ctId: number;
let alice: number;
let bob: number;
let planned: number;
let paid: number;
let partial: number;
let bobEvent: number;

function as(clerk: string) {
  vi.mocked(verifyToken).mockResolvedValue({ sub: clerk } as any);
  return request.get('/me/billing-events').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
}

async function member(name: string, clerk: string): Promise<number> {
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, name, `${clerk}@test.com`, clerk]);
  return insertId as number;
}

async function event(memberId: number, opts: { scheduled?: boolean; billingDate?: string | null; amount?: string } = {}) {
  const psId = await ensureTestProductSet(gymId, memberId);
  const { insertId } = await db.query(
    `INSERT INTO billing_events (gym_id, product_set_id, member_id, event_type, amount, charge_type_id, source,
                                 billing_date, is_scheduled)
     VALUES (?, ?, ?, ?, ?, ?, 'system', ?, ?)`,
    [gymId, psId, memberId, opts.scheduled ? 'charge_created' : 'payment_recorded', opts.amount ?? '40.00', ctId,
      opts.billingDate ?? null, opts.scheduled ? 1 : 0]);
  return insertId as number;
}

async function payment(eventId: number, memberId: number, amount: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO payment_requests (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status,
                                   provider, provider_order, source, attempt, method)
     VALUES (?, ?, ?, 'EUR', ?, ?, 'completed', 'manual', UUID(), 'manual', 1, 'cash')`,
    [gymId, memberId, amount, ctId, eventId]);
  return insertId as number;
}

async function refund(originalId: number, memberId: number, amount: string) {
  await db.query(
    `INSERT INTO payment_requests (gym_id, member_id, amount, currency, status, provider, provider_order, source,
                                   attempt, method, transaction_type, refund_of_payment_request_id, completed_at)
     VALUES (?, ?, ?, 'EUR', 'completed', 'manual', UUID(), 'manual', 1, 'cash', 'refund', ?, UTC_TIMESTAMP())`,
    [gymId, memberId, amount, originalId]);
}

beforeAll(async () => {
  gymId = await createTestGym('Member Payments View Gym');
  const { rows } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  ctId = rows[0].id;
  alice = await member('Alice', ALICE);
  bob = await member('Bob', BOB);

  planned = await event(alice, { scheduled: true, billingDate: '2099-01-01' });
  paid = await event(alice, { billingDate: '2026-01-01' });
  const paidAttempt = await payment(paid, alice, '40.00');
  await refund(paidAttempt, alice, '10.00');
  partial = await event(alice, { amount: '40.00' });
  await payment(partial, alice, '15.00');
  bobEvent = await event(bob, { scheduled: true, billingDate: '2099-02-01' });
});

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('GET /me/billing-events for the Payments tab (#3297)', () => {
  it('reports a persisted obligation as scheduled, on its own billing date', async () => {
    const res = await as(ALICE);
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: any) => i.id === planned);
    expect(row.status).toBe('scheduled');
    expect(row.scheduled_date).toBe('2099-01-01');
    expect(row.payment_type).toBeNull();
    expect(row.refund_type).toBeNull();
    expect(row).not.toHaveProperty('is_scheduled');
  });

  it('dates an executed payment by its billing date, and one without by the day it was written', async () => {
    const items = (await as(ALICE)).body.items;
    expect(items.find((i: any) => i.id === paid).scheduled_date).toBe('2026-01-01');
    const written = items.find((i: any) => i.id === partial);
    expect(written.scheduled_date).toBe(new Date(written.created_at).toISOString().slice(0, 10));
  });

  it('says whether the money collected and refunded was all of it or part of it', async () => {
    const items = (await as(ALICE)).body.items;
    const full = items.find((i: any) => i.id === paid);
    expect(full.status).toBe('paid');
    expect(full.payment_type).toBe('full');
    expect(full.refund_type).toBe('partial');
    expect(items.find((i: any) => i.id === partial).payment_type).toBe('partial');
  });

  it('lists the newest execution date first and never another member’s payment', async () => {
    const ids = (await as(ALICE)).body.items.map((i: any) => i.id);
    expect(ids[0]).toBe(planned);
    expect(ids).not.toContain(bobEvent);
  });

  it('is refused without a session', async () => {
    const res = await request.get('/me/billing-events').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});
