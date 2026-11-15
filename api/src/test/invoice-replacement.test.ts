// #2648 stage 7 — a complete invoice requested for a transaction that already
// has an issued simplified invoice replaces it (F3) instead of invoicing it twice.
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
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, ensureTestProductSet, legacyAssignmentQuery,
} from './helpers';

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

const auth = (g: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': g });

async function makeEvent(gymId: string, amount = '29.99'): Promise<number> {
  const { insertId: memberId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'VF Member', ?)`,
    [gymId, `vf-${Date.now()}-${Math.random()}@test.com`]);
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `VF-Plan-${Date.now()}-${Math.random()}`]);
  const { insertId: umId } = await legacyAssignmentQuery(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', '2020-01-01', ?)`, [gymId, memberId, planId, amount]);
  const { rows: ct } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee'");
  const r = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, product_set_id, event_type, charge_type_id, source, actor_user_id, amount)
     VALUES (?, ?, ?, 'payment_recorded', ?, 'system', NULL, ?)`,
    [gymId, memberId, await ensureTestProductSet(gymId, memberId, umId), ct[0].id, amount]);
  return r.insertId;
}

async function enableVerifactu(gymId: string, cif: string) {
  await db.query("UPDATE gyms SET cif = ?, country_code = 'ES' WHERE id = ?", [cif, gymId]);
  await db.query(
    `INSERT INTO compliance_integrations (gym_id, country_code, provider, integration_type, enabled)
     VALUES (?, 'ES', 'verifactu', 'invoice_reporting', 1)`, [gymId]);
}

async function storedPdf(gymId: string, invoiceId: number): Promise<Buffer> {
  const r = await request.get(`/payments/invoices/${invoiceId}/pdf`).set(auth(gymId))
    .buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(r.status).toBe(200);
  return r.body as Buffer;
}

const records = async (gymId: string) =>
  (await db.query<any>('SELECT * FROM verifactu_records WHERE gym_id = ? ORDER BY chain_seq', [gymId])).rows;

let gymOn = ''; let gymOff = '';

beforeAll(async () => {
  gymOn = await createTestGym('Replace On'); gymOff = await createTestGym('Replace Off');
  for (const g of [gymOn, gymOff]) await createTestMembership(g, 'admin');
  await enableVerifactu(gymOn, '12345678Z');
});

const customer = { customer_name: 'ACME SL', customer_tax_id: 'B12345678', customer_address: 'Calle 1' };
const issue = (gymId: string, ev: number, body: object) =>
  request.post(`/payments/billing-events/${ev}/invoices`).set(auth(gymId)).send(body);
const list = async (gymId: string, ev: number) =>
  (await request.get(`/payments/billing-events/${ev}/invoices`).set(auth(gymId))).body.invoices as any[];

describe('#2648 stage 7 — a complete invoice replaces the simplified one', () => {
  it('issues an F3 naming the simplified invoice, which is left unchanged', async () => {
    const ev = await makeEvent(gymOn);
    const s = await issue(gymOn, ev, { invoice_type: 'simplified' });
    expect(s.status).toBe(201);
    const { rows: before } = await db.query<any>('SELECT * FROM invoices WHERE id = ?', [s.body.id]);

    const f = await issue(gymOn, ev, { invoice_type: 'full', ...customer });
    expect(f.status).toBe(201);
    expect(f.body.replaces_invoice_id).toBe(s.body.id);

    const { rows: after } = await db.query<any>('SELECT * FROM invoices WHERE id = ?', [s.body.id]);
    expect(after[0]).toEqual(before[0]);

    const recs = await records(gymOn);
    const alta = recs.find((r: any) => r.invoice_id === f.body.id);
    expect(alta).toMatchObject({ record_type: 'alta', invoice_kind: 'F3', recipient_tax_id: 'B12345678' });
    // The simplified one keeps its own F2 record: nothing is rewritten.
    expect(recs.find((r: any) => r.invoice_id === s.body.id)).toMatchObject({ invoice_kind: 'F2' });

    const rows = await list(gymOn, ev);
    expect(rows.find((r) => r.id === s.body.id)).toMatchObject({ replaced_by_invoice_id: f.body.id, can_cancel_verifactu: false });
    expect(rows.find((r) => r.id === f.body.id)).toMatchObject({ replaces_invoice_id: s.body.id, replaced_by_invoice_id: null });

    // A second request returns the issued complete invoice; nothing new.
    const again = await issue(gymOn, ev, { invoice_type: 'full', ...customer });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(f.body.id);
    expect((await records(gymOn)).filter((r: any) => r.invoice_id === f.body.id)).toHaveLength(1);
  });

  it('refuses to rectify or cancel the record of a replaced simplified invoice', async () => {
    const ev = await makeEvent(gymOn);
    const s = await issue(gymOn, ev, { invoice_type: 'simplified' });
    await issue(gymOn, ev, { invoice_type: 'full', ...customer });
    const rect = await request.post(`/payments/invoices/${s.body.id}/rectify`).set(auth(gymOn)).send({ reason: 'x' });
    expect(rect.status).toBe(409);
    const cancel = await request.post(`/payments/invoices/${s.body.id}/verifactu/cancel`).set(auth(gymOn)).send({ reason: 'x' });
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe('verifactu_invoice_replaced');
  });

  it('issues an ordinary F1 when the event has no standing simplified invoice', async () => {
    const ev = await makeEvent(gymOn);
    const f = await issue(gymOn, ev, { invoice_type: 'full', ...customer });
    expect(f.status).toBe(201);
    expect(f.body.replaces_invoice_id).toBeNull();
    expect((await records(gymOn)).find((r: any) => r.invoice_id === f.body.id)).toMatchObject({ invoice_kind: 'F1' });

    // A rectified simplified invoice no longer stands: the complete one is F1.
    const ev2 = await makeEvent(gymOn);
    const s = await issue(gymOn, ev2, { invoice_type: 'simplified' });
    expect((await request.post(`/payments/invoices/${s.body.id}/rectify`).set(auth(gymOn)).send({ reason: 'x' })).status).toBe(201);
    const f2 = await issue(gymOn, ev2, { invoice_type: 'full', ...customer });
    expect(f2.body.replaces_invoice_id).toBeNull();
  });

  it('links the replacement with VeriFactu off too, and prints the replaced number on the PDF', async () => {
    const ev = await makeEvent(gymOff);
    const s = await issue(gymOff, ev, { invoice_type: 'simplified' });
    const f = await issue(gymOff, ev, { invoice_type: 'full', ...customer });
    expect(f.body.replaces_invoice_id).toBe(s.body.id);
    expect(await records(gymOff)).toHaveLength(0);
    const pdf = await storedPdf(gymOff, f.body.id);
    expect(pdf.length).toBeGreaterThan(0);
  });

  it('a replacement of another gym is invisible (tenant isolation)', async () => {
    const ev = await makeEvent(gymOn);
    expect((await request.get(`/payments/billing-events/${ev}/invoices`).set(auth(gymOff))).status).toBe(404);
  });
});
