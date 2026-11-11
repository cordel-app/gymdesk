// #2648 stage 2 — an invoice issued by a gym with VeriFactu enabled writes
// exactly one Alta record, chained per gym, in the issuing transaction.
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

import { inflateSync } from 'node:zlib';
import { db } from '../infra/db';
import { altaHash, altaHashString } from '../domain/verifactu';
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

/** Whether a stored PDF prints the VERI*FACTU legend (#2648 stage 3). */
function printsVerifactuLegend(pdf: Buffer): boolean {
  const raw = pdf.toString('latin1');
  const legend = `<${Buffer.from('VERI*FACTU', 'latin1').toString('hex').toUpperCase()}>`;
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    try {
      if (inflateSync(pdf.subarray(start, raw.indexOf('endstream', start))).toString('latin1').includes(legend)) return true;
    } catch { /* not a flate stream */ }
  }
  return false;
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

let gymOn = ''; let gymOff = ''; let gymBadNif = ''; let gymOther = '';

beforeAll(async () => {
  gymOn = await createTestGym('VF On'); gymOff = await createTestGym('VF Off');
  gymBadNif = await createTestGym('VF Bad NIF'); gymOther = await createTestGym('VF Other');
  for (const g of [gymOn, gymOff, gymBadNif, gymOther]) await createTestMembership(g, 'admin');
  await enableVerifactu(gymOn, '12345678Z');
  await enableVerifactu(gymOther, '87654321X');
  await enableVerifactu(gymBadNif, 'not-a-nif');
});

describe('VERI*FACTU Alta records at invoice issue', () => {
  it('writes no record for a gym without an enabled VeriFactu integration', async () => {
    const ev = await makeEvent(gymOff);
    const r = await request.post(`/payments/billing-events/${ev}/invoices`).set(auth(gymOff)).send({ invoice_type: 'simplified' });
    expect(r.status).toBe(201);
    expect(await records(gymOff)).toHaveLength(0);
    expect(printsVerifactuLegend(await storedPdf(gymOff, r.body.id))).toBe(false);
  });

  let firstInvoice = 0;
  it('writes one chained Alta per issued invoice, idempotent on retry', async () => {
    const ev1 = await makeEvent(gymOn, '29.99');
    const a = await request.post(`/payments/billing-events/${ev1}/invoices`).set(auth(gymOn)).send({ invoice_type: 'simplified' });
    expect(a.status).toBe(201);
    firstInvoice = a.body.id;
    const again = await request.post(`/payments/billing-events/${ev1}/invoices`).set(auth(gymOn)).send({ invoice_type: 'simplified' });
    expect(again.status).toBe(200);

    const ev2 = await makeEvent(gymOn, '50.00');
    const b = await request.post(`/payments/billing-events/${ev2}/invoices`).set(auth(gymOn)).send({
      invoice_type: 'full', customer_name: 'ACME SL', customer_tax_id: 'B12345678', customer_address: 'Calle 1',
    });
    expect(b.status).toBe(201);

    // #2648 stage 3: both new PDFs print the VERI*FACTU QR and legend.
    expect(printsVerifactuLegend(await storedPdf(gymOn, a.body.id))).toBe(true);
    expect(printsVerifactuLegend(await storedPdf(gymOn, b.body.id))).toBe(true);

    const rows = await records(gymOn);
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first).toMatchObject({
      invoice_id: firstInvoice, record_type: 'alta', chain_seq: 1, issuer_nif: '12345678Z',
      invoice_number: a.body.fiscal_number, invoice_kind: 'F2', invoice_total: '29.99',
      previous_record_id: null, previous_record_hash: null, recipient_tax_id: null, submission_status: 'pending',
    });
    expect(first.invoice_issue_date).toMatch(/^\d{2}-\d{2}-\d{4}$/);
    expect(second).toMatchObject({
      chain_seq: 2, invoice_kind: 'F1', invoice_total: '50.00', recipient_tax_id: 'B12345678',
      previous_record_id: first.id, previous_record_hash: first.record_hash,
    });
    // The stored fields are exactly what the huella was computed over.
    for (const r of rows) {
      const input = {
        issuerNif: r.issuer_nif, invoiceNumber: r.invoice_number, issueDate: r.invoice_issue_date,
        invoiceKind: r.invoice_kind, taxTotal: r.tax_total, total: r.invoice_total,
        previousHash: r.previous_record_hash, generatedAt: r.generated_at,
      };
      expect(altaHashString(input)).toBe(r.hash_input);
      expect(altaHash(input)).toBe(r.record_hash);
    }
    const { rows: events } = await db.query<any>(
      "SELECT * FROM compliance_audit_events WHERE gym_id = ? AND event_type = 'verifactu_record_generated'", [gymOn]);
    expect(events).toHaveLength(2);
  });

  it('a rectifying invoice is its own Alta (R5 for a simplified original), negated', async () => {
    const r = await request.post(`/payments/invoices/${firstInvoice}/rectify`).set(auth(gymOn)).send({ reason: 'wrong amount' });
    expect(r.status).toBe(201);
    const rows = await records(gymOn);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({
      invoice_id: r.body.id, chain_seq: 3, invoice_kind: 'R5', invoice_total: '-29.99',
      previous_record_hash: rows[1].record_hash,
    });
    expect(printsVerifactuLegend(await storedPdf(gymOn, r.body.id))).toBe(true);
  });

  it('keeps an independent chain per gym and never forks under concurrent issues', async () => {
    const evs = await Promise.all([makeEvent(gymOther), makeEvent(gymOther), makeEvent(gymOther)]);
    const results = await Promise.all(evs.map((ev) =>
      request.post(`/payments/billing-events/${ev}/invoices`).set(auth(gymOther)).send({ invoice_type: 'simplified' })));
    expect(results.map((x) => x.status)).toEqual([201, 201, 201]);
    const rows = await records(gymOther);
    expect(rows.map((x: any) => x.chain_seq)).toEqual([1, 2, 3]);
    expect(rows[0].previous_record_hash).toBeNull();
    expect(rows[1].previous_record_hash).toBe(rows[0].record_hash);
    expect(rows[2].previous_record_hash).toBe(rows[1].record_hash);
  });

  it('refuses to issue (409, nothing written) when the gym tax number is not a Spanish NIF', async () => {
    const ev = await makeEvent(gymBadNif);
    const r = await request.post(`/payments/billing-events/${ev}/invoices`).set(auth(gymBadNif)).send({ invoice_type: 'simplified' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('verifactu_issuer_nif_invalid');
    const { rows } = await db.query<any>('SELECT id FROM invoices WHERE gym_id = ?', [gymBadNif]);
    expect(rows).toHaveLength(0);
    expect(await records(gymBadNif)).toHaveLength(0);
  });
});
