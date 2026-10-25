/**
 * #1849 stage F5-0 (Foods) — `nutrition_plan_template_restrictions` is the sixth table that
 * references a Food by id (FK `nptr_library_item_fk`, NOT NULL, ON DELETE RESTRICT); stage F3
 * (migration 326) added the Base column to five tables and missed this one. Same shape as 326:
 * a nullable `base_nutrition_library_item_id` (FK to `base_nutrition_library_items`, RESTRICT,
 * matching the old FK) backfilled for the rows that point at a System food. The cut-over
 * (migration 333) then makes the reference exclusive here too.
 *
 * Idempotent; refuses if a System food has no Base twin.
 */
exports.up = async (knex) => {
  const [[missing]] = await knex.raw(`
    SELECT COUNT(*) AS n FROM nutrition_library_items i
     WHERE i.gym_id IS NULL AND NOT EXISTS (SELECT 1 FROM base_nutrition_library_items b WHERE b.id = i.id)
  `);
  if (Number(missing.n) > 0) {
    throw new Error(`#1849 F5-0: ${missing.n} System food(s) in nutrition_library_items have no base_nutrition_library_items row`);
  }
  if (!(await knex.schema.hasColumn('nutrition_plan_template_restrictions', 'base_nutrition_library_item_id'))) {
    await knex.raw(`
      ALTER TABLE nutrition_plan_template_restrictions
        ADD COLUMN base_nutrition_library_item_id INT UNSIGNED NULL,
        ADD KEY nptr_base_lib_idx (base_nutrition_library_item_id),
        ADD CONSTRAINT nptr_base_lib_fk FOREIGN KEY (base_nutrition_library_item_id)
          REFERENCES base_nutrition_library_items(id) ON DELETE RESTRICT
    `);
  }
  await knex.raw(`
    UPDATE nutrition_plan_template_restrictions t
      JOIN nutrition_library_items i ON i.id = t.nutrition_library_item_id AND i.gym_id IS NULL
       SET t.base_nutrition_library_item_id = i.id
     WHERE t.base_nutrition_library_item_id IS NULL
  `);
};

exports.down = async () => {};
