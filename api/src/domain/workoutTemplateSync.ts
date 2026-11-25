/**
 * #3335: what a gym's copy of a System Workout Template takes from it on
 * "Resync with System" — its own fields (name, description, notes). The blocks
 * and their exercises are the gym's own once imported and are never compared or
 * replaced, as #3333/#3334 decided for the plan templates. `num_blocks` is
 * derived on read from the blocks, so it needs no resync of its own.
 */
export { templateSource } from './trainingPlanTemplateDays';
export type { TemplateSource } from './trainingPlanTemplateDays';

export interface WorkoutTemplateSyncFields {
  name: string;
  description: string | null;
  notes: string | null;
}

export function workoutTemplateResyncChanges(
  copy: WorkoutTemplateSyncFields,
  base: WorkoutTemplateSyncFields,
): (keyof WorkoutTemplateSyncFields)[] {
  const changed: (keyof WorkoutTemplateSyncFields)[] = [];
  if (copy.name !== base.name) changed.push('name');
  if ((copy.description ?? null) !== (base.description ?? null)) changed.push('description');
  if ((copy.notes ?? null) !== (base.notes ?? null)) changed.push('notes');
  return changed;
}
