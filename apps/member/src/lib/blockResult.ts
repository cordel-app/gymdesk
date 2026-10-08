/**
 * #1232: what the Training page shows for a block's global result. The unit
 * comes from the API (`block.result_unit`, configured by staff) and is never
 * hard-coded in a page; this module only decides whether there is an input at
 * all and which locale key words the unit. It resolves no `t()` and judges no
 * value — the API validates the number against the unit.
 */
export const BLOCK_RESULT_UNIT_KEYS: Record<string, string> = {
  rounds: 'training.result_unit_rounds',
  reps: 'training.result_unit_reps',
  seconds: 'training.result_unit_seconds',
  minutes: 'training.result_unit_minutes',
  meters: 'training.result_unit_meters',
  calories: 'training.result_unit_calories',
};

/** The locale key for a configured unit, or `null` when the block records no result (or an unknown unit). */
export function resultUnitKey(unit: string | null | undefined): string | null {
  return unit ? (BLOCK_RESULT_UNIT_KEYS[unit] ?? null) : null;
}

/** The payload value: blank is "no result", otherwise the typed number as given. */
export function resultValueForPayload(input: string | undefined): string | null {
  const v = input?.trim();
  return v ? v : null;
}
