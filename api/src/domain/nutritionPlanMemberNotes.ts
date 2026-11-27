/**
 * #3474: Member Notes on a Nutrition Plan (template, Base template or assigned plan).
 *
 * A free-text note for the member, distinct from the plan's `description`. Judged here
 * once for every write route, with the three answers of every partial write: a request
 * that does not mention the field keeps what is stored, an explicit `null` or a blank
 * string clears it, a string sets it (trimmed) and anything else is a 400, never coerced.
 */
export const MEMBER_NOTES_MAX_LENGTH = 5000;

export type MemberNotesInput =
  | { kind: 'absent' }
  | { kind: 'value'; value: string | null }
  | { kind: 'error'; error: string };

export function parseMemberNotesInput(body: unknown): MemberNotesInput {
  if (!body || typeof body !== 'object' || !('member_notes' in body)) return { kind: 'absent' };
  const raw = (body as { member_notes?: unknown }).member_notes;
  if (raw === null) return { kind: 'value', value: null };
  if (typeof raw !== 'string') return { kind: 'error', error: 'member_notes must be a string or null' };
  const value = raw.trim();
  if (value.length > MEMBER_NOTES_MAX_LENGTH) {
    return { kind: 'error', error: `member_notes may not exceed ${MEMBER_NOTES_MAX_LENGTH} characters` };
  }
  return { kind: 'value', value: value === '' ? null : value };
}

/** The SQL `SET` fragment's two parameters: whether to write, and the value (`member_notes = IF(?, ?, member_notes)`). */
export function memberNotesSetParams(input: MemberNotesInput): [number, string | null] {
  return input.kind === 'value' ? [1, input.value] : [0, null];
}
