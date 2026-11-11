// #2647 stage 3 — what a compliance credential is, which requests describe one,
// and what a certificate says about itself. The one place these rules live; the
// router (`api/tax-compliance.ts`) does the I/O.
import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';

/**
 * `certificate`: customer-owned, a PKCS#12 file (.p12 / .pfx) the gym uploads, kept
 * encrypted. `external_reference`: centrally managed — Gymdesk or an authorised
 * provider holds the credential and this row only names it. Mirrored by
 * `chk_compliance_credentials_type` (migration 393): a new kind goes in both places.
 */
export const CREDENTIAL_TYPES = ['certificate', 'external_reference'] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/** Stored administrative state, mirrored by `chk_compliance_credentials_status`. */
export const CREDENTIAL_STATUSES = ['active', 'inactive'] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

/** What a reader is told: the stored state, or what the validity window says on top of it. */
export type EffectiveCredentialStatus = 'active' | 'inactive' | 'expired' | 'not_yet_valid';

export const CERTIFICATE_EXTENSIONS = ['.p12', '.pfx'] as const;
export const CERTIFICATE_MAX_BYTES = 64 * 1024;
export const PASSWORD_MAX_LENGTH = 256;
export const LABEL_MAX_LENGTH = 120;
export const EXTERNAL_REFERENCE_MAX_LENGTH = 255;
/** A certificate expiring within this many days is flagged in the list. */
export const EXPIRY_WARNING_DAYS = 30;

export interface CertificateMetadata {
  certificate_subject: string;
  certificate_serial_number: string;
  certificate_issuer: string;
  certificate_fingerprint: string;
  valid_from: Date;
  expires_at: Date;
}

export type CertificateReadResult =
  | { ok: true; metadata: CertificateMetadata }
  | { ok: false; error: 'invalid_file' | 'wrong_password' | 'unsupported_algorithm' };

/**
 * Opens the PKCS#12 with its password through Node's own TLS layer — the very call
 * an AEAT client will make with this file (#2648), so a certificate that is stored
 * is one that can be used. A wrong password is `mac verify failure`; a file
 * protected with an algorithm OpenSSL 3 no longer enables (RC2-40) is refused with
 * its own answer rather than stored and failing later.
 */
export function readPkcs12Certificate(pfx: Buffer, passphrase: string): CertificateReadResult {
  if (pfx.length < 4 || pfx[0] !== 0x30) return { ok: false, error: 'invalid_file' };
  let der: Buffer | undefined;
  try {
    const ctx = createSecureContext({ pfx, passphrase });
    der = (ctx.context as { getCertificate?: () => Buffer | null }).getCertificate?.() ?? undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    if (msg.includes('mac verify')) return { ok: false, error: 'wrong_password' };
    if (msg.includes('unsupported')) return { ok: false, error: 'unsupported_algorithm' };
    return { ok: false, error: 'invalid_file' };
  }
  if (!der) return { ok: false, error: 'invalid_file' };
  try {
    const x = new X509Certificate(der);
    return {
      ok: true,
      metadata: {
        certificate_subject: x.subject.replace(/\n/g, ', ').slice(0, 1024),
        certificate_serial_number: x.serialNumber.slice(0, 128),
        certificate_issuer: x.issuer.replace(/\n/g, ', ').slice(0, 1024),
        certificate_fingerprint: x.fingerprint256,
        valid_from: new Date(x.validFrom),
        expires_at: new Date(x.validTo),
      },
    };
  } catch {
    return { ok: false, error: 'invalid_file' };
  }
}

export function effectiveCredentialStatus(
  row: { status: CredentialStatus; valid_from: Date | string | null; expires_at: Date | string | null },
  now: Date = new Date(),
): EffectiveCredentialStatus {
  if (row.status === 'inactive') return 'inactive';
  if (row.expires_at && new Date(row.expires_at).getTime() < now.getTime()) return 'expired';
  if (row.valid_from && new Date(row.valid_from).getTime() > now.getTime()) return 'not_yet_valid';
  return 'active';
}

/** True while an active credential's certificate expires within `EXPIRY_WARNING_DAYS`. */
export function expiresSoon(expiresAt: Date | string | null, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  const ms = new Date(expiresAt).getTime() - now.getTime();
  return ms >= 0 && ms <= EXPIRY_WARNING_DAYS * 86_400_000;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function optionalText(v: unknown, field: string, max: number): Result<string | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, error: `${field} must be a string` };
  const s = v.trim();
  if (s.length > max) return { ok: false, error: `${field} is too long` };
  return { ok: true, value: s === '' ? null : s };
}

function optionalIntegrationId(v: unknown): Result<number | null> {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'integration_id is invalid' };
  return { ok: true, value: n };
}

export interface CertificateUploadInput {
  label: string | null;
  integration_id: number | null;
  file_name: string;
  pfx: Buffer;
  passphrase: string;
}

/**
 * A certificate upload: `{ file_name, certificate_base64, password, label?, integration_id? }`.
 * The file type is judged from its name and its first byte (a DER SEQUENCE), never from
 * a declared content type; the size from the decoded bytes. `replace` reads the same body
 * with `label` / `integration_id` left to the row they replace when absent.
 */
export function parseCertificateUpload(body: unknown): Result<CertificateUploadInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.file_name !== 'string' || !b.file_name.trim()) return { ok: false, error: 'file_name is required' };
  const fileName = b.file_name.trim().slice(0, 255);
  const lower = fileName.toLowerCase();
  if (!CERTIFICATE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { ok: false, error: 'The certificate must be a .p12 or .pfx file' };
  }
  if (typeof b.certificate_base64 !== 'string' || !b.certificate_base64) {
    return { ok: false, error: 'certificate_base64 is required' };
  }
  const raw = b.certificate_base64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return { ok: false, error: 'certificate_base64 is not valid base64' };
  const pfx = Buffer.from(raw, 'base64');
  if (pfx.length === 0) return { ok: false, error: 'The certificate file is empty' };
  if (pfx.length > CERTIFICATE_MAX_BYTES) return { ok: false, error: `The certificate file is larger than ${CERTIFICATE_MAX_BYTES / 1024} KB` };
  if (typeof b.password !== 'string') return { ok: false, error: 'password is required' };
  if (b.password.length > PASSWORD_MAX_LENGTH) return { ok: false, error: 'password is too long' };
  const label = optionalText(b.label, 'label', LABEL_MAX_LENGTH);
  if (!label.ok) return label;
  const integration = optionalIntegrationId(b.integration_id);
  if (!integration.ok) return integration;
  return { ok: true, value: { label: label.value, integration_id: integration.value, file_name: fileName, pfx, passphrase: b.password } };
}

export interface ExternalReferenceInput {
  label: string | null;
  integration_id: number | null;
  external_reference: string;
}

export function parseExternalReferenceInput(body: unknown): Result<ExternalReferenceInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const ref = optionalText(b.external_reference, 'external_reference', EXTERNAL_REFERENCE_MAX_LENGTH);
  if (!ref.ok) return ref;
  if (!ref.value) return { ok: false, error: 'external_reference is required' };
  const label = optionalText(b.label, 'label', LABEL_MAX_LENGTH);
  if (!label.ok) return label;
  const integration = optionalIntegrationId(b.integration_id);
  if (!integration.ok) return integration;
  return { ok: true, value: { label: label.value, integration_id: integration.value, external_reference: ref.value } };
}

export interface CredentialUpdate {
  label?: string | null;
  integration_id?: number | null;
  status?: CredentialStatus;
  external_reference?: string;
}

/**
 * A metadata edit. Absent keeps, `null` clears (label, integration), anything unknown is
 * a 400. A certificate's material and what it says about itself are never edited here —
 * that is a replacement.
 */
export function parseCredentialUpdate(body: unknown, type: CredentialType): Result<CredentialUpdate> {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: CredentialUpdate = {};
  if ('label' in b) {
    const r = optionalText(b.label, 'label', LABEL_MAX_LENGTH);
    if (!r.ok) return r;
    out.label = r.value;
  }
  if ('integration_id' in b) {
    const r = optionalIntegrationId(b.integration_id);
    if (!r.ok) return r;
    out.integration_id = r.value;
  }
  if ('status' in b) {
    if (!(CREDENTIAL_STATUSES as readonly unknown[]).includes(b.status)) return { ok: false, error: 'status is invalid' };
    out.status = b.status as CredentialStatus;
  }
  if ('external_reference' in b) {
    if (type !== 'external_reference') return { ok: false, error: 'A certificate has no external reference' };
    const r = optionalText(b.external_reference, 'external_reference', EXTERNAL_REFERENCE_MAX_LENGTH);
    if (!r.ok) return r;
    if (!r.value) return { ok: false, error: 'external_reference is required' };
    out.external_reference = r.value;
  }
  return { ok: true, value: out };
}

export function credentialOptions() {
  return {
    credential_types: CREDENTIAL_TYPES,
    statuses: CREDENTIAL_STATUSES,
    certificate_extensions: CERTIFICATE_EXTENSIONS,
    certificate_max_bytes: CERTIFICATE_MAX_BYTES,
    expiry_warning_days: EXPIRY_WARNING_DAYS,
  };
}
