// Unit tests for api/src/domain/documentId.ts — pure functions, no DB/HTTP.
import { describe, expect, it } from 'vitest';
import { maskDocumentId, validateDocumentId } from '../domain/documentId';

describe('validateDocumentId() — null/empty/whitespace', () => {
  it('accepts null as "no document"', () => {
    const r = validateDocumentId(null);
    expect(r.valid).toBe(true);
    expect(r.normalized).toBeNull();
  });

  it('accepts undefined as "no document"', () => {
    const r = validateDocumentId(undefined);
    expect(r.valid).toBe(true);
    expect(r.normalized).toBeNull();
  });

  it('accepts an empty string as "clear the field"', () => {
    const r = validateDocumentId('');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBeNull();
  });

  it('rejects a whitespace-only value', () => {
    const r = validateDocumentId('   ');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('whitespace_only');
  });

  it('rejects a tab/newline-only value', () => {
    const r = validateDocumentId('\t\n');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('whitespace_only');
  });
});

describe('validateDocumentId() — NIF', () => {
  it('accepts a valid NIF (12345678Z)', () => {
    const r = validateDocumentId('12345678Z');
    expect(r.valid).toBe(true);
    expect(r.type).toBe('nif');
    expect(r.normalized).toBe('12345678Z');
  });

  it('accepts a valid NIF with surrounding whitespace and lowercase letter', () => {
    const r = validateDocumentId('  12345678z  ');
    expect(r.valid).toBe(true);
    expect(r.type).toBe('nif');
    expect(r.normalized).toBe('12345678Z');
  });

  it('rejects a NIF with an incorrect control letter', () => {
    const r = validateDocumentId('12345678A');
    expect(r.valid).toBe(false);
    expect(r.type).toBe('nif');
    expect(r.code).toBe('invalid_control_letter');
  });

  it('does not fall back to passport validation for an NIF-shaped value with a bad control letter', () => {
    // 8 digits + letter is NIF-shaped; a bad letter must be rejected outright,
    // never silently accepted as a "passport".
    const r = validateDocumentId('00000000A'); // correct letter for 0 is T
    expect(r.valid).toBe(false);
    expect(r.type).toBe('nif');
    expect(r.code).toBe('invalid_control_letter');
  });
});

describe('validateDocumentId() — NIE', () => {
  // Reference valid NIEs for each prefix, control letter computed via the
  // documented algorithm (prefix->digit, then NIF control-letter sequence).
  it('accepts a valid NIE with X prefix', () => {
    const r = validateDocumentId('X1234567L');
    expect(r.valid).toBe(true);
    expect(r.type).toBe('nie');
    expect(r.normalized).toBe('X1234567L');
  });

  it('accepts a valid NIE with Y prefix', () => {
    // Y1234567 -> prefix digit 1 -> "11234567" % 23 -> letter
    const r = validateDocumentId('Y1234567X');
    expect(r.valid).toBe(true);
    expect(r.type).toBe('nie');
    expect(r.normalized).toBe('Y1234567X');
  });

  it('accepts a valid NIE with Z prefix', () => {
    // Z1234567 -> prefix digit 2 -> "21234567" % 23 -> letter
    const r = validateDocumentId('Z1234567R');
    expect(r.valid).toBe(true);
    expect(r.type).toBe('nie');
    expect(r.normalized).toBe('Z1234567R');
  });

  it('accepts a lowercase NIE and normalizes to uppercase', () => {
    const r = validateDocumentId('x1234567l');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('X1234567L');
  });

  it('rejects a NIE with an incorrect control letter', () => {
    const r = validateDocumentId('X1234567A');
    expect(r.valid).toBe(false);
    expect(r.type).toBe('nie');
    expect(r.code).toBe('invalid_control_letter');
  });

  it('does not fall back to passport validation for an NIE-shaped value with a bad control letter', () => {
    const r = validateDocumentId('Y0000000A'); // correct letter for prefix 1 + 0000000 is not A
    expect(r.valid).toBe(false);
    expect(r.type).toBe('nie');
    expect(r.code).toBe('invalid_control_letter');
  });
});

describe('validateDocumentId() — Passport', () => {
  it('accepts a plausible alphanumeric passport number', () => {
    const r = validateDocumentId('AB1234567');
    expect(r.valid).toBe(true);
    expect(r.type).toBe('passport');
    expect(r.normalized).toBe('AB1234567');
  });

  it('preserves the original case for a passport value', () => {
    const r = validateDocumentId('aB1234567');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('aB1234567');
  });

  it('rejects a passport value containing unsupported special characters', () => {
    const r = validateDocumentId('AB-123 456!');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('invalid_characters');
  });

  it('rejects a passport value that is too short', () => {
    const r = validateDocumentId('AB');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('invalid_length');
  });

  it('rejects a passport value that is too long', () => {
    const r = validateDocumentId('A'.repeat(25));
    expect(r.valid).toBe(false);
    expect(r.code).toBe('invalid_length');
  });
});

describe('maskDocumentId()', () => {
  it('returns null for null/undefined', () => {
    expect(maskDocumentId(null)).toBeNull();
    expect(maskDocumentId(undefined)).toBeNull();
  });

  it('masks all but the last 4 characters of a long value', () => {
    expect(maskDocumentId('12345678Z')).toBe('*****678Z');
  });

  it('masks a short value entirely', () => {
    expect(maskDocumentId('AB')).toBe('**');
  });

  it('never returns the raw value for a realistic NIF', () => {
    const masked = maskDocumentId('12345678Z');
    expect(masked).not.toBe('12345678Z');
  });
});
