/**
 * #124: Rename rooms → spaces, add new columns/statuses, create
 * space_activity_types join table, and rename class_sessions.room_id → space_id.
 */
exports.up = async (knex) => {
  // 1. Rename table
  if (!(await knex.schema.hasTable('spaces'))) {
    await knex.schema.renameTable('rooms', 'spaces');
  }

  // 2. Drop old status check and add new one with under_maintenance + deleted
  await knex.raw('ALTER TABLE spaces DROP CHECK rooms_status_check').catch(() => {});
  await knex.raw(
    "ALTER TABLE spaces ADD CONSTRAINT spaces_status_check " +
    "CHECK (status IN ('active','inactive','under_maintenance','deleted'))",
  );

  // 3. Add unique constraint on new table name
  await knex.raw('ALTER TABLE spaces DROP INDEX rooms_gym_name_unique').catch(() => {});
  await knex.raw('ALTER TABLE spaces ADD UNIQUE spaces_gym_name_unique (gym_id, name)').catch(() => {});

  // 4. Add audit columns (created_by, deleted_at, deleted_by already partially present via soft-delete pattern)
  if (!(await knex.schema.hasColumn('spaces', 'center_id'))) {
    await knex.schema.alterTable('spaces', (t) => {
      t.integer('center_id').unsigned().nullable()
        .references('id').inTable('centers').onDelete('SET NULL');
    });
  }
  // Ensure center_id is nullable (early runs may have created it NOT NULL).
  await knex.raw('ALTER TABLE spaces MODIFY center_id INT UNSIGNED NULL').catch(() => {});
  if (!(await knex.schema.hasColumn('spaces', 'notes'))) {
    await knex.schema.alterTable('spaces', (t) => {
      t.text('notes');
    });
  }
  if (!(await knex.schema.hasColumn('spaces', 'opening_time'))) {
    await knex.schema.alterTable('spaces', (t) => {
      t.time('opening_time').nullable();
      t.time('closing_time').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('spaces', 'modified_at'))) {
    await knex.schema.alterTable('spaces', (t) => {
      t.datetime('modified_at').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('spaces', 'modified_by_membership_id'))) {
    await knex.schema.alterTable('spaces', (t) => {
      t.integer('modified_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasColumn('spaces', 'created_by_membership_id'))) {
    await knex.schema.alterTable('spaces', (t) => {
      t.integer('created_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasColumn('spaces', 'deleted_at'))) {
    await knex.schema.alterTable('spaces', (t) => {
      t.datetime('deleted_at').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('spaces', 'deleted_by_membership_id'))) {
    await knex.schema.alterTable('spaces', (t) => {
      t.integer('deleted_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }

  // 5. Create space_activity_types join table
  if (!(await knex.schema.hasTable('space_activity_types'))) {
    await knex.schema.createTable('space_activity_types', (t) => {
      t.increments('id').primary();
      t.integer('space_id').unsigned().notNullable()
        .references('id').inTable('spaces').onDelete('CASCADE');
      t.integer('activity_type_id').unsigned().notNullable()
        .references('id').inTable('activity_types').onDelete('CASCADE');
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.unique(['space_id', 'activity_type_id'], 'sat_space_activity_unique');
    });
  }

  // 6. Rename class_sessions.room_id → space_id
  if (await knex.schema.hasColumn('class_sessions', 'room_id')) {
    await knex.raw('ALTER TABLE class_sessions DROP FOREIGN KEY class_sessions_room_id_foreign').catch(() => {});
    await knex.schema.alterTable('class_sessions', (t) => {
      t.renameColumn('room_id', 'space_id');
    });
    await knex.schema.alterTable('class_sessions', (t) => {
      t.integer('space_id').unsigned().nullable()
        .references('id').inTable('spaces').onDelete('SET NULL').alter();
    });
  }
};

exports.down = async (knex) => {
  // Reverse class_sessions rename
  if (await knex.schema.hasColumn('class_sessions', 'space_id')) {
    await knex.raw('ALTER TABLE class_sessions DROP FOREIGN KEY class_sessions_space_id_foreign').catch(() => {});
    await knex.schema.alterTable('class_sessions', (t) => {
      t.renameColumn('space_id', 'room_id');
    });
    await knex.schema.alterTable('class_sessions', (t) => {
      t.integer('room_id').unsigned().nullable()
        .references('id').inTable('spaces').onDelete('SET NULL').alter();
    });
  }

  await knex.schema.dropTableIfExists('space_activity_types');

  // Drop added columns
  for (const col of ['deleted_by_membership_id', 'deleted_at', 'created_by_membership_id', 'modified_by_membership_id', 'modified_at', 'opening_time', 'closing_time', 'notes', 'center_id']) {
    if (await knex.schema.hasColumn('spaces', col)) {
      await knex.schema.alterTable('spaces', (t) => t.dropColumn(col));
    }
  }

  // Restore status check
  await knex.raw('ALTER TABLE spaces DROP CHECK spaces_status_check').catch(() => {});
  await knex.raw(
    "ALTER TABLE spaces ADD CONSTRAINT rooms_status_check " +
    "CHECK (status IN ('active','inactive'))",
  );

  await knex.schema.renameTable('spaces', 'rooms');
};
