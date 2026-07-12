/**
 * P4.2 (#26): promotion → plan targeting + charge-fee benefits.
 * value is nullable and enforced NULL for 'waive' actions (application code
 * — a CROSS TABLE check would need a trigger).
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('promotion_membership_plans'))) {
    await knex.schema.createTable('promotion_membership_plans', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('promotion_id').unsigned().notNullable()
        .references('id').inTable('promotions').onDelete('CASCADE');
      t.integer('membership_plan_id').unsigned().notNullable()
        .references('id').inTable('membership_plans').onDelete('CASCADE');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.unique(['promotion_id', 'membership_plan_id'], 'pmp_unique_pair');
    });
  }

  if (!(await knex.schema.hasTable('promotion_charge_benefits'))) {
    await knex.schema.createTable('promotion_charge_benefits', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('promotion_id').unsigned().notNullable()
        .references('id').inTable('promotions').onDelete('CASCADE');
      t.integer('charge_type_id').unsigned().notNullable()
        .references('id').inTable('charge_types');
      t.integer('action_type_id').unsigned().notNullable()
        .references('id').inTable('action_types');
      t.decimal('value', 10, 2);
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.index(['promotion_id'], 'pcb_promotion_index');
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('promotion_charge_benefits');
  await knex.schema.dropTableIfExists('promotion_membership_plans');
};
