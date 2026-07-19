// Field visibility per Workout Block type (issue #60). Name, Type and Optional
// are always shown; this config governs the type-specific fields only.
export const BLOCK_TYPES = ['Standard', 'Superset', 'Triset', 'GiantSet', 'Circuit', 'EMOM', 'AMRAP', 'Tabata'];
export const RESULT_TYPES = ['None', 'Time', 'Rounds', 'Repetitions', 'Distance', 'Calories', 'Weight', 'Score'];

export type BlockFieldKey = 'result_type' | 'rounds' | 'duration_seconds' | 'work_seconds' | 'rest_seconds';

export const BLOCK_TYPE_FIELDS: Record<string, BlockFieldKey[]> = {
  Standard: ['result_type', 'rounds'],
  Superset: ['result_type', 'rounds'],
  Triset: ['result_type', 'rounds'],
  GiantSet: ['result_type', 'rounds'],
  Circuit: ['result_type', 'rounds', 'work_seconds', 'rest_seconds'],
  EMOM: ['duration_seconds'],
  AMRAP: ['duration_seconds'],
  Tabata: ['rounds', 'work_seconds', 'rest_seconds'],
};

export function isBlockFieldVisible(type: string, field: BlockFieldKey): boolean {
  return (BLOCK_TYPE_FIELDS[type] ?? []).includes(field);
}

// null = unlimited
export const BLOCK_TYPE_MAX_EXERCISES: Record<string, number | null> = {
  Standard: 1,
  Superset: 2,
  Triset: 3,
  GiantSet: null,
  Circuit: null,
  EMOM: null,
  AMRAP: null,
  Tabata: null,
};
