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

/**
 * #1229 — a target is either an **absolute** final value ("80 kg") or a
 * **relative** change from the baseline measurement ("+2 kg", "-5 kg"). The
 * type is part of the target, on the catalogue (`personal_goals`) and on the
 * assignment snapshot (`member_personal_goals`, migration 245). `absolute` is
 * the default, which is what every target written before the ticket means.
 * Mirrored by `chk_pgoal_target_type` / `chk_mpgoal_target_type` and for the
 * browser in the admin's `goalProfile.ts`.
 */
export const TARGET_TYPES = ['absolute', 'relative'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export function isTargetType(value: unknown): value is TargetType {
  return typeof value === 'string' && (TARGET_TYPES as readonly string[]).includes(value);
}

/** `undefined` = not mentioned (keep), anything unknown is a 400, never coerced. */
export function normalizeTargetType(input: unknown): Normalized<TargetType | undefined> {
  if (input === undefined) return { value: undefined };
  if (isTargetType(input)) return { value: input };
  return { error: `target_type must be one of: ${TARGET_TYPES.join(', ')}` };
}

/**
 * `allowNegative` lets a value through that only a **relative** target may hold;
 * the caller then asks `targetPairError()` with the type the write ends up
 * with, because a `PUT` that sends `-5` without a type is judged against the
 * stored one.
 */
export function normalizeTargetValue(
  input: unknown,
  { allowNegative = false }: { allowNegative?: boolean } = {},
): Normalized<number | null | undefined> {
  if (input === undefined) return { value: undefined };
  if (input === null || input === '') return { value: null };
  const n = typeof input === 'number' ? input : Number(input);
  if (typeof input !== 'number' && typeof input !== 'string') {
    return { error: 'target_value must be a number' };
  }
  if (!Number.isFinite(n)) return { error: 'target_value must be a number' };
  if (n < 0 && !allowNegative) return { error: 'target_value must be zero or greater' };
  if (Math.abs(n) > TARGET_VALUE_MAX) return { error: `target_value must be at most ${TARGET_VALUE_MAX}` };
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
  /** Omitted = absolute, the pre-#1229 behaviour. */
  targetType?: TargetType;
}): string | null {
  if (next.targetValue !== null && next.targetValue < 0 && (next.targetType ?? 'absolute') !== 'relative') {
    return 'target_value must be zero or greater';
  }
  if (next.targetUnit !== null && next.targetValue === null) {
    return 'target_unit requires a target_value';
  }
  return null;
}

/**
 * #1229 — the value a reading is measured against. An absolute target is its own
 * value; a relative one is `baseline + target`, and without a baseline it is
 * `null` ("not computable", rendered `—`), never the bare change.
 *
 * The baseline is the assignment's **first** reading — the fixed starting
 * measurement — and deliberately not the active initial reading: a later
 * `set_initial_reading` period must not move the effective target of an
 * existing assignment (the thread's answer to Q3).
 */
export function effectiveTarget(input: {
  targetType: TargetType;
  targetValue: number | null;
  baseline: number | null;
}): number | null {
  if (input.targetValue === null) return null;
  if (input.targetType === 'absolute') return input.targetValue;
  if (input.baseline === null) return null;
  return Math.round((input.baseline + input.targetValue) * 100) / 100;
}
