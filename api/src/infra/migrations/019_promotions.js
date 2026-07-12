/**
 * P4.1 (#25): global action_types vocabulary + per-gym promotions catalog.
 */
const ACTION_SEED = [
  { code: 'waive' },
  { code: 'percentage_discount' },
  { code: 'fixed_discount' },
];

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('action_types'))) {
    await knex.schema.createTable('action_types', (t) => {
      t.increments('id').primary();
      t.string('code', 40).notNullable().unique();
      t.boolean('active').notNullable().defaultTo(true);
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    });
    await knex('action_types').insert(ACTION_SEED);
  }

  if (!(await knex.schema.hasTable('promotions'))) {
    await knex.schema.createTable('promotions', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 120).notNullable();
      t.text('description');
      t.datetime('starts_at').notNullable();
      t.datetime('ends_at').notNullable();
      t.boolean('stackable').notNullable().defaultTo(false);
      t.string('status', 20).notNullable().defaultTo('active');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.index(['gym_id', 'status'], 'promotions_gym_status_index');
    });
    await knex.raw(
      "ALTER TABLE promotions ADD CONSTRAINT promotions_status_check " +
      "CHECK (status IN ('active','inactive'))",
    );
    await knex.raw(
      "ALTER TABLE promotions ADD CONSTRAINT promotions_dates_check " +
      "CHECK (ends_at >= starts_at)",
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE promotions DROP CHECK promotions_status_check').catch(() => {});
  await knex.raw('ALTER TABLE promotions DROP CHECK promotions_dates_check').catch(() => {});
  await knex.schema.dropTableIfExists('promotions');
  await knex.schema.dropTableIfExists('action_types');
};
