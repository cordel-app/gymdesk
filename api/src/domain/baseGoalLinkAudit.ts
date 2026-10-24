/**
 * #1849 — the read-only checks that say whether the Personal Goals' references are
 * safe (`npm run goals:audit-base-links`, and the integration test). Every check
 * counts rows that would be a problem and must be 0, except the ones flagged
 * `informational`, which are reported but never fail.
 *
 * Since stage 2f-1 (migration 319) a System goal is referenced through
 * `base_personal_goal_id` alone, so the checks are about that shape and about the
 * precondition of deleting the legacy System rows (2f-2, migration 320): nothing
 * may reference one.
 *
 * `gymId` narrows the assignment-side checks to one gym (tests use it; the
 * script audits everything).
 */
export interface BaseGoalLinkCheck {
  key: string;
  description: string;
  sql: string;
  /** Reported, never a failure. */
  informational?: boolean;
  /** Whether the statement binds the gym id. */
  scoped?: boolean;
}

export function baseGoalLinkChecks(gymId?: string): { checks: BaseGoalLinkCheck[]; params: unknown[][] } {
  const gym = (alias: string) => (gymId ? ` AND ${alias}.gym_id = ?` : '');
  const sides = [
    { key: 'assignment', table: 'member_personal_goals', noun: 'Assignments' },
    { key: 'activation', table: 'gym_personal_goals', noun: 'Gym activation rows' },
  ];
  const checks: BaseGoalLinkCheck[] = [
    {
      key: 'id_collision',
      description: 'Ids used by a Base goal and by a gym-owned goal',
      sql: `SELECT COUNT(*) AS n FROM base_personal_goals b
              JOIN personal_goals p ON p.id = b.id AND p.gym_id IS NOT NULL`,
    },
  ];
  for (const { key, table, noun } of sides) {
    checks.push(
      {
        key: `${key}_not_exactly_one`,
        description: `${noun} that reference both a gym-owned and a Base goal, or neither`,
        scoped: true,
        sql: `SELECT COUNT(*) AS n FROM ${table} t
               WHERE (t.personal_goal_id IS NULL) = (t.base_personal_goal_id IS NULL)${gym('t')}`,
      },
      {
        key: `${key}_goal_unknown`,
        description: `${noun} whose goal is in neither table`,
        scoped: true,
        sql: `SELECT COUNT(*) AS n FROM ${table} t
               WHERE NOT EXISTS (SELECT 1 FROM personal_goal_catalogue c
                                  WHERE c.id = COALESCE(t.base_personal_goal_id, t.personal_goal_id))${gym('t')}`,
      },
      {
        key: `${key}_references_legacy_system_goal`,
        description: `${noun} still pointing at a legacy System goal (personal_goals.gym_id IS NULL) — blocks deleting them (2f-2)`,
        scoped: true,
        sql: `SELECT COUNT(*) AS n FROM ${table} t
                JOIN personal_goals p ON p.id = t.personal_goal_id AND p.gym_id IS NULL
               WHERE 1 = 1${gym('t')}`,
      },
    );
  }
  checks.push(
    {
      key: 'legacy_system_goal_missing_in_base',
      description: 'Legacy System goals with no base_personal_goals row (would be lost by 2f-2)',
      sql: `SELECT COUNT(*) AS n FROM personal_goals p
             WHERE p.gym_id IS NULL AND NOT EXISTS (SELECT 1 FROM base_personal_goals b WHERE b.id = p.id)`,
    },
    {
      key: 'legacy_system_rows_remaining',
      description: 'Legacy System rows still in personal_goals (0 once migration 320 has run)',
      sql: 'SELECT COUNT(*) AS n FROM personal_goals p WHERE p.gym_id IS NULL',
      informational: true,
    },
  );
  return { checks, params: checks.map((c) => (c.scoped && gymId ? [gymId] : [])) };
}
