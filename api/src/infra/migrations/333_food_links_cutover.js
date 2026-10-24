/**
 * #1849 stage F5-1 (Foods) — a System Food is referenced through
 * `base_nutrition_library_item_id` alone. Personal Goals' migration 319 one catalogue over.
 *
 * Until now both columns were set for a System food (F3/F4): `nutrition_library_item_id`
 * pointed at the legacy System row and the Base column at its Base twin. This makes the
 * reference exclusive on the six tables that carry one (`nutrition_plan_template_restrictions` joined them in migration 332):
 *   - `nutrition_library_item_id` becomes NULLable where it was NOT NULL (the meal items
 *     and restrictions; its FK to `nutrition_library_items` stays, for gym-owned foods)
 *     and is cleared wherever the Base column is set;
 *   - CHECK: exactly one of the two on the three tables whose reference is mandatory
 *     (`member_nutrition_plan_meal_items`, `member_nutrition_plan_restrictions`,
 *     `nutrition_plan_template_meal_items`, `nutrition_plan_template_restrictions`). The two goal tables (optional illustration,
 *     SET NULL FKs) cannot carry a CHECK over those columns (MySQL error 3823); their
 *     "at most one" is the writers' and `npm run foods:audit-base-links`'.
 *
 * After it nothing references a legacy System food through an FK, so deleting those
 * rows (migration 334) can no longer hit a RESTRICT or null an illustration.
 *
 * Guards (the migration refuses, and changes nothing, if any fails): a row points at a
 * legacy System food with no Base reference, or the two columns disagree. After the
 * clear it verifies the row counts did not change.
 */
const MANDATORY = [
  ['member_nutrition_plan_meal_items', 'chk_mnpmi_one_food_ref'],
  ['member_nutrition_plan_restrictions', 'chk_mnpr_one_food_ref'],
  ['nutrition_plan_template_meal_items', 'chk_nptmi_one_food_ref'],
  ['nutrition_plan_template_restrictions', 'chk_nptr_one_food_ref'],
];
// The goal tables' illustration is optional and both columns are ON DELETE SET NULL, which
// MySQL refuses inside a CHECK (error 3823): "at most one" is kept by the writers and by
// `npm run foods:audit-base-links`, not by a constraint.
const OPTIONAL = ['member_nutrition_plan_goals', 'nutrition_plan_template_goals'];

async function count(knex, sql) {
  const [[row]] = await knex.raw(sql);
  return Number(row.n);
}

exports.up = async (knex) => {
  const tables = [...MANDATORY.map(([t]) => t), ...OPTIONAL];
  const before = {};
  for (const t of tables) {
    const unlinked = await count(knex, `
      SELECT COUNT(*) AS n FROM ${t} x JOIN nutrition_library_items i ON i.id = x.nutrition_library_item_id
       WHERE i.gym_id IS NULL AND x.base_nutrition_library_item_id IS NULL`);
    if (unlinked > 0) throw new Error(`#1849 F5: ${unlinked} row(s) of ${t} point at a legacy System food with no base_nutrition_library_item_id; run the 326/327 backfill`);
    const mismatch = await count(knex, `
      SELECT COUNT(*) AS n FROM ${t} WHERE base_nutrition_library_item_id IS NOT NULL
         AND nutrition_library_item_id IS NOT NULL AND base_nutrition_library_item_id <> nutrition_library_item_id`);
    if (mismatch > 0) throw new Error(`#1849 F5: ${mismatch} row(s) of ${t} have disagreeing food columns`);
    before[t] = await count(knex, `SELECT COUNT(*) AS n FROM ${t}`);
  }

  for (const [t] of MANDATORY) {
    await knex.raw(`ALTER TABLE ${t} MODIFY COLUMN nutrition_library_item_id INT UNSIGNED NULL`);
  }
  for (const t of tables) {
    await knex.raw(`UPDATE ${t} SET nutrition_library_item_id = NULL WHERE base_nutrition_library_item_id IS NOT NULL`);
  }
  for (const [t, name] of MANDATORY) {
    await knex.raw(`ALTER TABLE ${t} ADD CONSTRAINT ${name}
      CHECK ((nutrition_library_item_id IS NULL) <> (base_nutrition_library_item_id IS NULL))`);
  }

  for (const t of tables) {
    const after = await count(knex, `SELECT COUNT(*) AS n FROM ${t}`);
    if (after !== before[t]) throw new Error(`#1849 F5: ${t} row count changed (${before[t]} -> ${after})`);
  }
};

exports.down = async () => {};
