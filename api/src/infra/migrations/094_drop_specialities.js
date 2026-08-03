/**
 * #219: Remove Speciality concept from the system.
 * Drop trainer_specialities, remove speciality_id from class_types and activity_types,
 * then drop the specialities table itself.
 */
exports.up = async (knex) => {
  // 1. Drop trainer_specialities (FK cascade handles child rows)
  await knex.schema.dropTableIfExists('trainer_specialities');

  // 2. Remove speciality_id FK + column from class_types
  if (await knex.schema.hasColumn('class_types', 'speciality_id')) {
    await knex.raw('ALTER TABLE class_types DROP FOREIGN KEY class_types_speciality_id_foreign').catch(() => {});
    await knex.schema.alterTable('class_types', (t) => t.dropColumn('speciality_id'));
  }

  // 3. Remove speciality_id FK + column from activity_types
  if (await knex.schema.hasColumn('activity_types', 'speciality_id')) {
    await knex.raw('ALTER TABLE activity_types DROP FOREIGN KEY activity_types_speciality_id_foreign').catch(() => {});
    await knex.schema.alterTable('activity_types', (t) => t.dropColumn('speciality_id'));
  }

  // 4. Drop specialities last (all FKs referencing it are gone by now)
  await knex.schema.dropTableIfExists('specialities');
};

exports.down = async (knex) => {
  // Recreate specialities
  if (!(await knex.schema.hasTable('specialities'))) {
    await knex.schema.createTable('specialities', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 120).notNullable();
      t.text('description');
      t.string('status', 20).notNullable().defaultTo('active');
      t.integer('created_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('modified_at').nullable();
      t.integer('modified_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('deleted_at').nullable();
      t.integer('deleted_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('UTC_TIMESTAMP()'));
      t.unique(['gym_id', 'name'], 'specialities_gym_name_unique');
    });
    await knex.raw(
      "ALTER TABLE specialities ADD CONSTRAINT chk_specialities_status CHECK (status IN ('active','inactive'))",
    );
  }

  // Restore speciality_id on class_types
  if (!(await knex.schema.hasColumn('class_types', 'speciality_id'))) {
    await knex.schema.alterTable('class_types', (t) => {
      t.integer('speciality_id').unsigned().nullable()
        .references('id').inTable('specialities').onDelete('SET NULL');
    });
  }

  // Restore speciality_id on activity_types
  if (!(await knex.schema.hasColumn('activity_types', 'speciality_id'))) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.integer('speciality_id').unsigned().nullable()
        .references('id').inTable('specialities').onDelete('SET NULL');
    });
  }

  // Recreate trainer_specialities
  if (!(await knex.schema.hasTable('trainer_specialities'))) {
    await knex.schema.createTable('trainer_specialities', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('gym_membership_id').unsigned().notNullable()
        .references('id').inTable('gym_memberships').onDelete('CASCADE');
      t.integer('speciality_id').unsigned().notNullable()
        .references('id').inTable('specialities').onDelete('CASCADE');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('UTC_TIMESTAMP()'));
      t.unique(['gym_membership_id', 'speciality_id'], 'trainer_specialities_unique_pair');
      t.index(['gym_id'], 'trainer_specialities_gym_index');
    });
  }
};
