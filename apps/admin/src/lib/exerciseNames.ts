/**
 * An exercise's name as a screen shows it, and as a picker searches it (#967).
 *
 * The server resolves the caller's language into `display_name` and falls back
 * to the base `name`, so a surface never decides which language to render — it
 * only has to prefer the resolved field, which is what `exerciseName()` is for
 * (a row read before this ticket, or one from an endpoint that projects the base
 * name alone, still renders rather than reading `undefined`).
 *
 * `exerciseMatchesQuery()` is the other half of §7: an exercise picker holds the
 * whole active catalogue in the browser and filters it there, so it matches the
 * **same** three things the API's `?q=` does — the displayed name, the base name
 * and every stored translation. Typing `Press de Banca` into a workout builder
 * then finds `Bench Press`, exactly as the Exercises list does.
 */
export interface ExerciseNameFields {
  name: string;
  display_name?: string | null;
  translations?: Record<string, string> | null;
}

export function exerciseName(ex: ExerciseNameFields): string {
  return ex.display_name ?? ex.name;
}

export function exerciseMatchesQuery(ex: ExerciseNameFields, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [ex.display_name, ex.name, ...Object.values(ex.translations ?? {})];
  return haystack.some((value) => (value ?? '').toLowerCase().includes(needle));
}
