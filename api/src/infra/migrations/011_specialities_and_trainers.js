/**
 * P2.2 (#14): per-gym specialities + trainer_specialities join.
 * Trainers are existing coach-role rows in gym_memberships — no new user table.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('specialities'))) {
    await knex.schema.createTable('specialities', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 120).notNullable();
      t.text('description');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.unique(['gym_id', 'name'], 'specialities_gym_name_unique');
    });
  }

  if (!(await knex.schema.hasTable('trainer_specialities'))) {
    await knex.schema.createTable('trainer_specialities', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('gym_membership_id').unsigned().notNullable()
        .references('id').inTable('gym_memberships').onDelete('CASCADE');
      t.integer('speciality_id').unsigned().notNullable()
        .references('id').inTable('specialities').onDelete('CASCADE');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.unique(['gym_membership_id', 'speciality_id'], 'trainer_specialities_unique_pair');
      t.index(['gym_id'], 'trainer_specialities_gym_index');
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('trainer_specialities');
  await knex.schema.dropTableIfExists('specialities');
};
