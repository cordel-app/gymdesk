/**
 * #513: NIF/NIE/Passport identification-document validation.
 *
 * Pure, DB-free validation for the `members.nif_nie_passport` field. Used by
 * `api/src/api/members.ts` for authoritative server-side validation and
 * mirrored (verbatim logic) at `apps/admin/src/lib/documentId.ts` for
 * immediate client-side feedback — the same pattern already used for
 * `api/src/domain/themeTokens.ts` / `apps/admin/src/lib/themeTokens.ts` and
 * `api/src/infra/permissions.ts` / `apps/admin/src/config/permissions.ts`,
 * since this repo has no shared npm package built between `api/` and
 * `apps/admin/` (see docs/architecture.md). If either copy changes, update
 * both.
 *
 * Type detection (no explicit type selector — see the ticket):
 *   1. NIE shape (X/Y/Z + 7 digits + letter) → validate as NIE.
 *   2. else NIF shape (8 digits + letter) → validate as NIF.
 *   3. else → validate as Passport.
 * A value with NIF/NIE *shape* but a wrong control letter is rejected
 * outright — it must never silently fall through to Passport validation.
 */

export type DocumentIdType = 'nif' | 'nie' | 'passport';

export type DocumentIdErrorCode =
  | 'whitespace_only'
  | 'invalid_control_letter'
  | 'invalid_characters'
  | 'invalid_length';

export interface DocumentIdValidationResult {
  valid: boolean;
  /** Value to persist. null means "no document" (field cleared/absent). */
  normalized: string | null;
  /** Detected type — present once a shape/type has been determined. */
  type?: DocumentIdType;
  /** Present when valid === false; lets callers map to a translated message. */
  code?: DocumentIdErrorCode;
  /** Plain-English message for API error responses (backend errors are not localized — see docs/feature-patterns.md). */
  message?: string;
}

// Standard Spanish NIF/NIE control-letter sequence: letter = sequence[number % 23].
const NIF_CONTROL_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

// NIE prefix → leading digit substituted before applying the NIF algorithm.
const NIE_PREFIX_DIGIT: Record<string, string> = { X: '0', Y: '1', Z: '2' };

const NIE_SHAPE = /^[XYZ]\d{7}[A-Z]$/;
const NIF_SHAPE = /^\d{8}[A-Z]$/;
const PASSPORT_SHAPE = /^[A-Z0-9]+$/;

export const PASSPORT_MIN_LENGTH = 3;
export const PASSPORT_MAX_LENGTH = 20;

function controlLetterFor(eightDigits: string): string {
  const n = parseInt(eightDigits, 10) % 23;
  return NIF_CONTROL_LETTERS[n];
}

/**
 * Validates a raw `nif_nie_passport` input.
 *
 * - `null`/`undefined`/`''` are treated as "clear the field" and are valid.
 * - A string that is non-empty but only whitespace is rejected (not
 *   silently treated as "clear") — the caller explicitly typed something.
 * - Otherwise the value is trimmed, type-detected, and validated per type.
 */
export function validateDocumentId(rawValue: string | null | undefined): DocumentIdValidationResult {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return { valid: true, normalized: null };
  }
  if (rawValue.trim().length === 0) {
    return {
      valid: false,
      normalized: null,
      code: 'whitespace_only',
      message: 'NIF/NIE/Passport cannot be a whitespace-only value.',
    };
  }

  const trimmed = rawValue.trim();
  const upper = trimmed.toUpperCase();

  if (NIE_SHAPE.test(upper)) {
    const prefix = upper[0];
    const digits = upper.slice(1, 8);
    const letter = upper[8];
    const eightDigits = NIE_PREFIX_DIGIT[prefix] + digits;
    const expected = controlLetterFor(eightDigits);
    if (letter !== expected) {
      return {
        valid: false,
        normalized: null,
        type: 'nie',
        code: 'invalid_control_letter',
        message: 'Invalid NIE: the control letter does not match the document number.',
      };
    }
    return { valid: true, normalized: upper, type: 'nie' };
  }

  if (NIF_SHAPE.test(upper)) {
    const digits = upper.slice(0, 8);
    const letter = upper[8];
    const expected = controlLetterFor(digits);
    if (letter !== expected) {
      return {
        valid: false,
        normalized: null,
        type: 'nif',
        code: 'invalid_control_letter',
        message: 'Invalid NIF: the control letter does not match the document number.',
      };
    }
    return { valid: true, normalized: upper, type: 'nif' };
  }

  // Passport: alphanumeric only, no whitespace, reasonable length. The
  // NIF/NIE shapes are excluded above, so anything reaching this point that
  // *looked* like a Spanish ID has already been rejected for a bad control
  // letter rather than downgraded here.
  if (!PASSPORT_SHAPE.test(upper)) {
    return {
      valid: false,
      normalized: null,
      type: 'passport',
      code: 'invalid_characters',
      message: 'Passport number contains unsupported characters — use letters and digits only.',
    };
  }
  if (trimmed.length < PASSPORT_MIN_LENGTH || trimmed.length > PASSPORT_MAX_LENGTH) {
    return {
      valid: false,
      normalized: null,
      type: 'passport',
      code: 'invalid_length',
      message: `Passport number must be between ${PASSPORT_MIN_LENGTH} and ${PASSPORT_MAX_LENGTH} characters.`,
    };
  }
  // Preserve the original casing/characters for passports (only trimmed) —
  // unlike NIF/NIE there is no canonical uppercase convention to enforce.
  return { valid: true, normalized: trimmed, type: 'passport' };
}

/**
 * Masks a document value for audit logs — never write the raw value into
 * `audit_logs`. Keeps the last 4 characters (or fewer, for short values) so
 * an admin reviewing the log can still recognize "which document changed"
 * without exposing the full number.
 */
export function maskDocumentId(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = value.trim();
  if (v.length === 0) return null;
  if (v.length <= 4) return '*'.repeat(v.length);
  return '*'.repeat(v.length - 4) + v.slice(-4);
}
