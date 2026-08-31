/**
 * #311: Link gym_charges and membership_plans to tax_rates
 *
 * 1. gym_charges: add tax_behavior ENUM and tax_rate_id FK → tax_rates.id
 * 2. membership_plans: add tax_rate_id FK → tax_rates.id
 * Both columns backfill from each gym's system default tax_rate row.
 */

exports.up = async (knex) => {
  // 1a. Add tax_behavior to gym_charges
  if (!(await knex.schema.hasColumn('gym_charges', 'tax_behavior'))) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.string('tax_behavior', 20).notNullable().defaultTo('inclusive');
    });
    await knex.raw(
      "ALTER TABLE gym_charges ADD CONSTRAINT gym_charges_tax_behavior_check " +
      "CHECK (tax_behavior IN ('inclusive','exclusive'))",
    );
  }

  // 1b. Add tax_rate_id to gym_charges
  if (!(await knex.schema.hasColumn('gym_charges', 'tax_rate_id'))) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.integer('tax_rate_id').unsigned().nullable()
        .references('id').inTable('tax_rates').onDelete('SET NULL');
    });
    await knex.raw(`
      UPDATE gym_charges gc
      JOIN tax_rates tr ON tr.gym_id = gc.gym_id AND tr.is_system = 1 AND tr.deleted_at IS NULL
      SET gc.tax_rate_id = tr.id
      WHERE gc.tax_rate_id IS NULL
    `);
  }

  // 2. Add tax_rate_id to membership_plans
  if (!(await knex.schema.hasColumn('membership_plans', 'tax_rate_id'))) {
    await knex.schema.alterTable('membership_plans', (t) => {
      t.integer('tax_rate_id').unsigned().nullable()
        .references('id').inTable('tax_rates').onDelete('SET NULL');
    });
    await knex.raw(`
      UPDATE membership_plans mp
      JOIN tax_rates tr ON tr.gym_id = mp.gym_id AND tr.is_system = 1 AND tr.deleted_at IS NULL
      SET mp.tax_rate_id = tr.id
      WHERE mp.tax_rate_id IS NULL
    `);
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('membership_plans', 'tax_rate_id')) {
    await knex.raw('ALTER TABLE membership_plans DROP FOREIGN KEY membership_plans_tax_rate_id_foreign').catch(() => {});
    await knex.schema.alterTable('membership_plans', (t) => {
      t.dropColumn('tax_rate_id');
    });
  }
  if (await knex.schema.hasColumn('gym_charges', 'tax_rate_id')) {
    await knex.raw('ALTER TABLE gym_charges DROP FOREIGN KEY gym_charges_tax_rate_id_foreign').catch(() => {});
    await knex.schema.alterTable('gym_charges', (t) => {
      t.dropColumn('tax_rate_id');
    });
  }
  if (await knex.schema.hasColumn('gym_charges', 'tax_behavior')) {
    await knex.raw('ALTER TABLE gym_charges DROP CHECK gym_charges_tax_behavior_check').catch(() => {});
    await knex.schema.alterTable('gym_charges', (t) => {
      t.dropColumn('tax_behavior');
    });
  }
};
