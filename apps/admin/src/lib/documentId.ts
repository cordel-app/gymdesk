/**
 * #513: NIF/NIE/Passport identification-document validation.
 *
 * Mirrors `api/src/domain/documentId.ts` verbatim for immediate client-side
 * feedback (the backend copy remains authoritative). This repo has no
 * shared npm package between `api/` and `apps/admin/`, so logic that needs
 * to run in both places is duplicated and kept in sync manually — the same
 * pattern as `api/src/domain/themeTokens.ts` / `apps/admin/src/lib/themeTokens.ts`
 * and `api/src/infra/permissions.ts` / `apps/admin/src/config/permissions.ts`.
 * If either copy changes, update both.
 */

export type DocumentIdType = 'nif' | 'nie' | 'passport';

export type DocumentIdErrorCode =
  | 'whitespace_only'
  | 'invalid_control_letter'
  | 'invalid_characters'
  | 'invalid_length';

export interface DocumentIdValidationResult {
  valid: boolean;
  normalized: string | null;
  type?: DocumentIdType;
  code?: DocumentIdErrorCode;
  message?: string;
}

const NIF_CONTROL_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
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
  return { valid: true, normalized: trimmed, type: 'passport' };
}
