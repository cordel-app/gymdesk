// #2647 stage 3: the pure rules of Certificates & Credentials — reading a PKCS#12,
// the AES-256-GCM envelope, the derived status and the request parsers.
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  CERTIFICATE_MAX_BYTES,
  effectiveCredentialStatus,
  expiresSoon,
  parseCertificateUpload,
  parseCredentialUpdate,
  parseExternalReferenceInput,
  readPkcs12Certificate,
} from '../domain/complianceCredentials';
import { decryptCredentialMaterial, encryptCredentialMaterial, parseEncryptionKey } from '../domain/credentialEncryption';
import { buildComplianceCredentialKey, isComplianceCredentialKey, buildInvoiceKey } from '../domain/billingDocumentKeys';
import { FIXTURE_P12_BASE64, FIXTURE_P12_FINGERPRINT, FIXTURE_P12_PASSWORD } from './compliance-certificate-fixture';

const pfx = Buffer.from(FIXTURE_P12_BASE64, 'base64');

describe('readPkcs12Certificate', () => {
  it('opens the file with its password and reports what the certificate says', () => {
    const r = readPkcs12Certificate(pfx, FIXTURE_P12_PASSWORD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.metadata.certificate_subject).toContain('CN=Gymdesk Test Certificate');
    expect(r.metadata.certificate_issuer).toContain('O=Gymdesk Tests');
    expect(r.metadata.certificate_fingerprint).toBe(FIXTURE_P12_FINGERPRINT);
    expect(r.metadata.certificate_serial_number).toMatch(/^[0-9A-F]+$/);
    expect(r.metadata.expires_at.toISOString().slice(0, 10)).toBe('2036-11-08');
    expect(r.metadata.valid_from.getTime()).toBeLessThan(r.metadata.expires_at.getTime());
  });

  it('refuses a wrong password and a file that is not a PKCS#12', () => {
    expect(readPkcs12Certificate(pfx, 'nope')).toEqual({ ok: false, error: 'wrong_password' });
    expect(readPkcs12Certificate(Buffer.from('not a certificate'), 'x')).toEqual({ ok: false, error: 'invalid_file' });
    expect(readPkcs12Certificate(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x03]), 'x').ok).toBe(false);
  });
});

describe('credential envelope', () => {
  const key = randomBytes(32);
  const objectKey = buildComplianceCredentialKey('gym-1', 'Gym One', '0f8fad5b-d9cb-469f-a165-70867728950e');

  it('round-trips the file and the password, and the envelope holds neither in clear', () => {
    const env = encryptCredentialMaterial(key, 'gym-1', objectKey, { pfx, passphrase: 'pw-secret-123' });
    expect(env.includes(Buffer.from('pw-secret-123'))).toBe(false);
    expect(env.includes(pfx.subarray(0, 32))).toBe(false);
    const back = decryptCredentialMaterial(key, 'gym-1', objectKey, env);
    expect(back.passphrase).toBe('pw-secret-123');
    expect(back.pfx.equals(pfx)).toBe(true);
  });

  it('does not decrypt under another gym, another object, another key or after tampering', () => {
    const env = encryptCredentialMaterial(key, 'gym-1', objectKey, { pfx, passphrase: 'pw' });
    expect(() => decryptCredentialMaterial(key, 'gym-2', objectKey, env)).toThrow();
    expect(() => decryptCredentialMaterial(key, 'gym-1', `${objectKey}x`, env)).toThrow();
    expect(() => decryptCredentialMaterial(randomBytes(32), 'gym-1', objectKey, env)).toThrow();
    const tampered = Buffer.from(env);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptCredentialMaterial(key, 'gym-1', objectKey, tampered)).toThrow();
  });

  it('accepts only a 32-byte base64 key', () => {
    expect(parseEncryptionKey(randomBytes(32).toString('base64'))).toHaveLength(32);
    expect(parseEncryptionKey(randomBytes(16).toString('base64'))).toBeNull();
    expect(parseEncryptionKey('')).toBeNull();
    expect(parseEncryptionKey(undefined)).toBeNull();
    expect(parseEncryptionKey('not base64!!')).toBeNull();
  });
});

describe('object keys', () => {
  it('builds a key under the gym folder and recognises only those keys as deletable', () => {
    const k = buildComplianceCredentialKey('abc', 'My Gym', '0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(k).toBe('gyms/abc-MyGym/compliance/credentials/0f8fad5b-d9cb-469f-a165-70867728950e.bin');
    expect(isComplianceCredentialKey(k)).toBe(true);
    expect(isComplianceCredentialKey(buildInvoiceKey('abc', 'My Gym', 1, 'full', 'paid'))).toBe(false);
    expect(isComplianceCredentialKey('gyms/abc/compliance/credentials/../invoices/x.bin')).toBe(false);
    expect(() => buildComplianceCredentialKey('abc', 'g', '../x')).toThrow();
  });
});

describe('derived status', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  it('reads inactive first, then the validity window', () => {
    expect(effectiveCredentialStatus({ status: 'inactive', valid_from: null, expires_at: '2020-01-01' }, now)).toBe('inactive');
    expect(effectiveCredentialStatus({ status: 'active', valid_from: null, expires_at: '2026-11-10T00:00:00Z' }, now)).toBe('expired');
    expect(effectiveCredentialStatus({ status: 'active', valid_from: '2026-12-01T00:00:00Z', expires_at: null }, now)).toBe('not_yet_valid');
    expect(effectiveCredentialStatus({ status: 'active', valid_from: null, expires_at: null }, now)).toBe('active');
  });
  it('flags an expiry within 30 days, never a past one', () => {
    expect(expiresSoon('2026-12-01T00:00:00Z', now)).toBe(true);
    expect(expiresSoon('2027-02-01T00:00:00Z', now)).toBe(false);
    expect(expiresSoon('2026-11-01T00:00:00Z', now)).toBe(false);
    expect(expiresSoon(null, now)).toBe(false);
  });
});

describe('request parsers', () => {
  const base = { file_name: 'cert.p12', certificate_base64: FIXTURE_P12_BASE64, password: 'x' };
  it('accepts a .p12 / .pfx upload and judges type and size from the file', () => {
    expect(parseCertificateUpload(base).ok).toBe(true);
    expect(parseCertificateUpload({ ...base, file_name: 'CERT.PFX' }).ok).toBe(true);
    expect(parseCertificateUpload({ ...base, file_name: 'cert.pem' }).ok).toBe(false);
    expect(parseCertificateUpload({ ...base, certificate_base64: '***' }).ok).toBe(false);
    expect(parseCertificateUpload({ ...base, password: undefined }).ok).toBe(false);
    const big = Buffer.alloc(CERTIFICATE_MAX_BYTES + 1, 0x30).toString('base64');
    expect(parseCertificateUpload({ ...base, certificate_base64: big }).ok).toBe(false);
    expect(parseCertificateUpload({ ...base, integration_id: 'x' }).ok).toBe(false);
  });
  it('requires a reference for a centrally managed credential', () => {
    expect(parseExternalReferenceInput({ external_reference: '  ' }).ok).toBe(false);
    expect(parseExternalReferenceInput({ external_reference: 'provider:abc', label: 'Prov' })).toEqual({
      ok: true, value: { external_reference: 'provider:abc', label: 'Prov', integration_id: null },
    });
  });
  it('keeps what an update does not mention and refuses what does not apply', () => {
    expect(parseCredentialUpdate({}, 'certificate')).toEqual({ ok: true, value: {} });
    expect(parseCredentialUpdate({ label: null, status: 'inactive' }, 'certificate')).toEqual({ ok: true, value: { label: null, status: 'inactive' } });
    expect(parseCredentialUpdate({ status: 'expired' }, 'certificate').ok).toBe(false);
    expect(parseCredentialUpdate({ external_reference: 'x' }, 'certificate').ok).toBe(false);
    expect(parseCredentialUpdate({ external_reference: 'x' }, 'external_reference').ok).toBe(true);
  });
});
