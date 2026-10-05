/**
 * #1034 §1/§13 — what a **goal target** is: one number and the unit that says
 * what the number counts.
 *
 * It exists because the pair now lives in **two** places and must mean the same
 * thing in both: on a Personal Goal in the gym's catalogue (`personal_goals`,
 * migration 218 — the reusable "Lose weight / 3 kg") and on the assignment a
 * member holds (`member_personal_goals`, migration 212 — the snapshot "Lose
 * weight / 5 kg" agreed with *this* member). §1's "do not introduce a second,
 * incompatible unit system" is a rule about exactly that: the catalogue's unit is
 * the assignment's unit, same column type, same normalizer, same cross-field
 * rule, so a target typed in one screen cannot be refused by the other.
 *
 * The unit is deliberately **free text**, not a closed vocabulary. There is no
 * measurement-unit enum anywhere in this codebase to reuse (the only `*_UNITS`
 * lists are billing periods, which are a different concept), so declaring one
 * here would *be* the second system §1 forbids — and a gym measuring a goal in
 * `lb`, `mmol/L` or `laps` is not an error. What is bounded is the column:
 * VARCHAR(20), trimmed, with an empty string read as "no unit".
 *
 * `personalGoalAssignment.ts` re-exports every one of these so the assignment
 * side keeps its own vocabulary in one import, and `goalLibrary.ts` uses them
 * directly for the catalogue.
 */

/**
 * Every normalizer answers one of three things, and the first is the
 * load-bearing one: **`undefined` means the request did not mention the field**,
 * so a `PUT` leaves the stored value exactly as it is. `null` is an explicit
 * clear, and a value is a value. A normalizer that collapsed the first two would
 * make every partial update wipe the fields it did not carry — the distinction
 * CLAUDE.md draws for every replace-all section `PUT` in the codebase.
 */
export type Normalized<T> = { value: T } | { error: string };

/** `target_unit` is VARCHAR(20) on both tables (migrations 212 and 218). */
export const TARGET_UNIT_MAX_LENGTH = 20;

/** `target_value` is DECIMAL(10,2): eight integer digits and two decimals. */
export const TARGET_VALUE_MAX = 99999999.99;

export function normalizeTargetValue(input: unknown): Normalized<number | null | undefined> {
  if (input === undefined) return { value: undefined };
  if (input === null || input === '') return { value: null };
  const n = typeof input === 'number' ? input : Number(input);
  if (typeof input !== 'number' && typeof input !== 'string') {
    return { error: 'target_value must be a number' };
  }
  if (!Number.isFinite(n)) return { error: 'target_value must be a number' };
  if (n < 0) return { error: 'target_value must be zero or greater' };
  if (n > TARGET_VALUE_MAX) return { error: `target_value must be at most ${TARGET_VALUE_MAX}` };
  // Rounded to the column's own scale rather than refused: a target typed as
  // `5.005` is a human entering a weight, not an error worth a 400, and storing
  // it unrounded would read back as something the form never submitted.
  return { value: Math.round(n * 100) / 100 };
}

export function normalizeTargetUnit(input: unknown): Normalized<string | null | undefined> {
  if (input === undefined) return { value: undefined };
  if (input === null) return { value: null };
  if (typeof input !== 'string') return { error: 'target_unit must be a string' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { value: null };
  if (trimmed.length > TARGET_UNIT_MAX_LENGTH) {
    return { error: `target_unit must be at most ${TARGET_UNIT_MAX_LENGTH} characters` };
  }
  return { value: trimmed };
}

/**
 * The one cross-field rule, applied to the values a write will *end up* with
 * rather than to the ones it submitted — a `PUT` that clears `target_value`
 * while leaving a stored `target_unit` in place is the case a per-field check
 * misses, and the CHECK beside each table would answer it as a driver error (a
 * bare 500, #966) instead of the 400 it is.
 *
 * It checks one direction only, exactly as `chk_pgoal_target_unit` and
 * `chk_mpgoal_target_unit` do: a unit answers "5 of what", so with no value
 * there is nothing for it to qualify, while a value with no unit ("lose 5") is
 * incomplete rather than contradictory. Do not "complete" either of them.
 */
export function targetPairError(next: {
  targetValue: number | null;
  targetUnit: string | null;
}): string | null {
  if (next.targetUnit !== null && next.targetValue === null) {
    return 'target_unit requires a target_value';
  }
  return null;
}
