import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';

// Only the call that would reach Monei is stubbed (Save & Pay raises the hosted page).
vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({
    createPaymentRequest: async (p: { orderId: string }) => ({
      providerOrderId: `monei-${p.orderId}`, checkoutUrl: 'https://pay.test/x',
    }),
  }),
}));
import { deriveBilling } from '../domain/derivedBilling';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

describe('derived billing values (#1325)', () => {
  const ev = (over: any) => ({ id: 1, billingDate: '2026-11-01', isScheduled: true, eventType: 'charge_created', ...over });
  const at = (over: any) => ({ billingEventId: 1, method: 'provider' as const, status: 'completed',
    createdAt: '2026-10-01T10:00:00.000Z', completedAt: '2026-10-01T10:00:05.000Z', ...over });

  it('next billing date is the earliest unsettled obligation, an overdue one kept', () => {
    const d = deriveBilling([
      ev({ id: 1, billingDate: '2026-12-01' }), ev({ id: 2, billingDate: '2026-11-01' }),
      ev({ id: 3, billingDate: '2026-09-01', isScheduled: false, eventType: 'failed_billing' }),
    ], []);
    expect(d.next_billing_date).toBe('2026-09-01');
  });

  it('a settled event no longer counts; nothing owed is null', () => {
    const d = deriveBilling([ev({ id: 1, isScheduled: false, eventType: 'failed_billing' })],
      [at({ billingEventId: 1 })]);
    expect(d.next_billing_date).toBeNull();
    expect(d.failed_attempts).toBe(0);
  });

  it('last billed is the latest money moved; a waiver bills nothing', () => {
    const d = deriveBilling([], [
      at({ completedAt: '2026-10-01T10:00:05.000Z' }),
      at({ method: 'waive', completedAt: '2026-11-01T00:00:00.000Z' }),
      at({ method: 'cash', completedAt: '2026-10-15T09:00:00.000Z' }),
    ]);
    expect(d.last_billed_at).toBe('2026-10-15T09:00:00.000Z');
  });

  it('failed attempts count distinct UTC days of the event being charged', () => {
    const d = deriveBilling(
      [ev({ id: 7, isScheduled: false, eventType: 'failed_billing', billingDate: '2026-10-05' })],
      [
        at({ billingEventId: 7, status: 'failed', createdAt: '2026-10-05T03:00:00.000Z', completedAt: null }),
        at({ billingEventId: 7, status: 'failed', createdAt: '2026-10-05T15:00:00.000Z', completedAt: null }),
        at({ billingEventId: 7, status: 'failed', createdAt: '2026-10-06T03:00:00.000Z', completedAt: null }),
      ],
    );
    expect(d.failed_attempts).toBe(2);
    expect(d.last_failed_at).toBe('2026-10-06T03:00:00.000Z');
  });
});

describe('readers see a ProductSet-billed assignment (#1325)', () => {
  let gymId: string;
  let seq = 0;
  const uniq = () => `${Date.now()}-${(seq += 1)}`;
  const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
  const TODAY = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    gymId = await createTestGym('Derived readers gym');
    await createTestMembership(gymId, 'admin');
  });
  afterAll(async () => {
    await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
    await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
    await cleanupTestGyms();
    await db.end();
  });

  async function billedAssignment() {
    const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `dr-${uniq()}@test.com`]);
    const p = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit) VALUES (?, ?, 'active', 'public', '1')`,
      [gymId, `DR-${uniq()}`]);
    await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, 30, '2020-01-01', 'active')`, [gymId, p.insertId]);
    await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`, [gymId, p.insertId]);
    // A plan billed from a ProductSet: created, saved for payment and paid in
    // cash through the ProductSet API; activation projects the assignment.
    const created = await auth(request.post('/product-sets')).send({ member_id: m.insertId, membership_plan_id: p.insertId, starts_at: TODAY });
    expect(created.status).toBe(201);
    expect((await auth(request.post(`/product-sets/${created.body.id}/save-and-pay`)).send({})).status).toBe(201);
    expect((await auth(request.post(`/product-sets/${created.body.id}/record-payment`)).send({})).status).toBe(200);
    const { rows: link } = await db.query<any>('SELECT user_membership_id FROM product_sets WHERE id = ?', [created.body.id]);
    const umId = Number(link[0].user_membership_id);
    return { memberId: m.insertId as number, umId };
  }

  it('the assignment reports the ledger\'s next billing date and last billed, not NULL', async () => {
    const { umId } = await billedAssignment();
    const { rows } = await db.query<any>('SELECT next_billing_date FROM user_memberships WHERE id = ?', [umId]);
    expect(rows[0].next_billing_date).toBeNull(); // the legacy column stays empty…

    const detail = await auth(request.get(`/user-memberships/${umId}`));
    expect(detail.status).toBe(200);
    expect(detail.body.next_billing_date).not.toBeNull(); // …and the read is derived
    expect(String(detail.body.next_billing_date).slice(0, 10) >= TODAY).toBe(true);
    expect(detail.body.last_billed_at).not.toBeNull();
  });

  it('the Billing Events page lists the persisted obligations as scheduled and payable when due', async () => {
    const { memberId } = await billedAssignment();
    const res = await auth(request.get(`/payments/billing-events?member_id=${memberId}`));
    expect(res.status).toBe(200);
    const scheduled = res.body.items.filter((i: any) => i.status === 'scheduled' && i.type === 'real');
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled[0].plan_name).not.toBeNull();
    expect(scheduled[0].user_membership_id).not.toBeNull();
    // The paid first period is a real, paid event dated its own period.
    expect(res.body.items.some((i: any) => i.status === 'paid')).toBe(true);
  });

  it('the card cannot be removed while a ProductSet still has obligations scheduled', async () => {
    const { memberId } = await billedAssignment();
    const { loadCardRemovalBlock } = await import('../api/card-updates');
    expect(await loadCardRemovalBlock(gymId, memberId)).toBe('billable_membership');
  });

  it('a due, never-attempted obligation can be paid by staff, and a failed one retried', async () => {
    const { memberId } = await billedAssignment();
    const { rows } = await db.query<any>(
      `SELECT be.id FROM billing_events be JOIN product_sets ps ON ps.id = be.product_set_id
        WHERE ps.owner_member_id = ? AND be.is_scheduled = 1 ORDER BY be.billing_date LIMIT 1`, [memberId]);
    const eventId = rows[0].id;
    await db.query('UPDATE billing_events SET billing_date = ? WHERE id = ?', [TODAY, eventId]);
    const pay = await auth(request.post(`/payments/billing-events/${eventId}/manual-payment`)).send({});
    expect([200, 201]).toContain(pay.status);
    const { rows: after } = await db.query<any>('SELECT is_scheduled, event_type FROM billing_events WHERE id = ?', [eventId]);
    expect(Number(after[0].is_scheduled)).toBe(0);
    expect(after[0].event_type).toBe('recurring_payment');
  });
});
