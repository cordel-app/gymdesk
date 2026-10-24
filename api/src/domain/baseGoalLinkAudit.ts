/**
 * #1849 stage 2d — the read-only checks that say whether the Personal Goals'
 * references are safe to move from the legacy System rows to `base_personal_goals`
 * (`npm run goals:audit-base-links`, and the integration test). Every check counts
 * rows that would be a problem; all must be 0 before stages 2e/2f.
 *
 * `gymId` narrows the two assignment-side checks to one gym (tests use it; the
 * script audits everything).
 */
export interface BaseGoalLinkCheck {
  key: string;
  description: string;
  sql: string;
}

export function baseGoalLinkChecks(gymId?: string): { checks: BaseGoalLinkCheck[]; params: unknown[][] } {
  const scoped = (alias: string) => (gymId ? ` AND ${alias}.gym_id = ?` : '');
  const gp = gymId ? [gymId] : [];
  const checks: BaseGoalLinkCheck[] = [
    {
      key: 'system_goal_missing_in_base',
      description: 'System goals in personal_goals with no base_personal_goals row',
      sql: `SELECT COUNT(*) AS n FROM personal_goals p
             WHERE p.gym_id IS NULL AND NOT EXISTS (SELECT 1 FROM base_personal_goals b WHERE b.id = p.id)`,
    },
    {
      key: 'base_goal_missing_in_legacy',
      description: 'Base goals with no legacy System row (the FKs still target the legacy table)',
      sql: `SELECT COUNT(*) AS n FROM base_personal_goals b
             WHERE NOT EXISTS (SELECT 1 FROM personal_goals p WHERE p.id = b.id AND p.gym_id IS NULL)`,
    },
    {
      key: 'id_collision',
      description: 'Ids used by a Base goal and by a gym-owned goal',
      sql: `SELECT COUNT(*) AS n FROM base_personal_goals b
              JOIN personal_goals p ON p.id = b.id AND p.gym_id IS NOT NULL`,
    },
    {
      key: 'assignment_goal_unknown',
      description: 'Assignments whose goal is in neither table',
      sql: `SELECT COUNT(*) AS n FROM member_personal_goals t
             WHERE NOT EXISTS (SELECT 1 FROM personal_goal_catalogue c WHERE c.id = t.personal_goal_id)${scoped('t')}`,
    },
    {
      key: 'assignment_system_unlinked',
      description: 'Assignments of a System goal with no base_personal_goal_id',
      sql: `SELECT COUNT(*) AS n FROM member_personal_goals t
              JOIN personal_goals p ON p.id = t.personal_goal_id AND p.gym_id IS NULL
             WHERE t.base_personal_goal_id IS NULL${scoped('t')}`,
    },
    {
      key: 'assignment_link_mismatch',
      description: 'Assignments whose base_personal_goal_id differs from personal_goal_id, or is set on a gym-owned goal',
      sql: `SELECT COUNT(*) AS n FROM member_personal_goals t
              JOIN personal_goals p ON p.id = t.personal_goal_id
             WHERE t.base_personal_goal_id IS NOT NULL
               AND (t.base_personal_goal_id <> t.personal_goal_id OR p.gym_id IS NOT NULL)${scoped('t')}`,
    },
    {
      key: 'activation_system_unlinked',
      description: 'Gym activation rows of a System goal with no base_personal_goal_id',
      sql: `SELECT COUNT(*) AS n FROM gym_personal_goals t
              JOIN personal_goals p ON p.id = t.personal_goal_id AND p.gym_id IS NULL
             WHERE t.base_personal_goal_id IS NULL${scoped('t')}`,
    },
    {
      key: 'activation_link_mismatch',
      description: 'Activation rows whose base_personal_goal_id differs from personal_goal_id, or is set on a gym-owned goal',
      sql: `SELECT COUNT(*) AS n FROM gym_personal_goals t
              JOIN personal_goals p ON p.id = t.personal_goal_id
             WHERE t.base_personal_goal_id IS NOT NULL
               AND (t.base_personal_goal_id <> t.personal_goal_id OR p.gym_id IS NOT NULL)${scoped('t')}`,
    },
  ];
  const scopedKeys = new Set(['assignment_goal_unknown', 'assignment_system_unlinked', 'assignment_link_mismatch', 'activation_system_unlinked', 'activation_link_mismatch']);
  return { checks, params: checks.map((c) => (scopedKeys.has(c.key) ? gp : [])) };
}
