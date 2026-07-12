/**
 * P2.7 (#19): class_type_user_memberships — which class types each plan grants access to.
 * "user_memberships" in the table name follows the P1.5 rename convention (from the
 * ER-diagram-facing "user_memberships"). The row is really "class-type ↔ plan"; the
 * enforcement compares against a member's *user_memberships* rows at booking time.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('class_type_user_memberships')) return;
  await knex.schema.createTable('class_type_user_memberships', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('class_type_id').unsigned().notNullable()
      .references('id').inTable('class_types').onDelete('CASCADE');
    t.integer('membership_plan_id').unsigned().notNullable()
      .references('id').inTable('membership_plans').onDelete('CASCADE');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.unique(['class_type_id', 'membership_plan_id'], 'ctum_unique_pair');
    t.index(['membership_plan_id'], 'ctum_plan_index');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('class_type_user_memberships');
};
