/**
 * #1580: nutrition_logs — a member's completion of one scheduled meal.
 *
 * A "scheduled meal instance" is (member_nutrition_plan_meals.id, date): the
 * meal row is the stable identifier and the date comes from its day's weekday
 * (0=Sunday … 6=Saturday, 7=all days) on the member's active plan. The log
 * stores exactly that pair and nothing else about the plan or its foods.
 *
 * UNIQUE (member_id, meal_id, logged_date) makes a repeated or concurrent
 * request unable to create a second record. Every FK is ON DELETE CASCADE, so
 * editing a plan (which replaces meal rows) or removing a member needs no
 * ordering in cleanup code.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('nutrition_logs')) return;
  await knex.schema.createTable('nutrition_logs', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('member_id').unsigned().notNullable()
      .references('id').inTable('members').onDelete('CASCADE');
    t.integer('meal_id').unsigned().notNullable()
      .references('id').inTable('member_nutrition_plan_meals').onDelete('CASCADE');
    t.date('logged_date').notNullable();
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.unique(['member_id', 'meal_id', 'logged_date'], 'nutrition_logs_member_meal_date_key');
    t.index(['gym_id', 'member_id', 'logged_date'], 'nutrition_logs_member_date_index');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('nutrition_logs');
};
