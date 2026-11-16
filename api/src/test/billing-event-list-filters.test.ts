// #2886: the Billing Events list's filters — Product, Processed by, Payment
// method, Date range, Amount range, Status and Member, combined with AND.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  ensureTestProductSet,
  request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function createMember(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
    [gymId, name, `bef-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`],
  );
  return insertId;
}

async function insertEvent(
  gymId: string, memberId: number,
  opts: { amount: string; billingDate: string; createdBy: string; lines: string[] },
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO billing_events
       (gym_id, member_id, product_set_id, event_type, source, created_by, amount, billing_date)
     VALUES (?, ?, ?, 'payment_recorded', 'employee', ?, ?, ?)`,
    [gymId, memberId, await ensureTestProductSet(gymId, memberId), opts.createdBy, opts.amount, opts.billingDate],
  );
  for (const name of opts.lines) {
    await db.query(
      `INSERT INTO billing_event_lines (gym_id, billing_event_id, kind, item_name, amount)
       VALUES (?, ?, 'product', ?, ?)`,
      [gymId, insertId, name, opts.amount],
    );
  }
  return insertId;
}

async function insertAttempt(
  gymId: string, eventId: number, memberId: number,
  opts: { status: string; methodCode: string | null; methodName: string | null; createdBy: string },
): Promise<void> {
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, member_id, amount, currency, status, provider, provider_order, page_token,
        page_token_expires, source, billing_event_id, payment_method_code, payment_method_name, created_by)
     VALUES (?, ?, '10.00', 'EUR', ?, 'monei', UUID(), UUID(), DATE_ADD(NOW(), INTERVAL 10 MINUTE),
             'admin', ?, ?, ?, ?)`,
    [gymId, memberId, opts.status, eventId, opts.methodCode, opts.methodName, opts.createdBy],
  );
}

describe('GET /payments/billing-events — #2886 filters', () => {
  let gymId: string;
  let otherGymId: string;
  let ana: number;
  let bob: number;
  let lockerEvent: number;   // Ana, "Locker Rental", 20.00, 2026-03-10, by Alice, card, paid
  let ptEvent: number;       // Ana, "Personal Training 10", 150.00, 2026-04-15, by System, cash, paid
  let bobEvent: number;      // Bob, "Locker Rental Premium", 45.50, 2026-05-01, by Alice, card, failed

  beforeAll(async () => {
    gymId = await createTestGym('Billing filters gym');
    otherGymId = await createTestGym('Billing filters other gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');
    ana = await createMember(gymId, 'Ana Filters');
    bob = await createMember(gymId, 'Bob Filters');

    lockerEvent = await insertEvent(gymId, ana, { amount: '20.00', billingDate: '2026-03-10', createdBy: 'Alice', lines: ['Membership Fee', 'Locker Rental'] });
    await insertAttempt(gymId, lockerEvent, ana, { status: 'completed', methodCode: 'card', methodName: 'Card', createdBy: 'Alice' });

    ptEvent = await insertEvent(gymId, ana, { amount: '150.00', billingDate: '2026-04-15', createdBy: 'System', lines: ['Personal Training 10'] });
    await insertAttempt(gymId, ptEvent, ana, { status: 'completed', methodCode: 'cash', methodName: 'Cash', createdBy: 'Carla' });

    bobEvent = await insertEvent(gymId, bob, { amount: '45.50', billingDate: '2026-05-01', createdBy: 'Alice', lines: ['Locker Rental Premium'] });
    await insertAttempt(gymId, bobEvent, bob, { status: 'failed', methodCode: 'card', methodName: 'Card', createdBy: 'System' });

    // Another gym's event matching every filter must never appear.
    const other = await createMember(otherGymId, 'Other Gym Member');
    const otherEvent = await insertEvent(otherGymId, other, { amount: '20.00', billingDate: '2026-03-10', createdBy: 'Alice', lines: ['Locker Rental'] });
    await insertAttempt(otherGymId, otherEvent, other, { status: 'completed', methodCode: 'card', methodName: 'Card', createdBy: 'Alice' });
  });

  async function ids(query: string): Promise<number[]> {
    const res = await request
      .get(`/payments/billing-events?${query}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    return (res.body.items as Array<{ id: number }>).map((r) => r.id).sort((a, b) => a - b);
  }

  it('Product matches partial text in any line name, case-insensitively', async () => {
    expect(await ids('product=locker')).toEqual([lockerEvent, bobEvent].sort((a, b) => a - b));
    expect(await ids('product=training')).toEqual([ptEvent]);
    expect(await ids('product=nothing-like-this')).toEqual([]);
  });

  it('Product treats % and _ literally', async () => {
    expect(await ids('product=%25')).toEqual([]);
  });

  it('Processed by matches the event creator or any attempt creator', async () => {
    expect(await ids('processed_by=Alice')).toEqual([lockerEvent, bobEvent].sort((a, b) => a - b));
    expect(await ids('processed_by=Carla')).toEqual([ptEvent]);
  });

  it('Payment method matches the latest attempt method', async () => {
    expect(await ids('payment_method=cash')).toEqual([ptEvent]);
    expect(await ids('payment_method=card')).toEqual([lockerEvent, bobEvent].sort((a, b) => a - b));
  });

  it('Date range uses the billing date, each bound alone or together', async () => {
    expect(await ids('from=2026-04-15')).toEqual([ptEvent, bobEvent].sort((a, b) => a - b));
    expect(await ids('to=2026-04-15')).toEqual([lockerEvent, ptEvent].sort((a, b) => a - b));
    expect(await ids('from=2026-04-01&to=2026-04-30')).toEqual([ptEvent]);
  });

  it('Amount range uses the event total, each bound alone or together', async () => {
    expect(await ids('amount_min=45.50')).toEqual([ptEvent, bobEvent].sort((a, b) => a - b));
    expect(await ids('amount_max=45.50')).toEqual([lockerEvent, bobEvent].sort((a, b) => a - b));
    expect(await ids('amount_min=30&amount_max=100')).toEqual([bobEvent]);
  });

  it('combines every filter with AND, Member and Status included', async () => {
    expect(await ids('product=locker&processed_by=Alice&payment_method=card')).toEqual([lockerEvent, bobEvent].sort((a, b) => a - b));
    expect(await ids(`product=locker&member_id=${bob}`)).toEqual([bobEvent]);
    expect(await ids('product=locker&status=failed')).toEqual([bobEvent]);
    expect(await ids(`member_id=${ana}&amount_min=100`)).toEqual([ptEvent]);
  });

  it('refuses an invalid date or amount', async () => {
    for (const q of ['from=yesterday', 'amount_min=abc']) {
      const res = await request
        .get(`/payments/billing-events?${q}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(400);
    }
  });

  it('filter-options lists the gym’s own actors and payment methods only', async () => {
    const res = await request
      .get('/payments/billing-events/filter-options')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.processed_by).toEqual(expect.arrayContaining(['Alice', 'Carla', 'System']));
    expect(res.body.payment_methods).toEqual(expect.arrayContaining([
      { code: 'card', name: 'Card' }, { code: 'cash', name: 'Cash' },
    ]));
    expect(res.body.payment_methods).toHaveLength(2);
  });

  it('filter-options requires authentication', async () => {
    const res = await request.get('/payments/billing-events/filter-options').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});
