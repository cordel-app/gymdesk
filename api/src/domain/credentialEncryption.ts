// #2647 stage 3 — authenticated encryption of compliance credential material.
//
// The one place a certificate file and its password are encrypted or decrypted.
// AES-256-GCM under a 32-byte key from `COMPLIANCE_CREDENTIALS_ENCRYPTION_KEY`
// (base64), with the owning gym and the object key as additional authenticated
// data, so an envelope copied onto another gym's row or object does not decrypt.
//
// Envelope: `GDC1` (4 bytes) | IV (12) | auth tag (16) | ciphertext.
// Plaintext: JSON `{ "pfx": "<base64>", "passphrase": "<string>" }`.
// Nothing here logs, and nothing returns the material except `decryptCredentialMaterial`.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const ENCRYPTION_KEY_ENV = 'COMPLIANCE_CREDENTIALS_ENCRYPTION_KEY';
const MAGIC = Buffer.from('GDC1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface CredentialMaterial {
  pfx: Buffer;
  passphrase: string;
}

/** The key, or null when the variable is unset or not 32 bytes of base64. */
export function parseEncryptionKey(raw: string | undefined | null): Buffer | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const key = Buffer.from(s, 'base64');
  return key.length === 32 ? key : null;
}

export function credentialEncryptionKey(): Buffer | null {
  return parseEncryptionKey(process.env[ENCRYPTION_KEY_ENV]);
}

function aad(gymId: string, objectKey: string): Buffer {
  return Buffer.from(`${gymId}\n${objectKey}`, 'utf8');
}

export function encryptCredentialMaterial(key: Buffer, gymId: string, objectKey: string, m: CredentialMaterial): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(gymId, objectKey));
  const plain = Buffer.from(JSON.stringify({ pfx: m.pfx.toString('base64'), passphrase: m.passphrase }), 'utf8');
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  plain.fill(0);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

/** Throws when the envelope is malformed, was tampered with, or belongs to another gym or object. */
export function decryptCredentialMaterial(key: Buffer, gymId: string, objectKey: string, envelope: Buffer): CredentialMaterial {
  if (envelope.length < MAGIC.length + IV_BYTES + TAG_BYTES + 1 || !envelope.subarray(0, 4).equals(MAGIC)) {
    throw new Error('Unrecognised credential envelope');
  }
  const iv = envelope.subarray(4, 4 + IV_BYTES);
  const tag = envelope.subarray(4 + IV_BYTES, 4 + IV_BYTES + TAG_BYTES);
  const ct = envelope.subarray(4 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad(gymId, objectKey));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  const parsed = JSON.parse(plain.toString('utf8')) as { pfx: string; passphrase: string };
  plain.fill(0);
  return { pfx: Buffer.from(parsed.pfx, 'base64'), passphrase: parsed.passphrase };
}
