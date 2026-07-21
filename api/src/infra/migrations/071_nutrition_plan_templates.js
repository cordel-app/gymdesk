/**
 * #132: Nutrition Plan Templates — template → days (weekday) → meals → meal_dishes
 * Plus gym-scoped catalogs: dishes, sides, sauces.
 */
exports.up = async (knex) => {
  // Shared catalogs
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

  // Templates
  if (!await knex.schema.hasTable('nutrition_plan_templates')) {
    await knex.schema.createTable('nutrition_plan_templates', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 255).notNullable();
      t.string('description', 1000).nullable();
      t.string('status', 20).notNullable().defaultTo('active');
      t.integer('created_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.integer('modified_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.integer('deleted_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('modified_at').nullable();
      t.datetime('deleted_at').nullable();
      t.index(['gym_id'], 'npt_gym_index');
      t.unique(['gym_id', 'name'], 'npt_gym_name_unique');
    });
    await knex.raw(
      "ALTER TABLE nutrition_plan_templates ADD CONSTRAINT npt_status_check " +
      "CHECK (status IN ('active','inactive','draft','deleted'))",
    );
  }

  // Days — constrained to weekdays 0–6 (0=Mon … 6=Sun)
  if (!await knex.schema.hasTable('nutrition_plan_template_days')) {
    await knex.schema.createTable('nutrition_plan_template_days', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('nutrition_plan_template_id').unsigned().notNullable()
        .references('id').inTable('nutrition_plan_templates').onDelete('CASCADE');
      t.integer('weekday').unsigned().notNullable();
      t.integer('position').unsigned().notNullable().defaultTo(1);
      t.index(['gym_id'], 'nptd_gym_index');
      t.index(['nutrition_plan_template_id'], 'nptd_template_index');
      t.unique(['nutrition_plan_template_id', 'weekday'], 'nptd_template_weekday_unique');
    });
    await knex.raw(
      "ALTER TABLE nutrition_plan_template_days ADD CONSTRAINT nptd_weekday_check " +
      "CHECK (weekday BETWEEN 0 AND 6)",
    );
  }

  // Meals — eating moments within a day
  // FK to nutrition_plan_template_days added via raw to avoid MySQL 64-char identifier limit.
  if (!await knex.schema.hasTable('nutrition_plan_template_meals')) {
    await knex.schema.createTable('nutrition_plan_template_meals', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('nutrition_plan_template_day_id').unsigned().notNullable();
      t.string('name', 255).notNullable();
      t.integer('position').unsigned().notNullable().defaultTo(1);
      t.index(['gym_id'], 'nptm_gym_index');
      t.index(['nutrition_plan_template_day_id'], 'nptm_day_index');
    });
    await knex.raw(
      'ALTER TABLE nutrition_plan_template_meals ' +
      'ADD CONSTRAINT nptm_day_fk FOREIGN KEY (nutrition_plan_template_day_id) ' +
      'REFERENCES nutrition_plan_template_days(id) ON DELETE CASCADE',
    );
  }

  // Dish items within a meal — N per meal, each with optional side + sauce (shared catalog refs)
  // FK to nutrition_plan_template_meals added via raw to avoid MySQL 64-char identifier limit.
  if (!await knex.schema.hasTable('nutrition_plan_template_meal_dishes')) {
    await knex.schema.createTable('nutrition_plan_template_meal_dishes', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('nutrition_plan_template_meal_id').unsigned().notNullable();
      t.integer('dish_id').unsigned().notNullable()
        .references('id').inTable('dishes').onDelete('RESTRICT');
      t.integer('side_id').unsigned().nullable()
        .references('id').inTable('sides').onDelete('SET NULL');
      t.integer('sauce_id').unsigned().nullable()
        .references('id').inTable('sauces').onDelete('SET NULL');
      t.integer('position').unsigned().notNullable().defaultTo(1);
      t.index(['gym_id'], 'nptmd_gym_index');
      t.index(['nutrition_plan_template_meal_id'], 'nptmd_meal_index');
    });
    await knex.raw(
      'ALTER TABLE nutrition_plan_template_meal_dishes ' +
      'ADD CONSTRAINT nptmd_meal_fk FOREIGN KEY (nutrition_plan_template_meal_id) ' +
      'REFERENCES nutrition_plan_template_meals(id) ON DELETE CASCADE',
    );
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('nutrition_plan_template_meal_dishes');
  await knex.schema.dropTableIfExists('nutrition_plan_template_meals');
  await knex.raw('ALTER TABLE nutrition_plan_template_days DROP CHECK nptd_weekday_check').catch(() => {});
  await knex.schema.dropTableIfExists('nutrition_plan_template_days');
  await knex.raw('ALTER TABLE nutrition_plan_templates DROP CHECK npt_status_check').catch(() => {});
  await knex.schema.dropTableIfExists('nutrition_plan_templates');
  await knex.schema.dropTableIfExists('dishes');
  await knex.schema.dropTableIfExists('sides');
  await knex.schema.dropTableIfExists('sauces');
};
