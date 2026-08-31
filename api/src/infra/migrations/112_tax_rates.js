/**
 * #311: Tax Rates module
 *
 * Creates tax_rates table with one system default (Standard VAT 21%) per gym.
 * Each gym gets exactly one is_system=1 row that cannot be deleted.
 * Custom tax rates (is_system=0) support full CRUD with soft-delete.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('tax_rates'))) {
    await knex.schema.createTable('tax_rates', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 100).notNullable();
      t.decimal('rate_percent', 5, 2).notNullable();
      t.tinyint('is_system').notNullable().defaultTo(0);
      t.string('status', 20).notNullable().defaultTo('active');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('UTC_TIMESTAMP()'));
      t.integer('created_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('modified_at').nullable();
      t.integer('modified_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('deleted_at').nullable();
      t.integer('deleted_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.string('deleted_by_name', 200).nullable();
    });

    await knex.raw(
      "ALTER TABLE tax_rates ADD CONSTRAINT chk_tax_rates_status " +
      "CHECK (status IN ('active','inactive'))",
    );

    // Backfill: seed one system default per existing gym
    await knex.raw(`
      INSERT IGNORE INTO tax_rates (gym_id, name, rate_percent, is_system, status, created_at)
      SELECT id, 'Standard VAT', 21.00, 1, 'active', UTC_TIMESTAMP()
      FROM gyms
    `);
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('tax_rates');
};
