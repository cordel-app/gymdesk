/**
 * #163: Nutrition Library — replaces gym-scoped dishes/sides/sauces with a
 * global nutrition_library_items catalog. Adds restrictions + goals to templates.
 * Meals now carry direct library FK columns (main_dish_id, side_id, sauce_id, drink_id).
 * Days weekday CHECK extended to 0-7 (7 = All Days).
 */
exports.up = async (knex) => {
  // 1. Drop old meal_dishes table (FK-depends on meals, dishes, sides, sauces)
  await knex.schema.dropTableIfExists('nutrition_plan_template_meal_dishes');

  // 2. Drop old gym-scoped catalog tables (replaced by global nutrition_library_items)
  await knex.schema.dropTableIfExists('dishes');
  await knex.schema.dropTableIfExists('sides');
  await knex.schema.dropTableIfExists('sauces');

  // 3. Create global nutrition library (no gym_id — same pattern as benefit_types)
  if (!await knex.schema.hasTable('nutrition_library_items')) {
    await knex.schema.createTable('nutrition_library_items', (t) => {
      t.increments('id').primary();
      t.string('name', 255).notNullable();
      t.string('category', 30).notNullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.unique(['name', 'category'], 'nli_name_category_unique');
      t.index(['category'], 'nli_category_index');
    });
    await knex.raw(
      "ALTER TABLE nutrition_library_items ADD CONSTRAINT nli_category_check " +
      "CHECK (category IN ('main_dish','side','sauce','drink','dessert','other'))",
    );

    const seed = [
      // Main dishes
      { name: 'Chicken', category: 'main_dish' },
      { name: 'Beef', category: 'main_dish' },
      { name: 'Turkey', category: 'main_dish' },
      { name: 'Salmon', category: 'main_dish' },
      { name: 'Tuna', category: 'main_dish' },
      { name: 'Eggs', category: 'main_dish' },
      { name: 'Tofu', category: 'main_dish' },
      // Sides
      { name: 'Rice', category: 'side' },
      { name: 'Brown Rice', category: 'side' },
      { name: 'Vegetables', category: 'side' },
      { name: 'Salad', category: 'side' },
      { name: 'Potatoes', category: 'side' },
      { name: 'Sweet Potatoes', category: 'side' },
      { name: 'Pasta', category: 'side' },
      { name: 'Quinoa', category: 'side' },
      // Sauces
      { name: 'Tomato Sauce', category: 'sauce' },
      { name: 'Yogurt Sauce', category: 'sauce' },
      { name: 'Olive Oil', category: 'sauce' },
      { name: 'Mustard', category: 'sauce' },
      { name: 'Hot Sauce', category: 'sauce' },
      // Drinks
      { name: 'Water', category: 'drink' },
      { name: 'Coffee', category: 'drink' },
      { name: 'Tea', category: 'drink' },
      { name: 'Juice', category: 'drink' },
      // Desserts
      { name: 'Fruit', category: 'dessert' },
      { name: 'Yogurt', category: 'dessert' },
      { name: 'Oats', category: 'dessert' },
      { name: 'Honey', category: 'dessert' },
      // Other
      { name: 'Bread', category: 'other' },
      { name: 'Nuts', category: 'other' },
      { name: 'Dairy', category: 'other' },
      { name: 'Sugar', category: 'other' },
    ];
    await knex('nutrition_library_items').insert(seed);
  }

  // 4. Add library FK columns to nutrition_plan_template_meals
  if (!await knex.schema.hasColumn('nutrition_plan_template_meals', 'main_dish_id')) {
    await knex.raw(
      'ALTER TABLE nutrition_plan_template_meals ' +
      'ADD COLUMN main_dish_id INT UNSIGNED NULL, ' +
      'ADD COLUMN side_id INT UNSIGNED NULL, ' +
      'ADD COLUMN sauce_id INT UNSIGNED NULL, ' +
      'ADD COLUMN drink_id INT UNSIGNED NULL, ' +
      'ADD CONSTRAINT nptm_main_dish_fk FOREIGN KEY (main_dish_id) REFERENCES nutrition_library_items(id) ON DELETE SET NULL, ' +
      'ADD CONSTRAINT nptm_side_fk FOREIGN KEY (side_id) REFERENCES nutrition_library_items(id) ON DELETE SET NULL, ' +
      'ADD CONSTRAINT nptm_sauce_fk FOREIGN KEY (sauce_id) REFERENCES nutrition_library_items(id) ON DELETE SET NULL, ' +
      'ADD CONSTRAINT nptm_drink_fk FOREIGN KEY (drink_id) REFERENCES nutrition_library_items(id) ON DELETE SET NULL',
    );
  }

  // 5. Extend weekday CHECK to allow 0-7 (7 = All Days)
  await knex.raw('ALTER TABLE nutrition_plan_template_days DROP CHECK nptd_weekday_check').catch(() => {});
  await knex.raw(
    'ALTER TABLE nutrition_plan_template_days ADD CONSTRAINT nptd_weekday_check CHECK (weekday BETWEEN 0 AND 7)',
  );

  // 6. Create restrictions table (template-level, applies to all days)
  // FK names kept short (MySQL identifier max = 64 chars)
  if (!await knex.schema.hasTable('nutrition_plan_template_restrictions')) {
    await knex.raw(`
      CREATE TABLE nutrition_plan_template_restrictions (
        id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id        CHAR(36) NOT NULL,
        nutrition_plan_template_id INT UNSIGNED NOT NULL,
        nutrition_library_item_id  INT UNSIGNED NOT NULL,
        applies_all_days TINYINT NOT NULL DEFAULT 1,
        position      INT UNSIGNED NOT NULL DEFAULT 1,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX nptr_gym_index (gym_id),
        INDEX nptr_template_index (nutrition_plan_template_id),
        CONSTRAINT nptr_gym_fk FOREIGN KEY (gym_id)
          REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT nptr_template_fk FOREIGN KEY (nutrition_plan_template_id)
          REFERENCES nutrition_plan_templates(id) ON DELETE CASCADE,
        CONSTRAINT nptr_library_item_fk FOREIGN KEY (nutrition_library_item_id)
          REFERENCES nutrition_library_items(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  // 7. Create goals table (template-level, free-text item name + quantity/unit/frequency)
  if (!await knex.schema.hasTable('nutrition_plan_template_goals')) {
    await knex.raw(`
      CREATE TABLE nutrition_plan_template_goals (
        id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id        CHAR(36) NOT NULL,
        nutrition_plan_template_id INT UNSIGNED NOT NULL,
        item_name     VARCHAR(255) NOT NULL,
        quantity      DECIMAL(8,2) NOT NULL,
        unit          VARCHAR(50) NOT NULL,
        frequency     VARCHAR(50) NOT NULL DEFAULT 'daily',
        applies_all_days TINYINT NOT NULL DEFAULT 1,
        position      INT UNSIGNED NOT NULL DEFAULT 1,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX nptg_gym_index (gym_id),
        INDEX nptg_template_index (nutrition_plan_template_id),
        CONSTRAINT nptg_gym_fk FOREIGN KEY (gym_id)
          REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT nptg_template_fk FOREIGN KEY (nutrition_plan_template_id)
          REFERENCES nutrition_plan_templates(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('nutrition_plan_template_goals');
  await knex.schema.dropTableIfExists('nutrition_plan_template_restrictions');

  // Revert weekday check
  await knex.raw('ALTER TABLE nutrition_plan_template_days DROP CHECK nptd_weekday_check').catch(() => {});
  await knex.raw(
    'ALTER TABLE nutrition_plan_template_days ADD CONSTRAINT nptd_weekday_check CHECK (weekday BETWEEN 0 AND 6)',
  ).catch(() => {});

  // Remove library FK columns from meals
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
  ).catch(() => {});

  await knex.schema.dropTableIfExists('nutrition_library_items');

  // Recreate gym-scoped catalog tables (empty — no data restoration)
  if (!await knex.schema.hasTable('dishes')) {
    await knex.schema.createTable('dishes', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 255).notNullable();
      t.string('description', 1000).nullable();
      t.decimal('calories', 8, 2).nullable();
      t.decimal('protein', 8, 2).nullable();
      t.decimal('carbohydrates', 8, 2).nullable();
      t.decimal('fat', 8, 2).nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('modified_at').nullable();
      t.index(['gym_id'], 'dishes_gym_index');
      t.unique(['gym_id', 'name'], 'dishes_gym_name_unique');
    });
  }
  if (!await knex.schema.hasTable('sides')) {
    await knex.schema.createTable('sides', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 255).notNullable();
      t.string('description', 1000).nullable();
      t.decimal('calories', 8, 2).nullable();
      t.decimal('protein', 8, 2).nullable();
      t.decimal('carbohydrates', 8, 2).nullable();
      t.decimal('fat', 8, 2).nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('modified_at').nullable();
      t.index(['gym_id'], 'sides_gym_index');
      t.unique(['gym_id', 'name'], 'sides_gym_name_unique');
    });
  }
  if (!await knex.schema.hasTable('sauces')) {
    await knex.schema.createTable('sauces', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 255).notNullable();
      t.string('description', 1000).nullable();
      t.decimal('calories', 8, 2).nullable();
      t.decimal('protein', 8, 2).nullable();
      t.decimal('carbohydrates', 8, 2).nullable();
      t.decimal('fat', 8, 2).nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('modified_at').nullable();
      t.index(['gym_id'], 'sauces_gym_index');
      t.unique(['gym_id', 'name'], 'sauces_gym_name_unique');
    });
  }
};
