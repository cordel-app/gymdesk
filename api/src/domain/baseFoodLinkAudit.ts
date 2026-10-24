/**
 * #1849 stage F3 (Foods) — the read-only checks that say whether the five tables that
 * reference a Food by id are safe to move from the legacy System rows to
 * `base_nutrition_library_items` (`npm run foods:audit-base-links`, and the integration
 * test). Every check counts rows that would be a problem and must be 0, except the
 * ones flagged `informational`. Personal Goals' `baseGoalLinkAudit.ts` one catalogue over.
 *
 * `gymId` narrows the five reference-table checks to one gym (the template tables carry
 * a `gym_id` too, NULL for a Base template); tests use it, the script audits everything.
 */
export interface BaseFoodLinkCheck {
  key: string;
  description: string;
  sql: string;
  informational?: boolean;
  scoped?: boolean;
}

export const FOOD_REFERENCE_TABLES = [
  'member_nutrition_plan_meal_items',
  'member_nutrition_plan_restrictions',
  'nutrition_plan_template_meal_items',
  'member_nutrition_plan_goals',
  'nutrition_plan_template_goals',
] as const;

export function baseFoodLinkChecks(gymId?: string): { checks: BaseFoodLinkCheck[]; params: unknown[][] } {
  const gym = (alias: string) => (gymId ? ` AND ${alias}.gym_id = ?` : '');
  const checks: BaseFoodLinkCheck[] = [
    {
      key: 'id_collision',
      description: 'Ids used by a Base food and by a gym-owned food',
      sql: `SELECT COUNT(*) AS n FROM base_nutrition_library_items b
              JOIN nutrition_library_items i ON i.id = b.id AND i.gym_id IS NOT NULL`,
    },
    {
      key: 'system_food_missing_in_base',
      description: 'System foods in nutrition_library_items with no base_nutrition_library_items row',
      sql: `SELECT COUNT(*) AS n FROM nutrition_library_items i
             WHERE i.gym_id IS NULL AND NOT EXISTS (SELECT 1 FROM base_nutrition_library_items b WHERE b.id = i.id)`,
    },
  ];
  for (const table of FOOD_REFERENCE_TABLES) {
    checks.push(
      {
        key: `${table}_system_unlinked`,
        description: `${table}: rows of a System food with no base_nutrition_library_item_id`,
        scoped: true,
        sql: `SELECT COUNT(*) AS n FROM ${table} t
                JOIN nutrition_library_items i ON i.id = t.nutrition_library_item_id AND i.gym_id IS NULL
               WHERE t.base_nutrition_library_item_id IS NULL${gym('t')}`,
      },
      {
        key: `${table}_link_mismatch`,
        description: `${table}: base_nutrition_library_item_id differing from nutrition_library_item_id, or set on a gym-owned food`,
        scoped: true,
        sql: `SELECT COUNT(*) AS n FROM ${table} t
                JOIN nutrition_library_items i ON i.id = t.nutrition_library_item_id
               WHERE t.base_nutrition_library_item_id IS NOT NULL
                 AND (t.base_nutrition_library_item_id <> t.nutrition_library_item_id OR i.gym_id IS NOT NULL)${gym('t')}`,
      },
    );
  }
  return { checks, params: checks.map((c) => (c.scoped && gymId ? [gymId] : [])) };
}
