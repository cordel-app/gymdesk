/**
 * #3334: a Training Plan Template's `num_days` (0..7, `chk_tpt_num_days`,
 * migration 481) and its resync fields are judged by the very rules #3333 gave
 * Nutrition Plan Templates — one implementation, re-exported here so the two
 * template kinds cannot disagree about what a valid `num_days` or a resync is.
 */
export {
  NUM_DAYS_MIN, NUM_DAYS_MAX, parseNumDaysInput, templateResyncChanges,
} from './nutritionPlanTemplateDays';
export type { NumDaysInput, TemplateSyncFields } from './nutritionPlanTemplateDays';

/** `source` reported on a gym row: `system` when it was imported/cloned from a System template. */
export type TemplateSource = 'system' | 'custom';
export function templateSource(clonedFromId: number | null | undefined): TemplateSource {
  return clonedFromId != null ? 'system' : 'custom';
}
