/**
 * Initial schema (MySQL 8, Knex). Equivalent of the original Postgres schema:
 * - uuid            -> CHAR(36), DB default (UUID())
 * - timestamptz     -> DATETIME, UTC by convention, default CURRENT_TIMESTAMP
 * - text (indexed)  -> VARCHAR (MySQL cannot index TEXT without a prefix length)
 * - CHECK constraints are named so later migrations can drop/replace them
 */

exports.up = async (knex) => {
  await knex.schema.createTable('gyms', (t) => {
    t.specificType('id', 'char(36)').primary().defaultTo(knex.raw('(UUID())'));
    t.string('name', 255).notNullable();
    t.string('slug', 255).notNullable().unique();
    t.string('plan', 50).notNullable().defaultTo('free');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
  });

  await knex.schema.createTable('gym_memberships', (t) => {
    t.increments('id').primary();
    t.string('user_id', 255).notNullable();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.string('role', 20).notNullable();
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.unique(['user_id', 'gym_id'], { indexName: 'gym_memberships_user_gym_unique' });
  });
  await knex.raw(
    "ALTER TABLE gym_memberships ADD CONSTRAINT gym_memberships_role_check CHECK (role IN ('admin','coach','staff'))",
  );

  await knex.schema.createTable('members', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').references('id').inTable('gyms');
    t.string('name', 255).notNullable();
    t.string('email', 255).notNullable().unique();
    t.string('phone', 50);
    t.datetime('deleted_at');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
  });

  await knex.schema.createTable('classes', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').references('id').inTable('gyms');
    t.string('name', 255).notNullable();
    t.text('description');
    t.integer('capacity').notNullable().defaultTo(10);
    t.datetime('starts_at').notNullable();
    t.datetime('ends_at').notNullable();
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
  });

  await knex.schema.createTable('bookings', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').references('id').inTable('gyms');
    t.integer('member_id').unsigned().notNullable()
      .references('id').inTable('members').onDelete('CASCADE');
    t.integer('class_id').unsigned().notNullable()
      .references('id').inTable('classes').onDelete('CASCADE');
    t.string('status', 20).notNullable().defaultTo('confirmed');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.unique(['member_id', 'class_id'], { indexName: 'bookings_member_class_unique' });
  });

  await knex.schema.createTable('subscriptions', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').references('id').inTable('gyms');
    t.integer('member_id').unsigned().notNullable()
      .references('id').inTable('members').onDelete('CASCADE');
    t.string('plan', 255).notNullable();
    t.date('starts_at').notNullable();
    t.date('ends_at');
    t.string('status', 20).notNullable().defaultTo('active');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('subscriptions');
  await knex.schema.dropTableIfExists('bookings');
  await knex.schema.dropTableIfExists('classes');
  await knex.schema.dropTableIfExists('members');
  await knex.schema.dropTableIfExists('gym_memberships');
  await knex.schema.dropTableIfExists('gyms');
};
