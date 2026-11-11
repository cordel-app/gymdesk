import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db, type Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { createdAuditValues, modifiedAuditSet, resolveRequestActor } from '../domain/auditActor';
import {
  credentialOptions,
  effectiveCredentialStatus,
  expiresSoon,
  parseCertificateUpload,
  parseCredentialUpdate,
  parseExternalReferenceInput,
  readPkcs12Certificate,
  type CertificateMetadata,
  type CredentialStatus,
  type CredentialType,
} from '../domain/complianceCredentials';
import { credentialEncryptionKey, encryptCredentialMaterial } from '../domain/credentialEncryption';
import { buildComplianceCredentialKey } from '../domain/billingDocumentKeys';
import {
  deletePrivateCredentialObject,
  isPrivateStorageConfigured,
  putPrivateDocument,
} from '../infra/private-storage';
import { recordComplianceEvent } from './compliance-audit-events';

/**
 * #2647 stage 3: Tax & Compliance → Certificates & Credentials, mounted under
 * `/system/tax-compliance/credentials` (SYSTEM module, writes behind
 * `requireModuleWrite('SYSTEM')`).
 *
 * The row is metadata; the PKCS#12 and its password are one AES-256-GCM envelope in
 * the private bucket (`domain/credentialEncryption.ts`). No response carries the
 * object key, the file, the password or anything derived from the key: `has_material`
 * is the whole of what a client learns about the stored secret. Nothing here logs
 * a request body.
 */
export const complianceCredentialsRouter = Router();

interface CredentialRow {
  id: number;
  integration_id: number | null;
  credential_type: CredentialType;
  label: string | null;
  status: CredentialStatus;
  storage_reference: string | null;
  external_reference: string | null;
  file_name: string | null;
  certificate_subject: string | null;
  certificate_serial_number: string | null;
  certificate_issuer: string | null;
  certificate_fingerprint: string | null;
  valid_from: Date | null;
  expires_at: Date | null;
  created_at: Date;
  created_by: string | null;
  modified_at: Date | null;
  modified_by: string | null;
}

const COLUMNS = `id, integration_id, credential_type, label, status, storage_reference, external_reference,
  file_name, certificate_subject, certificate_serial_number, certificate_issuer, certificate_fingerprint,
  valid_from, expires_at, created_at, created_by, modified_at, modified_by`;

/** The client's view of a row: everything but `storage_reference`. */
function present(row: CredentialRow, now = new Date()) {
  const { storage_reference, ...rest } = row;
  return {
    ...rest,
    has_material: storage_reference != null,
    effective_status: effectiveCredentialStatus(row, now),
    expires_soon: row.status === 'active' && expiresSoon(row.expires_at, now),
  };
}

async function loadRow(exec: Pick<Tx, 'query'>, gymId: string, id: number, lock = false): Promise<CredentialRow | null> {
  const { rows } = await exec.query<CredentialRow>(
    `SELECT ${COLUMNS} FROM compliance_credentials WHERE id = ? AND gym_id = ?${lock ? ' FOR UPDATE' : ''}`,
    [id, gymId],
  );
  return rows[0] ?? null;
}

function idParam(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** An integration named by a request must be this gym's own. */
async function integrationBelongs(exec: Pick<Tx, 'query'>, gymId: string, integrationId: number | null): Promise<{ ok: boolean; provider: string | null }> {
  if (integrationId == null) return { ok: true, provider: null };
  const { rows } = await exec.query<{ provider: string }>(
    'SELECT provider FROM compliance_integrations WHERE id = ? AND gym_id = ?',
    [integrationId, gymId],
  );
  return rows[0] ? { ok: true, provider: rows[0].provider } : { ok: false, provider: null };
}

const CERTIFICATE_ERRORS: Record<'invalid_file' | 'wrong_password' | 'unsupported_algorithm', string> = {
  invalid_file: 'The file is not a readable PKCS#12 (.p12 / .pfx) certificate',
  wrong_password: 'The certificate password is incorrect',
  unsupported_algorithm: 'The certificate is protected with an algorithm that is no longer supported; export it again with AES encryption',
};

/** 503 when the deployment cannot keep a certificate secret: no key, or no private bucket. */
function materialUnavailable(): string | null {
  if (!credentialEncryptionKey()) return 'Certificate storage is not configured for this deployment (encryption key missing)';
  if (!isPrivateStorageConfigured()) return 'Certificate storage is not configured for this deployment (private storage missing)';
  return null;
}

async function gymName(gymId: string): Promise<string> {
  const { rows } = await db.query<{ name: string }>('SELECT name FROM gyms WHERE id = ?', [gymId]);
  return rows[0]?.name ?? 'gym';
}

/**
 * Validates the file against its password, encrypts it and writes the envelope to a
 * fresh object. Returns the metadata to store and the object key, or an error.
 */
async function storeCertificate(gymId: string, pfx: Buffer, passphrase: string):
  Promise<{ ok: true; key: string; metadata: CertificateMetadata } | { ok: false; status: number; error: string }> {
  const read = readPkcs12Certificate(pfx, passphrase);
  if (!read.ok) return { ok: false, status: 400, error: CERTIFICATE_ERRORS[read.error] };
  const unavailable = materialUnavailable();
  if (unavailable) return { ok: false, status: 503, error: unavailable };
  const key = buildComplianceCredentialKey(gymId, await gymName(gymId), randomUUID());
  const envelope = encryptCredentialMaterial(credentialEncryptionKey()!, gymId, key, { pfx, passphrase });
  await putPrivateDocument(key, envelope, 'application/octet-stream');
  return { ok: true, key, metadata: read.metadata };
}

async function dropObject(key: string | null): Promise<void> {
  if (!key) return;
  try {
    await deletePrivateCredentialObject(key);
  } catch (err) {
    // The key is internal; the message never carries material.
    console.error('[compliance-credentials] could not delete an encrypted object', err instanceof Error ? err.message : err);
  }
}

complianceCredentialsRouter.get('/options', (_req, res) => {
  res.json(credentialOptions());
});

complianceCredentialsRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query<CredentialRow>(
      `SELECT ${COLUMNS} FROM compliance_credentials WHERE gym_id = ? ORDER BY created_at, id`,
      [gymId],
    );
    const now = new Date();
    res.json(rows.map((r) => present(r, now)));
  } catch (err) {
    next(err);
  }
});

complianceCredentialsRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const id = idParam(String(req.params.id));
  if (id === null) return res.status(404).json({ error: 'Credential not found' });
  try {
    const row = await loadRow(db, gymId, id);
    if (!row) return res.status(404).json({ error: 'Credential not found' });
    res.json(present(row));
  } catch (err) {
    next(err);
  }
});

complianceCredentialsRouter.post('/certificate', requireModuleWrite('SYSTEM'), async (req, res, next) => {
  const tenantCtx = getTenantContext(req);
  const { gymId } = tenantCtx;
  const actor = resolveRequestActor(tenantCtx);
  const parsed = parseCertificateUpload(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const input = parsed.value;
  let storedKey: string | null = null;
  try {
    const integration = await integrationBelongs(db, gymId, input.integration_id);
    if (!integration.ok) return res.status(400).json({ error: 'integration_id is not one of this gym\'s integrations' });
    const stored = await storeCertificate(gymId, input.pfx, input.passphrase);
    if (!stored.ok) return res.status(stored.status).json({ error: stored.error });
    storedKey = stored.key;
    const m = stored.metadata;
    const row = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO compliance_credentials
           (gym_id, integration_id, credential_type, label, status, storage_reference, file_name,
            certificate_subject, certificate_serial_number, certificate_issuer, certificate_fingerprint,
            valid_from, expires_at, created_at, created_by)
         VALUES (?, ?, 'certificate', ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
        [
          gymId, input.integration_id, input.label, stored.key, input.file_name,
          m.certificate_subject, m.certificate_serial_number, m.certificate_issuer, m.certificate_fingerprint,
          m.valid_from, m.expires_at, createdAuditValues(actor).created_by,
        ],
      );
      const id = Number(insertId);
      await recordComplianceEvent(tx, {
        gymId,
        integrationId: input.integration_id,
        provider: integration.provider,
        eventType: 'credential_uploaded',
        description: `Certificate uploaded: ${m.certificate_subject}`.slice(0, 500),
        actor,
        metadata: { credential_id: id, fingerprint: m.certificate_fingerprint, expires_at: m.expires_at.toISOString() },
      });
      return loadRow(tx, gymId, id);
    });
    storedKey = null;
    res.status(201).json(present(row!));
  } catch (err) {
    await dropObject(storedKey);
    next(err);
  }
});

complianceCredentialsRouter.put('/:id/certificate', requireModuleWrite('SYSTEM'), async (req, res, next) => {
  const tenantCtx = getTenantContext(req);
  const { gymId } = tenantCtx;
  const actor = resolveRequestActor(tenantCtx);
  const id = idParam(String(req.params.id));
  if (id === null) return res.status(404).json({ error: 'Credential not found' });
  const parsed = parseCertificateUpload(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const input = parsed.value;
  let newKey: string | null = null;
  try {
    const existing = await loadRow(db, gymId, id);
    if (!existing) return res.status(404).json({ error: 'Credential not found' });
    if (existing.credential_type !== 'certificate') return res.status(400).json({ error: 'Only a certificate can be replaced with a file' });
    const stored = await storeCertificate(gymId, input.pfx, input.passphrase);
    if (!stored.ok) return res.status(stored.status).json({ error: stored.error });
    newKey = stored.key;
    const m = stored.metadata;
    const outcome = await db.transaction(async (tx) => {
      const before = await loadRow(tx, gymId, id, true);
      if (!before) return null;
      const audit = modifiedAuditSet(actor);
      await tx.query(
        `UPDATE compliance_credentials
            SET storage_reference = ?, file_name = ?, certificate_subject = ?, certificate_serial_number = ?,
                certificate_issuer = ?, certificate_fingerprint = ?, valid_from = ?, expires_at = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ? AND gym_id = ?`,
        [stored.key, input.file_name, m.certificate_subject, m.certificate_serial_number, m.certificate_issuer,
          m.certificate_fingerprint, m.valid_from, m.expires_at, ...audit.params, id, gymId],
      );
      await recordComplianceEvent(tx, {
        gymId,
        integrationId: before.integration_id,
        eventType: 'credential_replaced',
        description: `Certificate replaced: ${m.certificate_subject}`.slice(0, 500),
        actor,
        metadata: {
          credential_id: id,
          previous_fingerprint: before.certificate_fingerprint,
          fingerprint: m.certificate_fingerprint,
          expires_at: m.expires_at.toISOString(),
        },
      });
      return { previousKey: before.storage_reference, row: await loadRow(tx, gymId, id) };
    });
    if (!outcome) {
      await dropObject(newKey);
      return res.status(404).json({ error: 'Credential not found' });
    }
    newKey = null;
    await dropObject(outcome.previousKey);
    res.json(present(outcome.row!));
  } catch (err) {
    await dropObject(newKey);
    next(err);
  }
});

complianceCredentialsRouter.post('/reference', requireModuleWrite('SYSTEM'), async (req, res, next) => {
  const tenantCtx = getTenantContext(req);
  const { gymId } = tenantCtx;
  const actor = resolveRequestActor(tenantCtx);
  const parsed = parseExternalReferenceInput(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const input = parsed.value;
  try {
    const outcome = await db.transaction(async (tx) => {
      const integration = await integrationBelongs(tx, gymId, input.integration_id);
      if (!integration.ok) return null;
      const { insertId } = await tx.query(
        `INSERT INTO compliance_credentials
           (gym_id, integration_id, credential_type, label, status, external_reference, created_at, created_by)
         VALUES (?, ?, 'external_reference', ?, 'active', ?, UTC_TIMESTAMP(), ?)`,
        [gymId, input.integration_id, input.label, input.external_reference, createdAuditValues(actor).created_by],
      );
      const id = Number(insertId);
      await recordComplianceEvent(tx, {
        gymId,
        integrationId: input.integration_id,
        provider: integration.provider,
        eventType: 'credential_reference_created',
        description: `Centrally managed credential registered${input.label ? `: ${input.label}` : ''}`.slice(0, 500),
        actor,
        metadata: { credential_id: id },
      });
      return loadRow(tx, gymId, id);
    });
    if (!outcome) return res.status(400).json({ error: 'integration_id is not one of this gym\'s integrations' });
    res.status(201).json(present(outcome));
  } catch (err) {
    next(err);
  }
});

complianceCredentialsRouter.put('/:id', requireModuleWrite('SYSTEM'), async (req, res, next) => {
  const tenantCtx = getTenantContext(req);
  const { gymId } = tenantCtx;
  const actor = resolveRequestActor(tenantCtx);
  const id = idParam(String(req.params.id));
  if (id === null) return res.status(404).json({ error: 'Credential not found' });
  try {
    const outcome = await db.transaction(async (tx) => {
      const before = await loadRow(tx, gymId, id, true);
      if (!before) return { status: 404, error: 'Credential not found', row: null };
      const parsed = parseCredentialUpdate(req.body, before.credential_type);
      if (!parsed.ok) return { status: 400, error: parsed.error, row: null };
      const changes = parsed.value;
      if ('integration_id' in changes && !(await integrationBelongs(tx, gymId, changes.integration_id ?? null)).ok) {
        return { status: 400, error: 'integration_id is not one of this gym\'s integrations', row: null };
      }
      const changed = (Object.keys(changes) as (keyof typeof changes)[])
        .filter((k) => (changes[k] ?? null) !== (before[k] ?? null));
      if (changed.length > 0) {
        const audit = modifiedAuditSet(actor);
        await tx.query(
          `UPDATE compliance_credentials SET ${changed.map((k) => `${k} = ?`).join(', ')}, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ?`,
          [...changed.map((k) => changes[k] ?? null), ...audit.params, id, gymId],
        );
        await recordComplianceEvent(tx, {
          gymId,
          integrationId: changes.integration_id !== undefined ? changes.integration_id : before.integration_id,
          eventType: 'credential_updated',
          description: `Credential updated: ${before.label ?? before.certificate_subject ?? before.external_reference ?? `#${id}`} (${changed.join(', ')})`.slice(0, 500),
          actor,
          metadata: { credential_id: id, fields: changed },
        });
      }
      return { status: 200, error: null, row: await loadRow(tx, gymId, id) };
    });
    if (outcome.error || !outcome.row) return res.status(outcome.status).json({ error: outcome.error });
    res.json(present(outcome.row));
  } catch (err) {
    next(err);
  }
});

complianceCredentialsRouter.delete('/:id', requireModuleWrite('SYSTEM'), async (req, res, next) => {
  const tenantCtx = getTenantContext(req);
  const { gymId } = tenantCtx;
  const actor = resolveRequestActor(tenantCtx);
  const id = idParam(String(req.params.id));
  if (id === null) return res.status(404).json({ error: 'Credential not found' });
  try {
    const removedKey = await db.transaction(async (tx) => {
      const before = await loadRow(tx, gymId, id, true);
      if (!before) return undefined;
      await tx.query('DELETE FROM compliance_credentials WHERE id = ? AND gym_id = ?', [id, gymId]);
      await recordComplianceEvent(tx, {
        gymId,
        integrationId: before.integration_id,
        eventType: 'credential_deleted',
        description: `Credential deleted: ${before.label ?? before.certificate_subject ?? before.external_reference ?? `#${id}`}`.slice(0, 500),
        actor,
        metadata: { credential_id: id, credential_type: before.credential_type, fingerprint: before.certificate_fingerprint },
      });
      return before.storage_reference;
    });
    if (removedKey === undefined) return res.status(404).json({ error: 'Credential not found' });
    await dropObject(removedKey);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
