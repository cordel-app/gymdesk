/**
 * #1849 (Foods) — the read-only checks on the six tables that reference a Food by id
 * (`npm run foods:audit-base-links`, and the integration test). Every check counts rows
 * that would be a problem and must be 0, except the ones flagged `informational`.
 * Personal Goals' `baseGoalLinkAudit.ts` one catalogue over.
 *
 * Since stage F5 (migration 332) a System food is referenced through
 * `base_nutrition_library_item_id` alone: exactly one reference on the four tables
 * where it is mandatory (meal items and restrictions), at most one on the two goal tables (the illustration is
 * optional). Migration 333 deletes the legacy System rows; nothing may reference one.
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
  'nutrition_plan_template_restrictions',
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
  ];
  for (const table of FOOD_REFERENCE_TABLES) {
    const optional = table.endsWith('_goals');
    checks.push(
      {
        key: `${table}_not_exactly_one`,
        description: optional
          ? `${table}: rows referencing both a gym-owned and a Base food`
          : `${table}: rows referencing both a gym-owned and a Base food, or neither`,
        scoped: true,
        sql: optional
          ? `SELECT COUNT(*) AS n FROM ${table} t
              WHERE t.nutrition_library_item_id IS NOT NULL AND t.base_nutrition_library_item_id IS NOT NULL${gym('t')}`
          : `SELECT COUNT(*) AS n FROM ${table} t
              WHERE (t.nutrition_library_item_id IS NULL) = (t.base_nutrition_library_item_id IS NULL)${gym('t')}`,
      },
      {
        key: `${table}_food_unknown`,
        description: `${table}: rows whose food is in neither table`,
        scoped: true,
        sql: `SELECT COUNT(*) AS n FROM ${table} t
               WHERE COALESCE(t.base_nutrition_library_item_id, t.nutrition_library_item_id) IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM nutrition_library_item_catalogue c
                                  WHERE c.id = COALESCE(t.base_nutrition_library_item_id, t.nutrition_library_item_id))${gym('t')}`,
      },
      {
        key: `${table}_references_legacy_system_food`,
        description: `${table}: rows still pointing at a legacy System food (nutrition_library_items.gym_id IS NULL) — blocks deleting them (migration 333)`,
        scoped: true,
        sql: `SELECT COUNT(*) AS n FROM ${table} t
                JOIN nutrition_library_items i ON i.id = t.nutrition_library_item_id AND i.gym_id IS NULL
               WHERE 1 = 1${gym('t')}`,
      },
    );
  }
  checks.push(
    {
      key: 'legacy_system_food_missing_in_base',
      description: 'Legacy System foods with no base_nutrition_library_items row (would be lost by migration 333)',
      sql: `SELECT COUNT(*) AS n FROM nutrition_library_items i
             WHERE i.gym_id IS NULL AND NOT EXISTS (SELECT 1 FROM base_nutrition_library_items b WHERE b.id = i.id)`,
    },
    {
      key: 'legacy_system_rows_remaining',
      description: 'Legacy System rows still in nutrition_library_items (0 once migration 333 has run)',
      sql: 'SELECT COUNT(*) AS n FROM nutrition_library_items i WHERE i.gym_id IS NULL',
      informational: true,
    },
  );
  return { checks, params: checks.map((c) => (c.scoped && gymId ? [gymId] : [])) };
}
