/**
 * #1603: nutrition_requirement_logs — a member's completion of one dietary
 * restriction or one nutritional goal on a date. A restriction may be `partial`
 * or `done`; a goal is only ever `done`. Like nutrition_logs there is no delete
 * route: `partial` can be raised to `done`, nothing is taken back.
 *
 * Exactly one of goal_id / restriction_id is set (CHECK); `item_key` is the
 * generated column the UNIQUE index is built on, since a UNIQUE over two
 * nullable columns would not stop a duplicate. Both FKs cascade, so replacing a
 * plan's rows needs no cleanup ordering.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('nutrition_requirement_logs')) return;
  await knex.schema.createTable('nutrition_requirement_logs', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('member_id').unsigned().notNullable()
      .references('id').inTable('members').onDelete('CASCADE');
    t.integer('goal_id').unsigned().nullable()
      .references('id').inTable('member_nutrition_plan_goals').onDelete('CASCADE');
    t.integer('restriction_id').unsigned().nullable()
      .references('id').inTable('member_nutrition_plan_restrictions').onDelete('CASCADE');
    t.date('logged_date').notNullable();
    t.string('level', 10).notNullable().defaultTo('done');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
  });
  await knex.raw(`ALTER TABLE nutrition_requirement_logs
    ADD COLUMN item_key VARCHAR(24) GENERATED ALWAYS AS (IF(goal_id IS NOT NULL, CONCAT('g', goal_id), CONCAT('r', restriction_id))) VIRTUAL,
    ADD CONSTRAINT chk_nrl_one_item CHECK ((goal_id IS NULL) <> (restriction_id IS NULL)),
    ADD CONSTRAINT chk_nrl_level CHECK (level IN ('partial', 'done')),
    ADD UNIQUE KEY nrl_member_item_date_key (member_id, item_key, logged_date),
    ADD KEY nrl_member_date_index (gym_id, member_id, logged_date)`);
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('nutrition_requirement_logs');
};
