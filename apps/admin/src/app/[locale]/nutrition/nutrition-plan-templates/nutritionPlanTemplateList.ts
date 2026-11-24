/**
 * #3333 stage 2: what the two Nutrition Plan Template lists (a gym's own and
 * Cordel's Base one) share — the `num_days` choices, the Source a row reads as,
 * and the form → payload step. Pure (no React, no `t()`), so both pages and the
 * test assert one answer.
 *
 * `num_days` is an integer 0..7 (`chk_npt_num_days`, `parseNumDaysInput()` on
 * the API, which stays the authority); the form offers exactly those values so
 * an out-of-range number cannot be typed.
 */
export const NUM_DAYS_MIN = 0;
export const NUM_DAYS_MAX = 7;
export const NUM_DAYS_OPTIONS: readonly number[] = Array.from(
  { length: NUM_DAYS_MAX - NUM_DAYS_MIN + 1 },
  (_, i) => NUM_DAYS_MIN + i,
);

/** True for an integer the API accepts. */
export function isValidNumDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= NUM_DAYS_MIN && value <= NUM_DAYS_MAX;
}

/** A stored value read for display/seeding a form; anything unusable reads as 0. */
export function toNumDays(value: unknown): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return isValidNumDays(n) ? n : 0;
}

export type TemplateSource = 'system' | 'custom';

/**
 * Where a gym's template came from, read off the API's derived `source`
 * (`cloned_from_id` pointing at a System template) — the same System sourced /
 * Custom split the Exercises list shows. A Base template is the System row
 * itself.
 */
export function templateSource(row: { source?: string | null; gym_id?: unknown }): TemplateSource {
  if (row.gym_id === null) return 'system';
  return row.source === 'system' ? 'system' : 'custom';
}

/** Whether `⋮ → Resync with System` applies: only a gym's copy of a System template. */
export function canResyncWithSystem(row: { source?: string | null; gym_id?: unknown }): boolean {
  return row.gym_id !== null && row.source === 'system';
}

export interface TemplateForm {
  name: string;
  description: string;
  status: string;
  num_days: number;
}

export const EMPTY_TEMPLATE_FORM: TemplateForm = { name: '', description: '', status: 'active', num_days: 0 };

export function templateFormFromRow(row: { name: string; description: string | null; status: string; num_days?: unknown }): TemplateForm {
  return { name: row.name, description: row.description ?? '', status: row.status, num_days: toNumDays(row.num_days) };
}

/** The POST/PUT body; `null` with an error key when the form cannot be submitted. */
export function templatePayload(form: TemplateForm):
  | { ok: true; body: { name: string; description: string | null; status: string; num_days: number } }
  | { ok: false; errorKey: 'error_required' | 'error_num_days' } {
  const name = form.name.trim();
  if (!name) return { ok: false, errorKey: 'error_required' };
  if (!isValidNumDays(form.num_days)) return { ok: false, errorKey: 'error_num_days' };
  return { ok: true, body: { name, description: form.description.trim() || null, status: form.status, num_days: form.num_days } };
}
