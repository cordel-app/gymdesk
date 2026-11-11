// #2648 stage 4 — pending VERI*FACTU records are submitted to the AEAT
// asynchronously, in chain order, with the gym's own certificate, and every
// answer (accepted, rejected, duplicate, fault, no answer) is persisted without
// losing or duplicating a record. AEAT itself and the private bucket are the
// two things mocked; the database and the issuing routes are real.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { credentialEncryptionKey, encryptCredentialMaterial } from '../domain/credentialEncryption';
import { submitPendingVerifactuRecords } from '../api/verifactu-submission';
import { AeatTransportError } from '../api/verifactu-aeat-client';
import type { VerifactuSoftware } from '../domain/verifactuXml';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, ensureTestProductSet,
  legacyAssignmentQuery, request,
} from './helpers';

const software: VerifactuSoftware = {
  producerName: 'Cordel Tech SL', producerNif: 'B12345678', name: 'Cordel Fitness', id: 'CF', version: '1.0',
};
const auth = (g: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': g });

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

async function makeEvent(gymId: string, amount: string): Promise<number> {
  const { insertId: memberId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'VF Sub', ?)`,
    [gymId, `vfs-${Date.now()}-${Math.random()}@test.com`]);
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `VFS-${Date.now()}-${Math.random()}`]);
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

async function issue(gymId: string, amount: string, body: Record<string, unknown> = { invoice_type: 'simplified' }) {
  const ev = await makeEvent(gymId, amount);
  const r = await request.post(`/payments/billing-events/${ev}/invoices`).set(auth(gymId)).send(body);
  expect(r.status).toBe(201);
  return r.body;
}

async function setupGym(label: string, cif: string): Promise<string> {
  const gymId = await createTestGym(label);
  await createTestMembership(gymId, 'admin');
  await db.query("UPDATE gyms SET cif = ?, country_code = 'ES', legal_name = ? WHERE id = ?", [cif, `${label} SL`, gymId]);
  const { insertId: integrationId } = await db.query(
    `INSERT INTO compliance_integrations (gym_id, country_code, provider, integration_type, enabled, authorization_status)
     VALUES (?, 'ES', 'verifactu', 'invoice_reporting', 1, 'authorized')`, [gymId]);
  const key = `${gymId}/compliance/credentials/test.bin`;
  stored.set(key, encryptCredentialMaterial(credentialEncryptionKey()!, gymId, key, { pfx: Buffer.from('pfx'), passphrase: 'secret-pass' }));
  await db.query(
    `INSERT INTO compliance_credentials (gym_id, integration_id, credential_type, status, storage_reference, valid_from, expires_at)
     VALUES (?, ?, 'certificate', 'active', ?, UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP() + INTERVAL 1 YEAR)`,
    [gymId, integrationId, key]);
  return gymId;
}

const records = async (gymId: string) =>
  (await db.query<any>('SELECT * FROM verifactu_records WHERE gym_id = ? ORDER BY chain_seq', [gymId])).rows;

/** Lets the next pass run now: the gym's AEAT wait has elapsed and every retry is due. */
async function elapse(gymId: string) {
  await db.query('UPDATE verifactu_submissions SET finished_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE gym_id = ?', [gymId]);
  await db.query("UPDATE verifactu_records SET next_attempt_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE gym_id = ? AND submission_status = 'retry_pending'", [gymId]);
}

/** The invoice ids (NumSerieFactura) of a request, in order. */
function requestedNumbers(xml: string): string[] {
  return [...xml.matchAll(/<sum1:RegistroAlta>.*?<sum1:NumSerieFactura>([^<]+)<\/sum1:NumSerieFactura>/g)].map((m) => m[1]);
}

/** An AEAT answer for a request: one line per record, `Correcto` unless overridden. */
function aeatAnswer(xml: string, states: Record<string, string> = {}, extra = ''): string {
  const lines = requestedNumbers(xml).map((n) => `<tikR:RespuestaLinea><tikR:IDFactura><tik:NumSerieFactura>${n}</tik:NumSerieFactura></tikR:IDFactura>${states[n] ?? '<tikR:EstadoRegistro>Correcto</tikR:EstadoRegistro>'}</tikR:RespuestaLinea>`).join('');
  return `<env:Envelope xmlns:env="e"><env:Body><tikR:RespuestaRegFactuSistemaFacturacion xmlns:tikR="r" xmlns:tik="i"><tikR:CSV>CSV-123</tikR:CSV><tikR:TiempoEsperaEnvio>60</tikR:TiempoEsperaEnvio><tikR:EstadoEnvio>Correcto</tikR:EstadoEnvio>${lines}${extra}</tikR:RespuestaRegFactuSistemaFacturacion></env:Body></env:Envelope>`;
}

let gymA = ''; let gymB = '';
beforeAll(async () => {
  gymA = await setupGym('VFS A', '12345678Z');
  gymB = await setupGym('VFS B', '87654321X');
});
beforeEach(() => { postToAeat.mockReset(); });

describe('VERI*FACTU submission to the AEAT', () => {
  it('sends nothing while the integration is not authorized, and keeps the records pending', async () => {
    await db.query("UPDATE compliance_integrations SET authorization_status = 'pending' WHERE gym_id = ?", [gymA]);
    await issue(gymA, '29.99');
    const s = await submitPendingVerifactuRecords({ software });
    expect(s.blocked).toContainEqual({ gym_id: gymA, reason: 'not_authorized' });
    expect(postToAeat).not.toHaveBeenCalled();
    expect((await records(gymA)).map((r) => r.submission_status)).toEqual(['pending']);
    await db.query("UPDATE compliance_integrations SET authorization_status = 'authorized' WHERE gym_id = ?", [gymA]);
  });

  it('sends nothing without the software identification', async () => {
    const s = await submitPendingVerifactuRecords({ software: null });
    expect(s.blocked).toContainEqual({ gym_id: gymA, reason: 'software_not_configured' });
    expect(postToAeat).not.toHaveBeenCalled();
  });

  it('submits a gym\'s records in chain order, one taxpayer per batch, and persists AEAT\'s answer', async () => {
    await issue(gymA, '50.00', {
      invoice_type: 'full', customer_name: 'ACME SL', customer_tax_id: 'B12345678', customer_address: 'Calle 1',
    });
    await issue(gymB, '10.00');
    postToAeat.mockImplementation(async (_endpoint: string, xml: string) => ({ status: 200, body: aeatAnswer(xml) }));

    const s = await submitPendingVerifactuRecords({ software });
    expect(s.batches).toBe(2);
    expect(s.accepted).toBe(3);
    expect(postToAeat).toHaveBeenCalledTimes(2);

    const callA = postToAeat.mock.calls.find((c) => (c[1] as string).includes('<sum1:NIF>12345678Z</sum1:NIF>'))!;
    expect(callA[0]).toBe('https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP');
    expect(callA[2]).toMatchObject({ passphrase: 'secret-pass' });
    const xmlA = callA[1] as string;
    const rowsA = await records(gymA);
    expect(requestedNumbers(xmlA)).toEqual(rowsA.map((r) => r.invoice_number));
    expect(xmlA).not.toContain('87654321X');
    expect(xmlA).toContain('<sum1:PrimerRegistro>S</sum1:PrimerRegistro>');
    expect(xmlA).toContain(`<sum1:Huella>${rowsA[0].record_hash}</sum1:Huella></sum1:RegistroAnterior>`);
    expect(xmlA).toContain('<sum1:NombreRazon>ACME SL</sum1:NombreRazon><sum1:NIF>B12345678</sum1:NIF>');
    expect(xmlA).not.toContain('secret-pass');

    expect(rowsA.map((r) => [r.submission_status, r.aeat_csv, r.submission_attempts])).toEqual([
      ['accepted', 'CSV-123', 1], ['accepted', 'CSV-123', 1],
    ]);
    expect(rowsA.every((r) => r.accepted_at != null)).toBe(true);
    const { rows: subs } = await db.query<any>('SELECT * FROM verifactu_submissions WHERE gym_id = ?', [gymA]);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: 'accepted', http_status: 200, aeat_csv: 'CSV-123', record_count: 2, wait_seconds: 60 });
    expect(subs[0].request_xml).toBe(xmlA);
    const { rows: ev } = await db.query<any>(
      "SELECT status, metadata FROM compliance_audit_events WHERE gym_id = ? AND event_type = 'verifactu_submission'", [gymA]);
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0].metadata)).not.toContain('secret-pass');
  });

  it('waits AEAT\'s TiempoEsperaEnvio before the gym\'s next batch', async () => {
    await issue(gymA, '15.00');
    const s = await submitPendingVerifactuRecords({ software });
    expect(s.blocked).toContainEqual({ gym_id: gymA, reason: 'waiting' });
    expect(postToAeat).not.toHaveBeenCalled();
  });

  it('keeps a record through a transport failure and resends it, flagged as an incident, once due', async () => {
    await elapse(gymA);
    postToAeat.mockRejectedValueOnce(new AeatTransportError('connect ECONNREFUSED', 'network_error'));
    const s1 = await submitPendingVerifactuRecords({ software });
    expect(s1.retry_pending).toBe(1);
    let last = (await records(gymA)).at(-1);
    expect(last).toMatchObject({ submission_status: 'retry_pending', aeat_response_code: 'network_error', submission_attempts: 1 });
    expect(new Date(last.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    // Not due yet: nothing is sent, nothing is lost.
    await db.query('UPDATE verifactu_submissions SET finished_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE gym_id = ?', [gymA]);
    await submitPendingVerifactuRecords({ software });
    expect(postToAeat).toHaveBeenCalledTimes(1);

    // Due: resent once; AEAT already holds it (the first copy arrived), so it is a duplicate it accepted.
    await elapse(gymA);
    postToAeat.mockImplementation(async (_e: string, xml: string) => ({
      status: 200,
      body: aeatAnswer(xml, Object.fromEntries(requestedNumbers(xml).map((n) => [n,
        '<tikR:EstadoRegistro>Incorrecto</tikR:EstadoRegistro><tikR:CodigoErrorRegistro>3000</tikR:CodigoErrorRegistro><tikR:RegistroDuplicado><tik:EstadoRegistroDuplicado>Correcta</tik:EstadoRegistroDuplicado></tikR:RegistroDuplicado>']))),
    }));
    await submitPendingVerifactuRecords({ software });
    expect(postToAeat).toHaveBeenCalledTimes(2);
    const resend = postToAeat.mock.calls[1][1] as string;
    expect(resend).toContain('<sum1:Incidencia>S</sum1:Incidencia>');
    expect(requestedNumbers(resend)).toEqual([last.invoice_number]);
    last = (await records(gymA)).at(-1);
    expect(last).toMatchObject({ submission_status: 'accepted', aeat_response_code: '3000', submission_attempts: 2 });
    expect((await records(gymA)).filter((r) => r.invoice_id === last.invoice_id)).toHaveLength(1);
  });

  it('retries after a SOAP Fault and keeps a rejected record with AEAT\'s reason', async () => {
    await elapse(gymA);
    await issue(gymA, '20.00');
    postToAeat.mockResolvedValueOnce({
      status: 500,
      body: '<s:Envelope xmlns:s="x"><s:Body><s:Fault><faultcode>s:Server</faultcode><faultstring>Servicio no disponible</faultstring></s:Fault></s:Body></s:Envelope>',
    });
    await submitPendingVerifactuRecords({ software });
    let last = (await records(gymA)).at(-1);
    expect(last).toMatchObject({ submission_status: 'retry_pending', aeat_response_code: 'soap_fault:s:Server' });
    const { rows: failed } = await db.query<any>(
      "SELECT * FROM verifactu_submissions WHERE gym_id = ? ORDER BY id DESC LIMIT 1", [gymA]);
    expect(failed[0]).toMatchObject({ status: 'failed', http_status: 500, error_description: 'Servicio no disponible' });

    await elapse(gymA);
    postToAeat.mockImplementation(async (_e: string, xml: string) => ({
      status: 200,
      body: aeatAnswer(xml, Object.fromEntries(requestedNumbers(xml).map((n) => [n,
        '<tikR:EstadoRegistro>Incorrecto</tikR:EstadoRegistro><tikR:CodigoErrorRegistro>1100</tikR:CodigoErrorRegistro><tikR:DescripcionErrorRegistro>Valor incorrecto</tikR:DescripcionErrorRegistro>']))),
    }));
    await submitPendingVerifactuRecords({ software });
    last = (await records(gymA)).at(-1);
    expect(last).toMatchObject({ submission_status: 'rejected', aeat_response_code: '1100', aeat_response_description: 'Valor incorrecto', accepted_at: null });

    // A rejected record is kept for investigation and never resent automatically.
    await elapse(gymA);
    postToAeat.mockReset();
    await submitPendingVerifactuRecords({ software });
    expect(postToAeat).not.toHaveBeenCalled();
  });

  it('rejects locally, and never transmits, a record AEAT\'s schema would refuse', async () => {
    await elapse(gymA);
    await issue(gymA, '40.00', {
      invoice_type: 'full', customer_name: 'Foreign Ltd', customer_tax_id: 'GB123456789', customer_address: 'London',
    });
    postToAeat.mockImplementation(async (_e: string, xml: string) => ({ status: 200, body: aeatAnswer(xml) }));
    const s = await submitPendingVerifactuRecords({ software });
    expect(s.rejected_locally).toBe(1);
    expect(postToAeat).not.toHaveBeenCalled();
    const last = (await records(gymA)).at(-1);
    expect(last.submission_status).toBe('rejected');
    expect(last.aeat_response_code).toBe('local_validation');
    expect(last.aeat_response_description).toContain('Destinatarios NIF is not a valid Spanish NIF/NIE');
  });

  it('does not hand a gym\'s records to a pass while another holds them (sending)', async () => {
    await elapse(gymB);
    await issue(gymB, '12.00');
    await db.query("UPDATE verifactu_records SET submission_status = 'sending', last_submission_at = UTC_TIMESTAMP() WHERE gym_id = ? AND submission_status = 'pending'", [gymB]);
    await submitPendingVerifactuRecords({ software });
    expect(postToAeat).not.toHaveBeenCalled();
    // Presumed lost after the stale window: resent.
    await db.query("UPDATE verifactu_records SET last_submission_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE gym_id = ? AND submission_status = 'sending'", [gymB]);
    postToAeat.mockImplementation(async (_e: string, xml: string) => ({ status: 200, body: aeatAnswer(xml) }));
    await submitPendingVerifactuRecords({ software });
    expect(postToAeat).toHaveBeenCalledTimes(1);
    expect((await records(gymB)).map((r) => r.submission_status)).toEqual(['accepted', 'accepted']);
  });

  it('is run by the 15-minute internal pass, which reports its counters', async () => {
    process.env.BOOKING_REMINDERS_INTERNAL_SECRET = 'vf-secret';
    const r = await request.post('/booking-reminders/run').set('x-internal-secret', 'vf-secret');
    expect(r.status).toBe(200);
    expect(r.body.verifactu).toMatchObject({ batches: expect.any(Number), blocked: expect.any(Array) });
  });
});
