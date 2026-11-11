// #2647 stage 3: Settings → Tax & Compliance → Certificates & Credentials. A
// certificate is stored encrypted in the private bucket (mocked here, in memory),
// its metadata in compliance_credentials, and nothing secret ever comes back.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

const stored = new Map<string, Buffer>();
const deleted: string[] = [];
let storageConfigured = true;
vi.mock('../infra/private-storage', () => ({
  isPrivateStorageConfigured: () => storageConfigured,
  putPrivateDocument: async (key: string, body: Buffer) => {
    if (stored.has(key)) throw new Error('already exists');
    stored.set(key, body); return key;
  },
  getPrivateDocument: async (key: string) => ({ body: stored.get(key)!, contentType: 'application/octet-stream' }),
  privateObjectExists: async (key: string) => stored.has(key),
  deletePrivateCredentialObject: async (key: string) => { deleted.push(key); stored.delete(key); },
}));

import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { decryptCredentialMaterial } from '../domain/credentialEncryption';
import { FIXTURE_P12_BASE64, FIXTURE_P12_FINGERPRINT, FIXTURE_P12_PASSWORD } from './compliance-certificate-fixture';

const KEY = randomBytes(32);
let gymA: string;
let gymB: string;
let gymFrontDesk: string;
let integrationA: number;
let integrationB: number;

const as = (gymId: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });
const upload = { file_name: 'firma.p12', certificate_base64: FIXTURE_P12_BASE64, password: FIXTURE_P12_PASSWORD };
const BASE = '/system/tax-compliance/credentials';

function assertNoSecret(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toContain(FIXTURE_P12_PASSWORD);
  expect(text).not.toContain(FIXTURE_P12_BASE64.slice(0, 40));
  expect(text).not.toContain('storage_reference');
  expect(text).not.toContain('compliance/credentials');
}

async function events(gymId: string): Promise<{ event_type: string; metadata: unknown; description: string }[]> {
  return (await request.get('/system/tax-compliance/history').set(as(gymId))).body;
}

beforeAll(async () => {
  process.env.COMPLIANCE_CREDENTIALS_ENCRYPTION_KEY = KEY.toString('base64');
  gymA = await createTestGym('Creds A');
  gymB = await createTestGym('Creds B');
  gymFrontDesk = await createTestGym('Creds FD');
  await createTestMembership(gymA, 'admin');
  await createTestMembership(gymB, 'admin');
  await createTestMembership(gymFrontDesk, 'front_desk');
  const insert = async (gymId: string) => {
    const { insertId } = await db.query(
      `INSERT INTO compliance_integrations (gym_id, country_code, provider, integration_type) VALUES (?, 'ES', 'verifactu', 'invoice_reporting')`,
      [gymId],
    );
    return Number(insertId);
  };
  integrationA = await insert(gymA);
  integrationB = await insert(gymB);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('Certificates & Credentials (#2647 stage 3)', () => {
  it('401 without a token, 403 for a role without SYSTEM access', async () => {
    expect((await request.get(BASE).set('x-gym-id', gymA)).status).toBe(401);
    expect((await request.get(BASE).set(as(gymFrontDesk))).status).toBe(403);
    expect((await request.post(`${BASE}/certificate`).set(as(gymFrontDesk)).send(upload)).status).toBe(403);
  });

  it('starts empty and reports its options', async () => {
    expect((await request.get(BASE).set(as(gymA))).body).toEqual([]);
    const opts = await request.get(`${BASE}/options`).set(as(gymA));
    expect(opts.body.credential_types).toEqual(['certificate', 'external_reference']);
  });

  it('uploads a certificate: metadata stored, material encrypted, nothing secret returned', async () => {
    const res = await request.post(`${BASE}/certificate`).set(as(gymA)).send({ ...upload, label: 'AEAT', integration_id: integrationA });
    expect(res.status).toBe(201);
    assertNoSecret(res.body);
    expect(res.body).toMatchObject({
      credential_type: 'certificate', label: 'AEAT', status: 'active', effective_status: 'active',
      has_material: true, integration_id: integrationA, file_name: 'firma.p12',
      certificate_fingerprint: FIXTURE_P12_FINGERPRINT,
    });
    expect(res.body.certificate_subject).toContain('Gymdesk Test Certificate');

    const { rows } = await db.query<{ storage_reference: string }>(
      'SELECT storage_reference FROM compliance_credentials WHERE id = ?', [res.body.id],
    );
    const key = rows[0].storage_reference;
    expect(key).toMatch(new RegExp(`^gyms/${gymA}-[^/]+/compliance/credentials/[0-9a-f-]{36}\\.bin$`));
    const envelope = stored.get(key)!;
    expect(envelope.includes(Buffer.from(FIXTURE_P12_PASSWORD))).toBe(false);
    const material = decryptCredentialMaterial(KEY, gymA, key, envelope);
    expect(material.passphrase).toBe(FIXTURE_P12_PASSWORD);
    expect(material.pfx.toString('base64')).toBe(FIXTURE_P12_BASE64);

    const list = await request.get(BASE).set(as(gymA));
    expect(list.body).toHaveLength(1);
    assertNoSecret(list.body);
    const one = await request.get(`${BASE}/${res.body.id}`).set(as(gymA));
    assertNoSecret(one.body);

    const ev = await events(gymA);
    expect(ev.find((e) => e.event_type === 'credential_uploaded')).toBeTruthy();
    assertNoSecret(ev);
  });

  it('refuses a wrong password, a wrong file type and another gym\'s integration, storing nothing', async () => {
    const before = stored.size;
    const wrong = await request.post(`${BASE}/certificate`).set(as(gymA)).send({ ...upload, password: 'nope' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/password/i);
    expect((await request.post(`${BASE}/certificate`).set(as(gymA)).send({ ...upload, file_name: 'x.pem' })).status).toBe(400);
    expect((await request.post(`${BASE}/certificate`).set(as(gymA)).send({ ...upload, certificate_base64: Buffer.from('nope').toString('base64') })).status).toBe(400);
    expect((await request.post(`${BASE}/certificate`).set(as(gymA)).send({ ...upload, integration_id: integrationB })).status).toBe(400);
    expect(stored.size).toBe(before);
  });

  it('answers 503 and stores nothing when the deployment has no encryption key or no private bucket', async () => {
    const before = stored.size;
    const saved = process.env.COMPLIANCE_CREDENTIALS_ENCRYPTION_KEY;
    delete process.env.COMPLIANCE_CREDENTIALS_ENCRYPTION_KEY;
    try {
      expect((await request.post(`${BASE}/certificate`).set(as(gymA)).send(upload)).status).toBe(503);
    } finally {
      process.env.COMPLIANCE_CREDENTIALS_ENCRYPTION_KEY = saved;
    }
    storageConfigured = false;
    try {
      expect((await request.post(`${BASE}/certificate`).set(as(gymA)).send(upload)).status).toBe(503);
    } finally {
      storageConfigured = true;
    }
    expect(stored.size).toBe(before);
  });

  it('replaces a certificate with a new object and removes the old one', async () => {
    const created = await request.post(`${BASE}/certificate`).set(as(gymA)).send({ ...upload, label: 'Replace me' });
    const { rows: [{ storage_reference: oldKey }] } = await db.query<{ storage_reference: string }>(
      'SELECT storage_reference FROM compliance_credentials WHERE id = ?', [created.body.id],
    );
    const res = await request.put(`${BASE}/${created.body.id}/certificate`).set(as(gymA)).send({ ...upload, file_name: 'renewed.pfx' });
    expect(res.status).toBe(200);
    assertNoSecret(res.body);
    expect(res.body.file_name).toBe('renewed.pfx');
    expect(res.body.label).toBe('Replace me');
    const { rows: [{ storage_reference: newKey }] } = await db.query<{ storage_reference: string }>(
      'SELECT storage_reference FROM compliance_credentials WHERE id = ?', [created.body.id],
    );
    expect(newKey).not.toBe(oldKey);
    expect(stored.has(newKey)).toBe(true);
    expect(deleted).toContain(oldKey);
    expect((await request.put(`${BASE}/${created.body.id}/certificate`).set(as(gymA)).send({ ...upload, password: 'bad' })).status).toBe(400);
    expect((await events(gymA)).some((e) => e.event_type === 'credential_replaced')).toBe(true);
  });

  it('registers a centrally managed credential by reference, with no material', async () => {
    const res = await request.post(`${BASE}/reference`).set(as(gymA)).send({ external_reference: 'provider-account-42', label: 'Provider' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ credential_type: 'external_reference', has_material: false, external_reference: 'provider-account-42' });
    expect((await request.post(`${BASE}/reference`).set(as(gymA)).send({})).status).toBe(400);
    expect((await request.put(`${BASE}/${res.body.id}/certificate`).set(as(gymA)).send(upload)).status).toBe(400);
  });

  it('edits metadata, deactivates, and refuses what does not apply', async () => {
    const created = await request.post(`${BASE}/reference`).set(as(gymA)).send({ external_reference: 'ref-1' });
    const res = await request.put(`${BASE}/${created.body.id}`).set(as(gymA)).send({ label: 'Renamed', status: 'inactive', integration_id: integrationA });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ label: 'Renamed', status: 'inactive', effective_status: 'inactive', integration_id: integrationA });
    expect((await request.put(`${BASE}/${created.body.id}`).set(as(gymA)).send({ status: 'expired' })).status).toBe(400);
    expect((await request.put(`${BASE}/${created.body.id}`).set(as(gymA)).send({ integration_id: integrationB })).status).toBe(400);
    const ev = (await events(gymA)).find((e) => e.event_type === 'credential_updated');
    expect(ev).toBeTruthy();
  });

  it('derives "expired" from the stored validity window', async () => {
    const created = await request.post(`${BASE}/certificate`).set(as(gymA)).send(upload);
    await db.query(`UPDATE compliance_credentials SET expires_at = '2020-01-01 00:00:00', modified_by = 'test' WHERE id = ?`, [created.body.id]);
    const res = await request.get(`${BASE}/${created.body.id}`).set(as(gymA));
    expect(res.body.status).toBe('active');
    expect(res.body.effective_status).toBe('expired');
  });

  it('isolates gyms: another gym cannot read, edit, replace or delete a credential', async () => {
    const created = await request.post(`${BASE}/certificate`).set(as(gymA)).send(upload);
    const id = created.body.id;
    expect((await request.get(`${BASE}/${id}`).set(as(gymB))).status).toBe(404);
    expect((await request.put(`${BASE}/${id}`).set(as(gymB)).send({ label: 'x' })).status).toBe(404);
    expect((await request.put(`${BASE}/${id}/certificate`).set(as(gymB)).send(upload)).status).toBe(404);
    expect((await request.delete(`${BASE}/${id}`).set(as(gymB))).status).toBe(404);
    expect((await request.get(BASE).set(as(gymB))).body).toEqual([]);
  });

  it('deletes a credential and its encrypted object, keeping the history event', async () => {
    const created = await request.post(`${BASE}/certificate`).set(as(gymA)).send({ ...upload, label: 'Delete me' });
    const { rows: [{ storage_reference: key }] } = await db.query<{ storage_reference: string }>(
      'SELECT storage_reference FROM compliance_credentials WHERE id = ?', [created.body.id],
    );
    const res = await request.delete(`${BASE}/${created.body.id}`).set(as(gymA));
    expect(res.status).toBe(204);
    expect(stored.has(key)).toBe(false);
    expect((await request.get(`${BASE}/${created.body.id}`).set(as(gymA))).status).toBe(404);
    const ev = (await events(gymA)).find((e) => e.event_type === 'credential_deleted');
    expect(ev?.description).toContain('Delete me');
    expect((await request.delete(`${BASE}/${created.body.id}`).set(as(gymA))).status).toBe(404);
  });
});
