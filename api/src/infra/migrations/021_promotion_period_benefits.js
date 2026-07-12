/**
 * P4.3 (#27): "pay X months, get Y free" tiers on a promotion.
 * Both integers positive; multiple tiers per promotion.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('promotion_period_benefits')) return;
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

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE promotion_period_benefits DROP CHECK ppb_positive_check').catch(() => {});
  await knex.schema.dropTableIfExists('promotion_period_benefits');
};
