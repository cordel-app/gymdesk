/**
 * The Exercise Type taxonomy, declared once.
 *
 * These are the three values `exercises.exercise_type` has carried since
 * migration 071 (#130) and the ones its `exercises_exercise_type_check` CHECK
 * permits — a *measurement* axis: how a set of this exercise is counted. A new
 * value therefore goes in **two** places, this list and that CHECK.
 *
 * #964 is what gave it a reader again: the Free Exercise DB import maps the
 * dataset's `category` onto it (`classifyExerciseType()` in
 * `domain/freeExerciseDb.ts`) and the Base Exercises list filters on it. Note
 * that the equipment-shaped list #964 §7 calls "Exercise Type" — Bodyweight,
 * Machine, Dumbbell, … — is *not* this taxonomy and is not one: it is the
 * dataset's own `equipment` value, preserved verbatim in `exercises.equipment`.
 * Do not add an equipment value here, and do not introduce a second exercise-type
 * vocabulary beside this one.
 */
export const EXERCISE_TYPES = ['reps', 'time', 'distance'] as const;

export type ExerciseType = (typeof EXERCISE_TYPES)[number];

export function isExerciseType(value: unknown): value is ExerciseType {
  return typeof value === 'string' && (EXERCISE_TYPES as readonly string[]).includes(value);
}
