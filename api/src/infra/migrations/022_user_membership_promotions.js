/**
 * P4.4 (#28): applied promotions per user_membership.
 * Unique (user_membership_id, promotion_id) so a promo can't be applied twice.
 * Cascade on user_memberships so revoking membership tidies up its promotions.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('user_membership_promotions')) return;
  await knex.schema.createTable('user_membership_promotions', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('user_membership_id').unsigned().notNullable()
      .references('id').inTable('user_memberships').onDelete('CASCADE');
    t.integer('promotion_id').unsigned().notNullable()
      .references('id').inTable('promotions').onDelete('RESTRICT');
    t.string('applied_by', 64);
    t.datetime('applied_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.datetime('consumed_at');
    t.string('status', 20).notNullable().defaultTo('applied');
    t.unique(['user_membership_id', 'promotion_id'], 'ump_unique_pair');
  });
  await knex.raw(
    "ALTER TABLE user_membership_promotions ADD CONSTRAINT ump_status_check " +
    "CHECK (status IN ('applied','consumed','revoked'))",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE user_membership_promotions DROP CHECK ump_status_check').catch(() => {});
  await knex.schema.dropTableIfExists('user_membership_promotions');
};
