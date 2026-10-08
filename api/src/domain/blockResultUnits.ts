/**
 * #1232: a workout block's *global result* — the single figure a member
 * records for a whole Circuit / EMOM / AMRAP / Tabata ("8 Rounds",
 * "10 Minutes") — and the unit that makes it meaningful.
 *
 * This is the one place that says which units exist, which block types may
 * carry a result at all and which units fit each, and how a recorded value is
 * judged. The unit lives on the block configuration (`result_unit` on
 * `workout_template_blocks` / `workout_blocks`) and is **snapshotted onto each
 * log** (`workout_block_logs.result_unit`), so a result stays interpretable
 * after the block is reconfigured. There is no CHECK on any of the three
 * columns (`ADD CONSTRAINT` rebuilds large tables under ALGORITHM=COPY); this
 * list is the vocabulary, and extending it is one edit here plus a label key.
 */
export const BLOCK_RESULT_UNITS = ['rounds', 'reps', 'seconds', 'minutes', 'meters', 'calories'] as const;
export type BlockResultUnit = (typeof BLOCK_RESULT_UNITS)[number];

/** Block types that can carry a global result, and the units each may use. */
export const BLOCK_TYPE_RESULT_UNITS: Record<string, readonly BlockResultUnit[]> = {
  Circuit: ['rounds', 'reps', 'seconds', 'minutes', 'meters', 'calories'],
  EMOM: ['rounds', 'reps', 'calories', 'meters'],
  AMRAP: ['rounds', 'reps', 'calories', 'meters'],
  Tabata: ['rounds', 'reps', 'calories'],
};

/** Units whose recorded value must be a whole number. */
const WHOLE_NUMBER_UNITS: readonly BlockResultUnit[] = ['rounds', 'reps', 'calories'];

export function resultUnitsForBlockType(type: string): readonly BlockResultUnit[] {
  return BLOCK_TYPE_RESULT_UNITS[type] ?? [];
}

/**
 * Judges a request's `result_unit` for a block of `type`. Empty / absent is
 * "no global result" (`null`). An unknown unit, a unit the type does not allow
 * and any unit on a type that supports none are errors, never coerced.
 */
export function parseBlockResultUnit(type: string, raw: unknown): { unit: string | null } | string {
  if (raw == null || raw === '') return { unit: null };
  if (typeof raw !== 'string') return 'result_unit must be a string';
  const unit = raw.trim().toLowerCase();
  if (!(BLOCK_RESULT_UNITS as readonly string[]).includes(unit)) {
    return `result_unit must be one of: ${BLOCK_RESULT_UNITS.join(', ')}`;
  }
  const allowed = resultUnitsForBlockType(type);
  if (allowed.length === 0) return `Block type '${type}' does not support a result unit`;
  if (!(allowed as readonly string[]).includes(unit)) {
    return `Block type '${type}' allows result units: ${allowed.join(', ')}`;
  }
  return { unit };
}

/**
 * Judges a member's recorded `result_value` against the block's configured
 * unit. A block with no unit takes no result; an empty value is "no result"
 * and is always allowed (Mark done is independent of the result).
 */
export function parseBlockLogResult(blockUnit: string | null, raw: unknown): { value: string | null } | string {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return { value: null };
  if (!blockUnit) return 'This block does not record a result';
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return 'result_value must be a non-negative number';
  if ((WHOLE_NUMBER_UNITS as readonly string[]).includes(blockUnit) && !Number.isInteger(n)) {
    return `result_value must be a whole number for ${blockUnit}`;
  }
  return { value: String(n) };
}
