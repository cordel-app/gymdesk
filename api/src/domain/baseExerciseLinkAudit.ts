/**
 * #1849 (Exercises) — the read-only checks on the five places that reference an exercise
 * by id (`npm run exercises:audit-base-links`, and the integration test). Every check
 * counts rows that would be a problem and must be 0, except the ones flagged
 * `informational`. Foods' `baseFoodLinkAudit.ts` one catalogue over.
 *
 * Stage E3 (migration 339) added `base_exercise_id` beside the old column, additive: a
 * row pointing at a System exercise carries the Base reference too (the ids are equal),
 * one pointing at a gym-owned exercise carries none. The exactly-one rule and the delete
 * of the legacy System rows are the later stages; until then the old column stays filled.
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
    checks.push(
      {
        key: `${table}_system_without_base_link`,
        description: `${table}: rows pointing at a System exercise with no base_exercise_id`,
        scoped: true,
        sql: `SELECT COUNT(*) AS n FROM ${table} t
                JOIN exercises x ON x.id = t.${column} AND x.gym_id IS NULL
               WHERE t.base_exercise_id IS NULL${gym('t')}`,
      },
      {
        key: `${table}_base_link_mismatch`,
        description: `${table}: base_exercise_id differing from ${column}, or set while ${column} names a gym-owned exercise`,
        scoped: true,
        sql: `SELECT COUNT(*) AS n FROM ${table} t
                LEFT JOIN exercises x ON x.id = t.${column}
               WHERE t.base_exercise_id IS NOT NULL
                 AND (t.${column} IS NULL OR t.base_exercise_id <> t.${column} OR x.gym_id IS NOT NULL)${gym('t')}`,
      },
      {
        key: `${table}_base_link_unknown`,
        description: `${table}: base_exercise_id naming no base_exercises row`,
        scoped: true,
        sql: `SELECT COUNT(*) AS n FROM ${table} t
               WHERE t.base_exercise_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM base_exercises b WHERE b.id = t.base_exercise_id)${gym('t')}`,
      },
    );
  }
  checks.push(
    {
      key: 'legacy_system_exercise_missing_in_base',
      description: 'Legacy System exercises with no base_exercises row',
      sql: `SELECT COUNT(*) AS n FROM exercises e
             WHERE e.gym_id IS NULL AND NOT EXISTS (SELECT 1 FROM base_exercises b WHERE b.id = e.id)`,
    },
    {
      key: 'legacy_system_rows_remaining',
      description: 'Legacy System rows still in exercises (0 once they are deleted, stage E6)',
      sql: 'SELECT COUNT(*) AS n FROM exercises e WHERE e.gym_id IS NULL',
      informational: true,
    },
  );
  return { checks, params: checks.map((c) => (c.scoped && gymId ? [gymId] : [])) };
}
