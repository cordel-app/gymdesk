/**
 * #1849 (Exercises) — the read-only checks on the five places that reference an exercise
 * by id (`npm run exercises:audit-base-links`, and the integration test). Every check
 * counts rows that would be a problem and must be 0, except the ones flagged
 * `informational`. Foods' `baseFoodLinkAudit.ts` one catalogue over.
 *
 * Since the cut-over (migration 342, stage E5) a System exercise is referenced through
 * `base_exercise_id` alone and a gym-owned one through the old column alone: exactly one
 * on the four mandatory tables, at most one on `exercises` (provenance; its SET NULL FKs
 * cannot carry a CHECK, MySQL error 3823). Migration 343 (stage E6) deletes the legacy
 * System rows; the last checks below must read 0 before it runs.
 *
 * `gymId` narrows the reference-table checks to one gym; tests use it, the script audits
 * everything. (`exercise_logs` and `member_standalone_exercises` carry a `gym_id` too.)
 */
export interface BaseExerciseLinkCheck {
  key: string;
  description: string;
  sql: string;
  informational?: boolean;
  scoped?: boolean;
}

/** table → the old column that holds the exercise reference. */
export const EXERCISE_REFERENCE_TABLES = [
  { table: 'workout_template_exercises', column: 'exercise_id' },
  { table: 'workout_exercises', column: 'exercise_id' },
  { table: 'exercise_logs', column: 'exercise_id' },
  { table: 'member_standalone_exercises', column: 'exercise_id' },
  { table: 'exercises', column: 'cloned_from_id' },
] as const;

export function baseExerciseLinkChecks(gymId?: string): { checks: BaseExerciseLinkCheck[]; params: unknown[][] } {
  const gym = (alias: string) => (gymId ? ` AND ${alias}.gym_id = ?` : '');
  const checks: BaseExerciseLinkCheck[] = [
    {
      key: 'id_collision',
      description: 'Ids used by a Base exercise and by a gym-owned exercise',
      sql: `SELECT COUNT(*) AS n FROM base_exercises b
              JOIN exercises e ON e.id = b.id AND e.gym_id IS NOT NULL`,
    },
  ];
  for (const { table, column } of EXERCISE_REFERENCE_TABLES) {
    const optional = table === 'exercises';
    checks.push(
      {
        key: `${table}_not_exactly_one`,
        description: optional
          ? `${table}: rows with both a gym-owned (${column}) and a Base (base_exercise_id) reference`
          : `${table}: rows referencing both a gym-owned and a Base exercise, or neither`,
        scoped: true,
        sql: optional
          ? `SELECT COUNT(*) AS n FROM ${table} t
              WHERE t.${column} IS NOT NULL AND t.base_exercise_id IS NOT NULL${gym('t')}`
          : `SELECT COUNT(*) AS n FROM ${table} t
              WHERE (t.${column} IS NULL) = (t.base_exercise_id IS NULL)${gym('t')}`,
      },
      {
        key: `${table}_exercise_unknown`,
        description: `${table}: rows whose exercise is in neither table`,
        scoped: true,
        sql: `SELECT COUNT(*) AS n FROM ${table} t
               WHERE COALESCE(t.base_exercise_id, t.${column}) IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM exercise_catalogue c
                                  WHERE c.id = COALESCE(t.base_exercise_id, t.${column}))${gym('t')}`,
      },
      {
        key: `${table}_references_legacy_system_exercise`,
        description: `${table}: rows still pointing at a legacy System exercise (exercises.gym_id IS NULL) — blocks deleting them (migration 343)`,
        scoped: true,
        sql: `SELECT COUNT(*) AS n FROM ${table} t
                JOIN exercises x ON x.id = t.${column} AND x.gym_id IS NULL
               WHERE 1 = 1${gym('t')}`,
      },
    );
  }
  checks.push(
    {
      key: 'legacy_system_exercise_missing_in_base',
      description: 'Legacy System exercises with no base_exercises row (would be lost by migration 343)',
      sql: `SELECT COUNT(*) AS n FROM exercises e
             WHERE e.gym_id IS NULL AND NOT EXISTS (SELECT 1 FROM base_exercises b WHERE b.id = e.id)`,
    },
    {
      key: 'legacy_system_rows_remaining',
      description: 'Legacy System rows still in exercises (0 once migration 343 has run)',
      sql: 'SELECT COUNT(*) AS n FROM exercises e WHERE e.gym_id IS NULL',
      informational: true,
    },
  );
  return { checks, params: checks.map((c) => (c.scoped && gymId ? [gymId] : [])) };
}
