/**
 * #70: Create membership_plan_centers — optional center restriction per plan.
 * If no rows exist for a plan, the plan is valid at all centers.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('membership_plan_centers'))) {
    await knex.schema.createTable('membership_plan_centers', (t) => {
      t.increments('id').unsigned().primary();
      t.specificType('gym_id', 'char(36)').notNullable().references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('membership_plan_id').unsigned().notNullable().references('id').inTable('membership_plans').onDelete('CASCADE');
      t.integer('center_id').unsigned().notNullable().references('id').inTable('centers').onDelete('CASCADE');
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['membership_plan_id', 'center_id']);
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('membership_plan_centers');
};
