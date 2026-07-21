// Field visibility per Workout Block type (issue #60). Name, Type and Optional
// are always shown; this config governs the type-specific fields only.
export const BLOCK_TYPES = ['Standard', 'Superset', 'Triset', 'GiantSet', 'Circuit', 'EMOM', 'AMRAP', 'Tabata'];

export type BlockFieldKey = 'rounds' | 'duration_seconds' | 'work_seconds' | 'rest_seconds';

export const BLOCK_TYPE_FIELDS: Record<string, BlockFieldKey[]> = {
  Standard: ['rounds'],
  Superset: ['rounds'],
  Triset: ['rounds'],
  GiantSet: ['rounds'],
  Circuit: ['rounds', 'work_seconds', 'rest_seconds'],
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
