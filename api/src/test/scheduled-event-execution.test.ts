import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';

const provider = vi.hoisted(() => ({
  next: { success: true, providerRef: 'ref', providerStatus: 'SUCCEEDED' } as any,
  throws: false,
  calls: [] as Array<{ orderId: string; amount: number }>,
}));
vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({
    executeRecurring: async (p: { orderId: string; amount: number }) => {
      provider.calls.push(p);
      if (provider.throws) throw new Error('timeout');
      return provider.next;
    },
  }),
}));

import { executeDueScheduledEvents } from '../api/scheduled-event-execution';

let gymId: string;
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();

async function setup(opts: { card?: boolean; amount?: number; setStatus?: string; date?: string } = {}) {
  const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'M', `see-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`]);
  const s = await db.query(
    `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at) VALUES (?, ?, ?, ?)`,
    [gymId, m.insertId, opts.setStatus ?? 'active', YESTERDAY]);
  await db.query('UPDATE product_sets SET root_product_set_id = id WHERE id = ?', [s.insertId]);
  if (opts.card !== false) {
    await db.query(
      `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id) VALUES (?, ?, 'monei', 'tok', 'seq')`,
      [gymId, m.insertId]);
  }
  const e = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, product_set_id, billing_date, is_scheduled)
     VALUES (?, ?, 'charge_created', 'system', ?, ?, ?, 1)`,
    [gymId, m.insertId, opts.amount ?? 25, s.insertId, opts.date ?? TODAY]);
  return { memberId: m.insertId, eventId: e.insertId };
}
async function event(id: number) {
  const { rows } = await db.query<any>('SELECT event_type, is_scheduled FROM billing_events WHERE id = ?', [id]);
  return rows[0];
}
async function attempts(id: number) {
  const { rows } = await db.query<any>(
    'SELECT attempt, status, method, provider_status, provider_ref FROM payment_requests WHERE billing_event_id = ? ORDER BY attempt', [id]);
  return rows;
}

beforeAll(async () => {
  gymId = await createTestGym('Scheduled exec gym');
  await db.query("INSERT IGNORE INTO charge_types (code, name, is_system) VALUES ('membership_fee','Membership Fee',1)").catch(() => {});
});
afterEach(() => { provider.next = { success: true, providerRef: 'ref', providerStatus: 'SUCCEEDED' }; provider.throws = false; provider.calls = []; });
afterAll(async () => {
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('executing persisted Billing Events (#1325 PR 2c)', () => {
  it('charges a due scheduled event from its own amount and records the raw provider status', async () => {
    const { eventId } = await setup({ amount: 25 });
    const s = await executeDueScheduledEvents({ today: TODAY });
    expect(s.succeeded).toBeGreaterThanOrEqual(1);
    expect(provider.calls.some((c) => c.amount === 2500)).toBe(true);
    expect(await event(eventId)).toMatchObject({ event_type: 'recurring_payment' });
    expect(Number((await event(eventId)).is_scheduled)).toBe(0);
    expect(await attempts(eventId)).toEqual([expect.objectContaining({ attempt: 1, status: 'completed', provider_status: 'SUCCEEDED', method: 'provider' })]);
  });

  it('is idempotent: a second pass the same day charges nothing', async () => {
    const { eventId } = await setup();
    await executeDueScheduledEvents({ today: TODAY });
    const callsAfterFirst = provider.calls.length;
    await executeDueScheduledEvents({ today: TODAY });
    expect(provider.calls.length).toBe(callsAfterFirst);
    expect((await attempts(eventId)).length).toBe(1);
  });

  it('waives a zero amount without calling the provider', async () => {
    const { eventId } = await setup({ amount: 0 });
    await executeDueScheduledEvents({ today: TODAY });
    expect(provider.calls.length).toBe(0);
    expect((await event(eventId)).event_type).toBe('waived_billing');
    expect(await attempts(eventId)).toEqual([expect.objectContaining({ method: 'waive', status: 'completed' })]);
  });

  it('attempts nothing without a stored card and leaves the event scheduled and past due', async () => {
    const { eventId } = await setup({ card: false, date: YESTERDAY });
    await executeDueScheduledEvents({ today: TODAY });
    expect(provider.calls.length).toBe(0);
    expect(Number((await event(eventId)).is_scheduled)).toBe(1);
    expect((await attempts(eventId)).length).toBe(0);
  });

  it('keeps a PENDING_PROCESSING outcome unresolved, never a failure, and refuses to charge it again', async () => {
    provider.next = { success: false, providerRef: 'ref', providerStatus: 'PENDING_PROCESSING' };
    const { eventId } = await setup();
    await executeDueScheduledEvents({ today: TODAY });
    const rows = await attempts(eventId);
    expect(rows[0]).toMatchObject({ status: 'pending', provider_status: 'PENDING_PROCESSING' });
    expect((await event(eventId)).event_type).toBe('charge_created');
    // Even on a later day (simulated by clearing today's date), the guard refuses.
    await db.query('UPDATE payment_requests SET created_at = DATE_SUB(created_at, INTERVAL 1 DAY) WHERE billing_event_id = ?', [eventId]);
    await db.query("UPDATE billing_events SET event_type = 'failed_billing' WHERE id = ?", [eventId]);
    const before = provider.calls.length;
    await executeDueScheduledEvents({ today: TODAY });
    expect(provider.calls.length).toBe(before);
  });

  it('a provider timeout leaves an attempt with no status — unknown, not failed', async () => {
    provider.throws = true;
    const { eventId } = await setup();
    const s = await executeDueScheduledEvents({ today: TODAY });
    expect(s.failed).toBeGreaterThanOrEqual(1);
    const rows = await attempts(eventId);
    expect(rows[0]).toMatchObject({ status: 'pending', provider_status: null });
  });

  it('a rejection becomes failed_billing, retried on a later day, then stops after two failed days', async () => {
    provider.next = { success: false, providerRef: 'r1', providerStatus: 'FAILED', errorCode: 'E', errorMessage: 'declined' };
    const { eventId } = await setup();
    await executeDueScheduledEvents({ today: TODAY });
    expect((await event(eventId)).event_type).toBe('failed_billing');

    // Same day: no second attempt.
    await executeDueScheduledEvents({ today: TODAY });
    expect((await attempts(eventId)).length).toBe(1);

    // Next day: one more attempt.
    await db.query('UPDATE payment_requests SET created_at = DATE_SUB(created_at, INTERVAL 1 DAY) WHERE billing_event_id = ?', [eventId]);
    await executeDueScheduledEvents({ today: TODAY });
    expect((await attempts(eventId)).map((a: any) => a.attempt)).toEqual([1, 2]);

    // Two failed days: the automatic retries stop.
    await db.query('UPDATE payment_requests SET created_at = DATE_SUB(created_at, INTERVAL 1 DAY) WHERE billing_event_id = ? AND attempt = 2', [eventId]);
    await db.query('UPDATE payment_requests SET created_at = DATE_SUB(created_at, INTERVAL 2 DAY) WHERE billing_event_id = ? AND attempt = 1', [eventId]);
    const before = provider.calls.length;
    await executeDueScheduledEvents({ today: TODAY });
    expect(provider.calls.length).toBe(before);
  });

  it('pauses the projected assignment after MAX_FAILED_DAYS failed days, with an audit row (#785)', async () => {
    provider.next = { success: false, providerRef: 'r1', providerStatus: 'FAILED', errorCode: 'E', errorMessage: 'declined' };
    const { eventId, memberId } = await setup();
    const { rows: ps } = await db.query<any>('SELECT product_set_id FROM billing_events WHERE id = ?', [eventId]);
    const um = await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, status, starts_at, base_price) VALUES (?, ?, 'active', ?, 0)`,
      [gymId, memberId, YESTERDAY]);
    await db.query('UPDATE product_sets SET user_membership_id = ? WHERE id = ?', [um.insertId, ps[0].product_set_id]);

    await executeDueScheduledEvents({ today: TODAY });
    let status = (await db.query<any>('SELECT status FROM user_memberships WHERE id = ?', [um.insertId])).rows[0].status;
    expect(status).toBe('active'); // one failed day: not yet

    await db.query('UPDATE payment_requests SET created_at = DATE_SUB(created_at, INTERVAL 1 DAY) WHERE billing_event_id = ?', [eventId]);
    const s = await executeDueScheduledEvents({ today: TODAY });
    expect(s.paused).toBe(1);
    status = (await db.query<any>('SELECT status FROM user_memberships WHERE id = ?', [um.insertId])).rows[0].status;
    expect(status).toBe('paused');
    const { rows: audit } = await db.query<any>(
      `SELECT action, previous_values, new_values, source FROM audit_logs
        WHERE gym_id = ? AND entity_type = 'user_membership' AND entity_id = ?`, [gymId, String(um.insertId)]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'status_change', source: 'system' });
    const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
    expect(parse(audit[0].previous_values).status).toBe('active');
    expect(parse(audit[0].new_values).status).toBe('paused');
    // No status_changed ledger row any more (A4).
    const { rows: sc } = await db.query<any>("SELECT id FROM billing_events WHERE gym_id = ? AND event_type = 'status_changed'", [gymId]);
    expect(sc).toHaveLength(0);
  });

  it('only executes events of an Active ProductSet', async () => {
    const { eventId } = await setup({ setStatus: 'superseded' });
    await executeDueScheduledEvents({ today: TODAY });
    expect((await attempts(eventId)).length).toBe(0);
  });
});
