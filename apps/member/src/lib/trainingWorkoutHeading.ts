// #3465 — what My Training's Workout heading says, in the visual hierarchy of
// My Nutrition's meal groups (#3428): the assigned Training Plan's name once,
// then per Workout a circular thumbnail, its name and notes, and a
// completed-blocks counter.
//
// Pure, no React and no `t()`. Every value is read from the plan tree
// `GET /me/training-plans` already returns: the thumbnail is the first
// exercise's own effective image (#1368 stage 4 — nothing is stored or
// fetched for it), the notes are the Workout's `description` (the column the
// Admin's Workout notes write), and "done" is the set of block ids the page
// already derives from `/me/workout-block-logs` for the selected date, so the
// counter moves with Mark done and needs no completion rule of its own.

export interface HeadingExercise {
  position: number;
  exercise_name: string;
  exercise_image_url?: string | null;
  exercise_image_thumbnail_url?: string | null;
}

export interface HeadingBlock {
  id: number;
  position: number;
  exercises: HeadingExercise[] | null;
}

export interface HeadingWorkout {
  description: string | null;
  blocks: HeadingBlock[] | null;
}

/** The placeholder a Workout with no exercise image shows inside its circle. */
export const WORKOUT_THUMBNAIL_PLACEHOLDER = 'WO';

/** The circle's diameter: the meal-group thumbnail's (`MEAL_THUMBNAIL_SIZE`, #3428). */
export { MEAL_THUMBNAIL_SIZE as WORKOUT_THUMBNAIL_SIZE } from './mealThumbnail';

const byPosition = <T extends { position: number }>(rows: T[] | null | undefined): T[] =>
  [...(rows ?? [])].sort((a, b) => a.position - b.position);

/** The Workout's first exercise, in block then exercise order; `null` when it has none. */
export function firstWorkoutExercise<E extends HeadingExercise>(
  workout: { blocks: { position: number; exercises: E[] | null }[] | null },
): E | null {
  for (const block of byPosition(workout.blocks)) {
    const first = byPosition(block.exercises)[0];
    if (first) return first;
  }
  return null;
}

export interface WorkoutThumbnailView {
  /** The circle's picture (the thumbnail, the master for an exercise that has none); `null` draws the placeholder. */
  thumbnailSrc: string | null;
  /** The enlarged picture a tap opens; `null` means there is nothing to enlarge. */
  fullSrc: string | null;
  /** The exercise the picture belongs to, for its alt text. */
  exerciseName: string | null;
}

export function workoutThumbnailView(workout: HeadingWorkout): WorkoutThumbnailView {
  const first = firstWorkoutExercise(workout);
  const full = first?.exercise_image_url || null;
  const thumb = first?.exercise_image_thumbnail_url || full;
  return { thumbnailSrc: thumb ?? null, fullSrc: full ?? thumb ?? null, exerciseName: first?.exercise_name ?? null };
}

/** The Workout's notes as the heading shows them; `null` when blank. */
export function workoutNotes(workout: HeadingWorkout): string | null {
  return workout.description?.trim() || null;
}

/** Blocks marked Done on the selected date over the Workout's blocks (never its exercises). */
export function workoutBlockCounter(workout: HeadingWorkout, doneBlockIds: ReadonlySet<number>): { done: number; total: number } {
  const blocks = workout.blocks ?? [];
  return { done: blocks.filter((b) => doneBlockIds.has(b.id)).length, total: blocks.length };
}

/**
 * The day's Workouts grouped under their Training Plan, in order of first
 * appearance, so each plan's name is shown once above its first Workout and
 * never repeated beside one. Members normally hold one plan; one holding two on
 * the same date reads each name once, with that plan's Workouts under it.
 */
export function groupWorkoutsByPlan<P extends { id: number }, W>(
  entries: { plan: P; workout: W }[],
): { plan: P; workouts: W[] }[] {
  const groups: { plan: P; workouts: W[] }[] = [];
  for (const e of entries) {
    const group = groups.find((g) => g.plan.id === e.plan.id);
    if (group) group.workouts.push(e.workout);
    else groups.push({ plan: e.plan, workouts: [e.workout] });
  }
  return groups;
}
