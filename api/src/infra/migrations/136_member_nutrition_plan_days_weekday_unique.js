/**
 * #441: Nutrition Plans — editing, duplicating, view details, completion actions
 *
 * `member_nutrition_plan_days` (added in #350's migration 105) was created without
 * the per-weekday uniqueness `nutrition_plan_template_days` already enforces
 * (`nptd_template_weekday_unique`, migration 071) — every day-adding path so far
 * only ever went through `nutrition-plan-templates.ts`'s `/:id/assign` transaction,
 * which copies a template's (already-unique) days 1:1, so the gap was never hit.
 * #441 adds a day-add endpoint directly on `member_nutrition_plans`, so this closes
 * the same gap before that endpoint can create duplicate weekday rows.
 *
 * Idempotent/retry-safe: guarded by an information_schema existence check so a
 * retry after a partial failure resumes rather than erroring on a duplicate index.
 *
 * Defensive dedupe before the ALTER: every write path that predates #441 (only
 * `nutrition-plan-templates.ts`'s `/:id/assign`, itself copying rows 1:1 from a
 * template already protected by `nptd_template_weekday_unique` since migration
 * 071) could not have produced a duplicate (plan, weekday) pair — but a stray
 * row from a manual fix or a since-removed code path would otherwise fail the
 * ALTER with a generic ER_DUP_ENTRY on deploy, blocking every later migration
 * until someone manually deduplicates the table. Keeping the lowest id per
 * pair is a cheap, safe no-op when (as expected) no duplicates exist.
 */

async function indexExists(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, name],
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (!await indexExists(knex, 'member_nutrition_plan_days', 'mnpd_plan_weekday_unique')) {
    await knex.raw(`
      DELETE d1 FROM member_nutrition_plan_days d1
      JOIN member_nutrition_plan_days d2
        ON d1.member_nutrition_plan_id = d2.member_nutrition_plan_id
       AND d1.weekday = d2.weekday
       AND d1.id > d2.id
    `);
    await knex.raw(
      'ALTER TABLE member_nutrition_plan_days ' +
      'ADD CONSTRAINT mnpd_plan_weekday_unique UNIQUE (member_nutrition_plan_id, weekday)',
    );
  }
};

exports.down = async (knex) => {
  if (await indexExists(knex, 'member_nutrition_plan_days', 'mnpd_plan_weekday_unique')) {
    await knex.raw('ALTER TABLE member_nutrition_plan_days DROP INDEX mnpd_plan_weekday_unique');
  }
};
