// Field visibility per Workout Block type (issue #60, narrowed by #672). Name,
// Type and Optional are always shown; this config governs the type-specific
// block-level configuration only.
export const BLOCK_TYPES = ['Standard', 'Superset', 'Triset', 'GiantSet', 'Circuit', 'EMOM', 'AMRAP', 'Tabata'];

/** Column a block's configuration value is persisted in. */
export type BlockConfigColumn = 'rounds' | 'duration_seconds';

export interface BlockConfig {
  /** Column the value is read from and written back to. */
  column: BlockConfigColumn;
  /** Stored units per displayed unit — 60 for "Minutes" over `duration_seconds`. */
  storedPerUnit: number;
  /** i18n key for the field label. */
  labelKey: string;
  /** i18n key for the "{n} <unit>" chip in block summaries. */
  summaryKey: string;
}

/* #672: a block type has **at most one** block-level numeric configuration.
 *   Standard / Superset / Triset / Giant Set → none
 *   Circuit                                  → Rounds
 *   EMOM / AMRAP                             → Minutes
 *   Tabata                                   → Intervals
 * Sets stay an exercise-level field and are not represented here.
 *
 * Minutes are a display unit over the existing `duration_seconds` column, and a
 * Tabata block's Intervals are stored in `rounds` — no column was added, so
 * blocks written before #672 keep reading back unchanged. `work_seconds` and
 * `rest_seconds` are no longer offered by any type; existing values stay in the
 * row (see the "don't clear hidden fields" rule in docs/feature-patterns.md) but
 * are neither displayed nor editable. */
export const BLOCK_TYPE_CONFIG: Record<string, BlockConfig | null> = {
  Standard: null,
  Superset: null,
  Triset: null,
  GiantSet: null,
  Circuit: {
    column: 'rounds', storedPerUnit: 1,
    labelKey: 'workout_template_blocks.col_rounds',
    summaryKey: 'training_plan_templates.summary_rounds',
  },
  EMOM: {
    column: 'duration_seconds', storedPerUnit: 60,
    labelKey: 'workout_template_blocks.col_minutes',
    summaryKey: 'training_plan_templates.summary_min',
  },
  AMRAP: {
    column: 'duration_seconds', storedPerUnit: 60,
    labelKey: 'workout_template_blocks.col_minutes',
    summaryKey: 'training_plan_templates.summary_min',
  },
  Tabata: {
    column: 'rounds', storedPerUnit: 1,
    labelKey: 'workout_template_blocks.col_intervals',
    summaryKey: 'training_plan_templates.summary_intervals',
  },
};

/** The single configuration field a block type exposes, or null when it has none. */
export function getBlockConfig(type: string): BlockConfig | null {
  return BLOCK_TYPE_CONFIG[type] ?? null;
}

/** Just the block columns the configuration is read from. */
export interface BlockConfigValues {
  rounds: number | null;
  duration_seconds: number | null;
}

/** Stored column value → the number shown in the input (minutes for EMOM/AMRAP). */
export function blockConfigDisplayValue(cfg: BlockConfig, block: BlockConfigValues): number | null {
  const stored = block[cfg.column];
  if (stored == null) return null;
  return cfg.storedPerUnit === 1 ? stored : Math.round(stored / cfg.storedPerUnit);
}

/** A block's configuration as an input string ('' when its type has no configuration). */
export function blockConfigInput(block: { type: string } & BlockConfigValues): string {
  const cfg = getBlockConfig(block.type);
  if (!cfg) return '';
  const value = blockConfigDisplayValue(cfg, block);
  return value != null ? String(value) : '';
}

/** Input string → the block patch for that type's configuration column. */
export function blockConfigPatch(cfg: BlockConfig, input: string): Record<string, number | null> {
  const parsed = input.trim() === '' ? null : parseInt(input, 10);
  const stored = parsed == null || Number.isNaN(parsed) ? null : parsed * cfg.storedPerUnit;
  return { [cfg.column]: stored };
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
