/**
 * #226: Nutrition Plan Templates — Meal Configuration UX Redesign
 *
 * 1. Create nutrition_plan_template_meal_items (replaces 4 FK columns on meals).
 * 2. Migrate existing main_dish_id / side_id / sauce_id data into meal_items.
 *    drink_id is dropped without migration (product decision).
 * 3. Rename nutrition_plan_template_meals.name → display_name.
 * 4. Add meal_type VARCHAR(50) NULL (predefined 7 values).
 * 5. Add notes TEXT NULL.
 * 6. Best-effort infer meal_type from existing display_name values.
 * 7. Drop FK constraints + 4 old columns (main_dish_id, side_id, sauce_id, drink_id).
 */
exports.up = async (knex) => {
  // --- Step 1: create meal_items table ---
  if (!await knex.schema.hasTable('nutrition_plan_template_meal_items')) {
    await knex.raw(`
      CREATE TABLE nutrition_plan_template_meal_items (
        id                        INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id                    CHAR(36) NOT NULL,
        meal_id                   INT UNSIGNED NOT NULL,
        nutrition_library_item_id INT UNSIGNED NOT NULL,
        component_type            VARCHAR(30) NOT NULL,
        quantity                  DECIMAL(8,2) NULL,
        unit                      VARCHAR(20) NULL DEFAULT 'g',
        position                  INT UNSIGNED NOT NULL DEFAULT 1,
        PRIMARY KEY (id),
        INDEX nptmi_gym_idx (gym_id),
        INDEX nptmi_meal_idx (meal_id),
        CONSTRAINT nptmi_gym_fk FOREIGN KEY (gym_id)
          REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT nptmi_meal_fk FOREIGN KEY (meal_id)
          REFERENCES nutrition_plan_template_meals(id) ON DELETE CASCADE,
        CONSTRAINT nptmi_lib_fk FOREIGN KEY (nutrition_library_item_id)
          REFERENCES nutrition_library_items(id) ON DELETE RESTRICT,
        CONSTRAINT chk_nptmi_component_type
          CHECK (component_type IN ('main_dish','side','sauce','additional'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  // --- Step 2: migrate existing FK column data into meal_items ---
  // Guard on old column still existing. Idempotent: clear any rows from a
  // previous partial run before inserting.
  const hasMainDish = await knex.schema.hasColumn('nutrition_plan_template_meals', 'main_dish_id');
  if (hasMainDish) {
    await knex.raw('DELETE FROM nutrition_plan_template_meal_items');
    await knex.raw(`
      INSERT INTO nutrition_plan_template_meal_items
        (gym_id, meal_id, nutrition_library_item_id, component_type, position)
      SELECT gym_id, id, main_dish_id, 'main_dish', 1
      FROM nutrition_plan_template_meals
      WHERE main_dish_id IS NOT NULL
    `);
    await knex.raw(`
      INSERT INTO nutrition_plan_template_meal_items
        (gym_id, meal_id, nutrition_library_item_id, component_type, position)
      SELECT gym_id, id, side_id, 'side', 2
      FROM nutrition_plan_template_meals
      WHERE side_id IS NOT NULL
    `);
    await knex.raw(`
      INSERT INTO nutrition_plan_template_meal_items
        (gym_id, meal_id, nutrition_library_item_id, component_type, position)
      SELECT gym_id, id, sauce_id, 'sauce', 3
      FROM nutrition_plan_template_meals
      WHERE sauce_id IS NOT NULL
    `);
    // drink_id is dropped without migration per product decision.
  }

  // --- Step 3: rename name → display_name (MySQL 8 RENAME COLUMN) ---
  const hasName = await knex.schema.hasColumn('nutrition_plan_template_meals', 'name');
  if (hasName) {
    await knex.raw(
      'ALTER TABLE nutrition_plan_template_meals RENAME COLUMN `name` TO display_name',
    );
  }

  // --- Step 4: add meal_type + notes ---
  const hasMealType = await knex.schema.hasColumn('nutrition_plan_template_meals', 'meal_type');
  if (!hasMealType) {
    await knex.raw(
      'ALTER TABLE nutrition_plan_template_meals ' +
      'ADD COLUMN meal_type VARCHAR(50) NULL AFTER display_name, ' +
      'ADD COLUMN notes TEXT NULL AFTER meal_type',
    );
    await knex.raw(
      'ALTER TABLE nutrition_plan_template_meals ' +
      'ADD CONSTRAINT chk_nptm_meal_type ' +
      "CHECK (meal_type IS NULL OR meal_type IN (" +
      "'recien_levantado','breakfast','media_manana','lunch','snack','dinner','antes_de_dormir'" +
      "))",
    );
  }

  // --- Step 5: best-effort infer meal_type from display_name ---
  await knex.raw(`
    UPDATE nutrition_plan_template_meals
    SET meal_type = CASE
      WHEN LOWER(display_name) LIKE '%levantado%' OR LOWER(display_name) LIKE '%wake%'
        THEN 'recien_levantado'
      WHEN LOWER(display_name) LIKE '%breakfast%' OR LOWER(display_name) LIKE '%desayuno%'
        THEN 'breakfast'
      WHEN LOWER(display_name) LIKE '%media%' OR LOWER(display_name) LIKE '%morning snack%'
        THEN 'media_manana'
      WHEN LOWER(display_name) LIKE '%lunch%' OR LOWER(display_name) LIKE '%almuerzo%' OR LOWER(display_name) LIKE '%comida%'
        THEN 'lunch'
      WHEN LOWER(display_name) LIKE '%snack%' OR LOWER(display_name) LIKE '%merienda%'
        THEN 'snack'
      WHEN LOWER(display_name) LIKE '%dinner%' OR LOWER(display_name) LIKE '%cena%'
        THEN 'dinner'
      WHEN LOWER(display_name) LIKE '%dormir%' OR LOWER(display_name) LIKE '%noche%' OR LOWER(display_name) LIKE '%bedtime%'
        THEN 'antes_de_dormir'
      ELSE NULL
    END
    WHERE meal_type IS NULL
  `);

  // --- Step 6: drop old FK constraints + columns ---
  if (hasMainDish) {
    await knex.raw(
      'ALTER TABLE nutrition_plan_template_meals ' +
      'DROP FOREIGN KEY nptm_main_dish_fk, ' +
      'DROP FOREIGN KEY nptm_side_fk, ' +
      'DROP FOREIGN KEY nptm_sauce_fk, ' +
      'DROP FOREIGN KEY nptm_drink_fk, ' +
      'DROP COLUMN main_dish_id, ' +
      'DROP COLUMN side_id, ' +
      'DROP COLUMN sauce_id, ' +
      'DROP COLUMN drink_id',
    );
  }
};

exports.down = async (knex) => {
  // Re-add the 4 FK columns (data not restored — down is structural only)
  const hasMainDish = await knex.schema.hasColumn('nutrition_plan_template_meals', 'main_dish_id');
  if (!hasMainDish) {
    await knex.raw(
      'ALTER TABLE nutrition_plan_template_meals ' +
      'ADD COLUMN main_dish_id INT UNSIGNED NULL, ' +
      'ADD COLUMN side_id     INT UNSIGNED NULL, ' +
      'ADD COLUMN sauce_id    INT UNSIGNED NULL, ' +
      'ADD COLUMN drink_id    INT UNSIGNED NULL, ' +
      'ADD CONSTRAINT nptm_main_dish_fk FOREIGN KEY (main_dish_id) REFERENCES nutrition_library_items(id) ON DELETE SET NULL, ' +
      'ADD CONSTRAINT nptm_side_fk      FOREIGN KEY (side_id)      REFERENCES nutrition_library_items(id) ON DELETE SET NULL, ' +
      'ADD CONSTRAINT nptm_sauce_fk     FOREIGN KEY (sauce_id)     REFERENCES nutrition_library_items(id) ON DELETE SET NULL, ' +
      'ADD CONSTRAINT nptm_drink_fk     FOREIGN KEY (drink_id)     REFERENCES nutrition_library_items(id) ON DELETE SET NULL',
    );
  }

  // Drop new columns — split statements so a missing constraint doesn't block the column drops
  const hasMealType = await knex.schema.hasColumn('nutrition_plan_template_meals', 'meal_type');
  if (hasMealType) {
    await knex.raw(
      'ALTER TABLE nutrition_plan_template_meals DROP CHECK chk_nptm_meal_type',
    ).catch(() => {});
    await knex.raw(
      'ALTER TABLE nutrition_plan_template_meals DROP COLUMN meal_type, DROP COLUMN notes',
    );
  }

  // Rename display_name back to name
  const hasDisplayName = await knex.schema.hasColumn('nutrition_plan_template_meals', 'display_name');
  if (hasDisplayName) {
    await knex.raw(
      'ALTER TABLE nutrition_plan_template_meals RENAME COLUMN display_name TO `name`',
    );
  }

  await knex.schema.dropTableIfExists('nutrition_plan_template_meal_items');
};
