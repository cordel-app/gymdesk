// #2648 stage 6 — the simplified invoice is issued by the system: a scheduled
// obligation on its billing date (paid or not), any other event when it is
// paid. Never twice for one event; a later payment keeps the original number.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const stored = new Map<string, Buffer>();
vi.mock('../infra/private-storage', () => ({
  isPrivateStorageConfigured: () => true,
  putPrivateDocument: async (key: string, body: Buffer) => {
    if (stored.has(key)) throw new Error('already exists');
    stored.set(key, body); return key;
  },
  getPrivateDocument: async (key: string) => ({ body: stored.get(key)!, contentType: 'application/pdf' }),
  privateObjectExists: async (key: string) => stored.has(key),
}));

import { db } from '../infra/db';
import { issueDueSimplifiedInvoices } from '../api/billing-invoices';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, ensureTestProductSet, legacyAssignmentQuery,
} from './helpers';

const log = { warn: () => {} };
const today = () => new Date().toISOString().slice(0, 10);
function daysFrom(base: string, n: number): string {
  const d = new Date(`${base}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
const auth = (g: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': g });

let gymId = ''; let otherGymId = '';
let memberId = 0; let setId = 0; let scheduleId = 0; let membershipId = 0; let ct = 0;

async function invoicesOf(eventId: number) {
  const { rows } = await db.query<any>('SELECT * FROM invoices WHERE billing_event_id = ? ORDER BY id', [eventId]);
  return rows;
}

async function event(opts: {
  billingDate?: string | null; scheduled?: boolean; type?: string; amount?: string; cancelled?: boolean;
}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO billing_events
       (gym_id, member_id, product_set_id, schedule_id, event_type, amount, charge_type_id, source, billing_date,
        is_scheduled, cancelled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'system', ?, ?, ?)`,
    [gymId, memberId, setId, opts.scheduled === false ? null : scheduleId, opts.type ?? 'charge_created',
      opts.amount ?? '30.00', ct, opts.billingDate === undefined ? today() : opts.billingDate,
      opts.scheduled === false ? 0 : 1, opts.cancelled ? new Date() : null],
  );
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('AutoInv Gym');
  otherGymId = await createTestGym('AutoInv Other');
  await createTestMembership(gymId, 'admin');
  const m = await db.query(`INSERT INTO members (gym_id, name, email) VALUES (?, 'Auto Inv', ?)`, [gymId, `autoinv-${Date.now()}@test.com`]);
  memberId = m.insertId;
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `AutoInv-Plan-${Date.now()}`]);
  membershipId = (await legacyAssignmentQuery(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', '2020-01-01', '30.00')`, [gymId, memberId, planId])).insertId;
  setId = await ensureTestProductSet(gymId, memberId, membershipId);
  const sch = await db.query(
    `INSERT INTO product_set_schedules (gym_id, opened_by_product_set_id, owner_member_id, schedule_key, anchor_date, cadence_interval, cadence_unit)
     SELECT ?, ?, owner_member_id, 'auto-inv', '2026-01-01', 1, 'month' FROM product_sets WHERE id = ?`, [gymId, setId, setId]);
  scheduleId = sch.insertId;
  const { rows } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee'");
  ct = rows[0].id;
});

afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('nightly pass: a scheduled obligation is invoiced on its billing date, paid or not', () => {
  let dueId = 0; let futureId = 0; let oldId = 0; let cancelledId = 0; let zeroId = 0;

  beforeAll(async () => {
    dueId = await event({});
    futureId = await event({ billingDate: daysFrom(today(), 1) });
    oldId = await event({ billingDate: daysFrom(today(), -30) });
    cancelledId = await event({ cancelled: true });
    zeroId = await event({ amount: '0.00' });
    await issueDueSimplifiedInvoices({ today: today(), log });
  });

  it('issues one simplified invoice, not paid, with its not-paid PDF', async () => {
    const inv = await invoicesOf(dueId);
    expect(inv).toHaveLength(1);
    expect(inv[0].invoice_type).toBe('simplified');
    expect(inv[0].status).toBe('issued');
    expect(inv[0].payment_status).toBe('not_paid');
    expect(inv[0].fiscal_number).toMatch(/^S-\d{4}-\d{4}$/);
    expect(inv[0].simplified_not_paid_pdf_key).toBeTruthy();
    expect(inv[0].created_by).toBe('System');
  });

  it('issues nothing before the billing date, for an old one, a cancelled event or a zero amount', async () => {
    for (const id of [futureId, oldId, cancelledId, zeroId]) expect(await invoicesOf(id)).toHaveLength(0);
  });

  it('a second pass issues nothing again', async () => {
    await issueDueSimplifiedInvoices({ today: today(), log });
    expect(await invoicesOf(dueId)).toHaveLength(1);
  });

  it('an event that already holds a complete invoice gets no simplified one', async () => {
    const id = await event({});
    const full = await request.post(`/payments/billing-events/${id}/invoices`).set(auth(gymId))
      .send({ invoice_type: 'full', customer_name: 'Acme', customer_tax_id: 'B12345678', customer_address: 'Street 1' });
    expect(full.status).toBe(201);
    await issueDueSimplifiedInvoices({ today: today(), log });
    expect((await invoicesOf(id)).map((r: any) => r.invoice_type)).toEqual(['full']);
  });

  it('paying the invoiced event later keeps its number and adds the paid representation', async () => {
    const before = (await invoicesOf(dueId))[0];
    // The charge was attempted and rejected; staff then take it in cash.
    await db.query("UPDATE billing_events SET event_type = 'failed_billing', is_scheduled = 0 WHERE id = ?", [dueId]);
    const res = await request.post(`/payments/billing-events/${dueId}/manual-payment`).set(auth(gymId)).send({ method: 'cash' });
    expect(res.status).toBe(201);
    await vi.waitFor(async () => {
      const inv = await invoicesOf(dueId);
      expect(inv[0].payment_status).toBe('paid');
    });
    const inv = await invoicesOf(dueId);
    expect(inv).toHaveLength(1);
    expect(inv[0].fiscal_number).toBe(before.fiscal_number);
    expect(new Date(inv[0].issued_at).getTime()).toBe(new Date(before.issued_at).getTime());
    expect(inv[0].simplified_paid_pdf_key).toBeTruthy();
  });
});

describe('any other event is invoiced when it is paid', () => {
  it('a non-scheduled event gets nothing from the nightly pass, and its simplified invoice once paid', async () => {
    const id = await event({ scheduled: false, type: 'failed_billing' });
    await issueDueSimplifiedInvoices({ today: today(), log });
    expect(await invoicesOf(id)).toHaveLength(0);
    const res = await request.post(`/payments/billing-events/${id}/manual-payment`).set(auth(gymId)).send({ method: 'card_terminal' });
    expect(res.status).toBe(201);
    await vi.waitFor(async () => expect(await invoicesOf(id)).toHaveLength(1));
    const inv = await invoicesOf(id);
    expect(inv[0].invoice_type).toBe('simplified');
    expect(inv[0].payment_status).toBe('paid');
    expect(inv[0].simplified_paid_pdf_key).toBeTruthy();
    expect(inv[0].simplified_not_paid_pdf_key).toBeNull();
  });
});

describe('GET /payments/billing-events: the ⋮ menu document flags', () => {
  it('reports receipt eligibility and whether a complete invoice exists', async () => {
    const unpaid = await event({ scheduled: false, type: 'failed_billing' });
    const withFull = await event({ scheduled: false, type: 'failed_billing' });
    await request.post(`/payments/billing-events/${withFull}/invoices`).set(auth(gymId))
      .send({ invoice_type: 'full', customer_name: 'Acme', customer_tax_id: 'B12345678', customer_address: 'Street 1' });
    const res = await request.get(`/payments/billing-events?member_id=${memberId}`).set(auth(gymId));
    expect(res.status).toBe(200);
    const items: any[] = res.body.items ?? res.body.rows ?? res.body;
    const a = items.find((r) => r.id === unpaid);
    const b = items.find((r) => r.id === withFull);
    expect(a).toMatchObject({ can_issue_receipt: false, has_full_invoice: false, receipt_number: null });
    expect(b.has_full_invoice).toBe(true);
  });

  it('does not leak another gym\'s events', async () => {
    await createTestMembership(otherGymId, 'admin', 'test-user-id');
    const res = await request.get(`/payments/billing-events?member_id=${memberId}`).set(auth(otherGymId));
    const items: any[] = res.body.items ?? res.body.rows ?? res.body;
    expect(items).toHaveLength(0);
  });
});
