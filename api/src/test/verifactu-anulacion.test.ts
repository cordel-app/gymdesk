// #2648 stage 5 — an issued invoice's VERI*FACTU record is cancelled by a
// Registro de Anulación: chained after the gym's last record, refused where the
// rule says, never editing the invoice, reported beside each invoice and sent
// by the asynchronous pass. AEAT and the private bucket are mocked.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.COMPLIANCE_CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString('base64');

const stored = new Map<string, Buffer>();
vi.mock('../infra/private-storage', () => ({
  isPrivateStorageConfigured: () => true,
  putPrivateDocument: async (key: string, body: Buffer) => { stored.set(key, body); return key; },
  getPrivateDocument: async (key: string) => {
    const body = stored.get(key);
    if (!body) throw new Error('missing');
    return { body, contentType: 'application/octet-stream' };
  },
  privateObjectExists: async (key: string) => stored.has(key),
}));

const postToAeat = vi.fn();
vi.mock('../api/verifactu-aeat-client', async (orig) => ({
  ...(await orig<typeof import('../api/verifactu-aeat-client')>()),
  postToAeat: (...args: unknown[]) => postToAeat(...args),
}));

import { db } from '../infra/db';
import { anulacionHash } from '../domain/verifactu';
import { credentialEncryptionKey, encryptCredentialMaterial } from '../domain/credentialEncryption';
import { submitPendingVerifactuRecords } from '../api/verifactu-submission';
import type { VerifactuSoftware } from '../domain/verifactuXml';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, ensureTestProductSet,
  legacyAssignmentQuery, request,
} from './helpers';

const software: VerifactuSoftware = {
  producerName: 'Cordel Tech SL', producerNif: 'B12345678', name: 'Cordel Fitness', id: 'CF', version: '1.0',
};
const auth = (g: string, extra: Record<string, string> = {}) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': g, ...extra });

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

async function makeEvent(gymId: string, amount: string): Promise<number> {
  const { insertId: memberId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'VF Anul', ?)`,
    [gymId, `vfa-${Date.now()}-${Math.random()}@test.com`]);
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `VFA-${Date.now()}-${Math.random()}`]);
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

async function issue(gymId: string, amount = '29.99'): Promise<{ eventId: number; invoiceId: number }> {
  const eventId = await makeEvent(gymId, amount);
  const r = await request.post(`/payments/billing-events/${eventId}/invoices`).set(auth(gymId)).send({ invoice_type: 'simplified' });
  expect(r.status).toBe(201);
  return { eventId, invoiceId: r.body.id };
}

const cancel = (gymId: string, invoiceId: number, body: Record<string, unknown> = { reason: 'Issued by mistake' }) =>
  request.post(`/payments/invoices/${invoiceId}/verifactu/cancel`).set(auth(gymId)).send(body);

const records = async (gymId: string) =>
  (await db.query<any>('SELECT * FROM verifactu_records WHERE gym_id = ? ORDER BY chain_seq', [gymId])).rows;

let gymA = ''; let gymOff = '';
beforeAll(async () => {
  gymA = await createTestGym('VFA A');
  await createTestMembership(gymA, 'admin');
  await db.query("UPDATE gyms SET cif = '12345678Z', country_code = 'ES', legal_name = 'VFA A SL' WHERE id = ?", [gymA]);
  const { insertId: integrationId } = await db.query(
    `INSERT INTO compliance_integrations (gym_id, country_code, provider, integration_type, enabled, authorization_status)
     VALUES (?, 'ES', 'verifactu', 'invoice_reporting', 1, 'authorized')`, [gymA]);
  const key = `${gymA}/compliance/credentials/test.bin`;
  stored.set(key, encryptCredentialMaterial(credentialEncryptionKey()!, gymA, key, { pfx: Buffer.from('pfx'), passphrase: 'p' }));
  await db.query(
    `INSERT INTO compliance_credentials (gym_id, integration_id, credential_type, status, storage_reference, valid_from, expires_at)
     VALUES (?, ?, 'certificate', 'active', ?, UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP() + INTERVAL 1 YEAR)`,
    [gymA, integrationId, key]);

  gymOff = await createTestGym('VFA Off');
  await createTestMembership(gymOff, 'admin');
});

describe('VERI*FACTU Anulación of an issued invoice', () => {
  it('writes one Anulación chained after the Alta, leaves the invoice as it was and reports both records', async () => {
    const { eventId, invoiceId } = await issue(gymA);
    const before = (await db.query<any>('SELECT * FROM invoices WHERE id = ?', [invoiceId])).rows[0];
    const offered = await request.get(`/payments/billing-events/${eventId}/invoices`).set(auth(gymA));
    expect(offered.body.invoices[0].can_cancel_verifactu).toBe(true);

    const r = await cancel(gymA, invoiceId);
    expect(r.status).toBe(201);
    expect(r.body.verifactu.anulacion.submission_status).toBe('pending');

    const [alta, anul] = await records(gymA);
    expect(anul).toMatchObject({
      record_type: 'anulacion', invoice_id: invoiceId, chain_seq: 2, previous_record_id: alta.id,
      previous_record_hash: alta.record_hash, invoice_number: alta.invoice_number,
      invoice_issue_date: alta.invoice_issue_date, issuer_nif: '12345678Z', invoice_total: null,
    });
    expect(anul.record_hash).toBe(anulacionHash({
      issuerNif: alta.issuer_nif, invoiceNumber: alta.invoice_number, issueDate: alta.invoice_issue_date,
      previousHash: alta.record_hash, generatedAt: anul.generated_at,
    }));
    expect((await db.query<any>('SELECT * FROM invoices WHERE id = ?', [invoiceId])).rows[0]).toEqual(before);

    const list = await request.get(`/payments/billing-events/${eventId}/invoices`).set(auth(gymA));
    expect(list.status).toBe(200);
    const inv = list.body.invoices[0];
    expect(inv.verifactu.alta.record_type).toBe('alta');
    expect(inv.verifactu.anulacion.record_type).toBe('anulacion');
    expect(inv.can_cancel_verifactu).toBe(false);
    expect(JSON.stringify(list.body)).not.toMatch(/hash_input|request_xml|storage_reference/);

    const again = await cancel(gymA, invoiceId);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('verifactu_already_cancelled');
    expect(await records(gymA)).toHaveLength(2);
  });

  it('refuses a rectified invoice, a gym with VeriFactu off and a missing reason, writing nothing', async () => {
    const { invoiceId } = await issue(gymA);
    const rect = await request.post(`/payments/invoices/${invoiceId}/rectify`).set(auth(gymA)).send({ reason: 'Wrong amount' });
    expect(rect.status).toBe(201);
    const n = (await records(gymA)).length;
    const refused = await cancel(gymA, invoiceId);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('verifactu_invoice_rectified');
    expect((await cancel(gymA, invoiceId, {})).status).toBe(400);
    expect(await records(gymA)).toHaveLength(n);

    const off = await issue(gymOff);
    const r = await cancel(gymOff, off.invoiceId);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('verifactu_disabled');
  });

  it('is tenant-scoped and admin-only', async () => {
    const { invoiceId } = await issue(gymA);
    expect((await cancel(gymOff, invoiceId)).status).toBe(404);
    // Front Desk writes PAYMENTS but is not the gym admin.
    const gymFd = await createTestGym('VFA FD');
    await createTestMembership(gymFd, 'front_desk');
    const fd = await issue(gymFd);
    const r = await cancel(gymFd, fd.invoiceId);
    expect(r.status).toBe(403);
    expect((await request.post(`/payments/invoices/${invoiceId}/verifactu/cancel`).send({ reason: 'x' })).status).toBe(401);
  });

  it('is sent by the asynchronous pass in chain order, its answer told apart from the Alta\'s', async () => {
    postToAeat.mockImplementation(async (_e: string, xml: string) => {
      const lines = [...xml.matchAll(/<sum1:(RegistroAlta|RegistroAnulacion)>.*?<sum1:(?:NumSerieFactura|NumSerieFacturaAnulada)>([^<]+)</g)]
        .map((m) => `<r:RespuestaLinea><r:IDFactura><i:NumSerieFactura>${m[2]}</i:NumSerieFactura></r:IDFactura><r:Operacion><i:TipoOperacion>${m[1] === 'RegistroAlta' ? 'Alta' : 'Anulacion'}</i:TipoOperacion></r:Operacion><r:EstadoRegistro>Correcto</r:EstadoRegistro></r:RespuestaLinea>`).join('');
      return { status: 200, body: `<e:Envelope xmlns:e="e"><e:Body><r:RespuestaRegFactuSistemaFacturacion xmlns:r="r" xmlns:i="i"><r:CSV>CSV-9</r:CSV><r:TiempoEsperaEnvio>60</r:TiempoEsperaEnvio>${lines}</r:RespuestaRegFactuSistemaFacturacion></e:Body></e:Envelope>` };
    });
    const s = await submitPendingVerifactuRecords({ software });
    expect(s.failures).toEqual([]);
    expect(postToAeat.mock.calls.some((c) => (c[1] as string).includes('<sum1:RegistroAnulacion>'))).toBe(true);
    const all = await records(gymA);
    expect(all.every((r) => r.submission_status === 'accepted')).toBe(true);
    expect(all.filter((r) => r.record_type === 'anulacion')).toHaveLength(1);
  });
});
