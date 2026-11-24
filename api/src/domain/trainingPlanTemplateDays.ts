/**
 * #3334: a Training Plan Template's `num_days` — an integer 0..7, mirrored by
 * `chk_tpt_num_days` (migration 481). The one place a request's value is judged:
 * absent keeps what is stored, anything else must be an integer in range, never
 * coerced (a string "3" is refused, as is 3.5, 8 or null).
 */
export const NUM_DAYS_MIN = 0;
export const NUM_DAYS_MAX = 7;

export type NumDaysInput =
  | { kind: 'absent' }
  | { kind: 'value'; value: number }
  | { kind: 'error'; error: string };

export function parseNumDaysInput(body: Record<string, unknown> | null | undefined): NumDaysInput {
  if (!body || !('num_days' in body) || body.num_days === undefined) return { kind: 'absent' };
  const v = body.num_days;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < NUM_DAYS_MIN || v > NUM_DAYS_MAX) {
    return { kind: 'error', error: `num_days must be an integer between ${NUM_DAYS_MIN} and ${NUM_DAYS_MAX}` };
  }
  return { kind: 'value', value: v };
}

/** What a gym copy takes from its System template on "Resync with System". */
export interface TemplateSyncFields {
  name: string;
  description: string | null;
  num_days: number;
}

/**
 * The fields of a gym copy that differ from its System template — the resync's
 * whole decision. The plan's workouts are the gym's own once imported and are
 * never compared or replaced (the Exercises resync leaves muscles alone the same way).
 */
export function templateResyncChanges(copy: TemplateSyncFields, base: TemplateSyncFields): (keyof TemplateSyncFields)[] {
  const changed: (keyof TemplateSyncFields)[] = [];
  if (copy.name !== base.name) changed.push('name');
  if ((copy.description ?? null) !== (base.description ?? null)) changed.push('description');
  if (Number(copy.num_days) !== Number(base.num_days)) changed.push('num_days');
  return changed;
}

/** `source` reported on a gym row: `system` when it was imported/cloned from a System template. */
export type TemplateSource = 'system' | 'custom';
export function templateSource(clonedFromId: number | null | undefined): TemplateSource {
  return clonedFromId != null ? 'system' : 'custom';
}
