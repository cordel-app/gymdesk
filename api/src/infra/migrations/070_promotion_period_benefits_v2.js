/**
 * #127: redesign promotion_period_benefits from "pay X get Y free" model
 * to "plan + action + value + duration" model.
 */
exports.up = async (knex) => {
  await knex.raw('ALTER TABLE promotion_period_benefits DROP CHECK ppb_positive_check').catch(() => {});
  await knex.schema.dropTableIfExists('promotion_period_benefits');

  await knex.schema.createTable('promotion_period_benefits', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('promotion_id').unsigned().notNullable()
      .references('id').inTable('promotions').onDelete('CASCADE');
    t.integer('membership_plan_id').unsigned().notNullable()
      .references('id').inTable('membership_plans').onDelete('CASCADE');
    t.integer('action_type_id').unsigned().notNullable()
      .references('id').inTable('action_types');
    t.decimal('value', 10, 2).nullable();
    t.integer('duration_months').unsigned().notNullable();
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.index(['promotion_id'], 'ppb_promotion_index');
  });
  await knex.raw(
    "ALTER TABLE promotion_period_benefits ADD CONSTRAINT ppb_positive_check " +
    "CHECK (duration_months > 0)",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE promotion_period_benefits DROP CHECK ppb_positive_check').catch(() => {});
  await knex.schema.dropTableIfExists('promotion_period_benefits');

  await knex.schema.createTable('promotion_period_benefits', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('promotion_id').unsigned().notNullable()
      .references('id').inTable('promotions').onDelete('CASCADE');
    t.integer('required_paid_months').unsigned().notNullable();
    t.integer('granted_free_periods').unsigned().notNullable();
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.index(['promotion_id'], 'ppb_promotion_index');
  });
  await knex.raw(
    "ALTER TABLE promotion_period_benefits ADD CONSTRAINT ppb_positive_check " +
    "CHECK (required_paid_months > 0 AND granted_free_periods > 0)",
  );
};
