/**
 * An Exercise's Equipment (#2362). `exercises.equipment` / `base_exercises.equipment`
 * is the free-text axis preserved from the Free Exercise DB (#964), not a
 * declared vocabulary: what the editor's dropdown offers is the values already
 * present in the catalogue (the facets read), so no second Equipment entity or
 * list exists. This is the one place a request's value is judged: absent keeps
 * what is stored, `null`/blank clears, a string is trimmed and stored, anything
 * else (or more than the column's width) is a 400, never a coercion.
 */
export const EXERCISE_EQUIPMENT_MAX_LENGTH = 60;

export interface ExerciseEquipmentInput {
  provided: boolean;
  value: string | null;
  error?: string;
}

export function parseExerciseEquipmentInput(body: Record<string, unknown> | undefined): ExerciseEquipmentInput {
  if (!body || !('equipment' in body)) return { provided: false, value: null };
  const raw = body.equipment;
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return { provided: true, value: null };
  if (typeof raw !== 'string') return { provided: true, value: null, error: 'equipment must be a string' };
  const value = raw.trim();
  if (value.length > EXERCISE_EQUIPMENT_MAX_LENGTH) {
    return { provided: true, value: null, error: `equipment must be at most ${EXERCISE_EQUIPMENT_MAX_LENGTH} characters` };
  }
  return { provided: true, value };
}
