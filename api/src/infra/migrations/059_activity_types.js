/**
 * #70: Rename class_types → activity_types, migrating all FK references.
 */
exports.up = async (knex) => {
  // 1. Create activity_types mirroring class_types schema
  if (!(await knex.schema.hasTable('activity_types'))) {
    await knex.schema.createTable('activity_types', (t) => {
      t.increments('id').unsigned().primary();
      t.string('gym_id', 36).notNullable().references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 255).notNullable();
      t.text('description').nullable();
      t.integer('duration_minutes').unsigned().nullable();
      t.integer('intensity_level').unsigned().nullable();
      t.integer('max_capacity').unsigned().nullable();
      t.integer('speciality_id').unsigned().nullable().references('id').inTable('specialities').onDelete('SET NULL');
      t.string('status', 20).notNullable().defaultTo('active');
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['gym_id', 'name']);
    });

    // 2. Copy all rows from class_types preserving IDs
    await knex.raw(`
      INSERT INTO activity_types (id, gym_id, name, description, duration_minutes, intensity_level, max_capacity, speciality_id, status, created_at)
      SELECT id, gym_id, name, description, duration_minutes, intensity_level, max_capacity, speciality_id, status, created_at
      FROM class_types
    `);

    // Advance auto_increment past copied rows
    await knex.raw(`
      SET @max_id = (SELECT COALESCE(MAX(id), 0) FROM activity_types);
      SET @sql = CONCAT('ALTER TABLE activity_types AUTO_INCREMENT = ', @max_id + 1);
      PREPARE stmt FROM @sql;
      EXECUTE stmt;
      DEALLOCATE PREPARE stmt;
    `).catch(() => {});
  }

  // 3. Migrate class_sessions: add activity_type_id, backfill, drop old FK
  if (!(await knex.schema.hasColumn('class_sessions', 'activity_type_id'))) {
    await knex.schema.alterTable('class_sessions', (t) => {
      t.integer('activity_type_id').unsigned().nullable().after('class_type_id');
    });
    await knex.raw(`UPDATE class_sessions SET activity_type_id = class_type_id WHERE class_type_id IS NOT NULL`);
    await knex.raw(`ALTER TABLE class_sessions ADD CONSTRAINT cs_activity_type_fk FOREIGN KEY (activity_type_id) REFERENCES activity_types(id) ON DELETE SET NULL`).catch(() => {});
  }

  // 4. Migrate class_type_user_memberships: add activity_type_id, backfill
  if (!(await knex.schema.hasColumn('class_type_user_memberships', 'activity_type_id'))) {
    await knex.schema.alterTable('class_type_user_memberships', (t) => {
      t.integer('activity_type_id').unsigned().nullable().after('class_type_id');
    });
    await knex.raw(`UPDATE class_type_user_memberships SET activity_type_id = class_type_id`);
    await knex.raw(`ALTER TABLE class_type_user_memberships ADD CONSTRAINT ctum_activity_type_fk FOREIGN KEY (activity_type_id) REFERENCES activity_types(id) ON DELETE CASCADE`).catch(() => {});
  }
};

exports.down = async (knex) => {
  // Remove added columns
  if (await knex.schema.hasColumn('class_sessions', 'activity_type_id')) {
    await knex.raw('ALTER TABLE class_sessions DROP FOREIGN KEY cs_activity_type_fk').catch(() => {});
    await knex.schema.alterTable('class_sessions', (t) => t.dropColumn('activity_type_id'));
  }
  if (await knex.schema.hasColumn('class_type_user_memberships', 'activity_type_id')) {
    await knex.raw('ALTER TABLE class_type_user_memberships DROP FOREIGN KEY ctum_activity_type_fk').catch(() => {});
    await knex.schema.alterTable('class_type_user_memberships', (t) => t.dropColumn('activity_type_id'));
  }
  await knex.schema.dropTableIfExists('activity_types');
};
