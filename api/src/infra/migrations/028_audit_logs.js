/**
 * P6.1 (#36): audit_logs. MySQL substitutions per the ticket's amendment:
 *   previous_values / new_values → JSON (not jsonb)
 *   ip → VARCHAR(45) (no inet type)
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('audit_logs')) return;
  await knex.schema.createTable('audit_logs', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.string('actor_user_id', 64);
    t.string('action', 60).notNullable();
    t.string('entity_type', 60).notNullable();
    t.string('entity_id', 64);
    t.json('previous_values');
    t.json('new_values');
    t.string('source', 20);
    t.string('ip', 45);
    t.string('user_agent', 500);
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.index(['gym_id', 'entity_type', 'entity_id'], 'audit_logs_entity_index');
    t.index(['gym_id', 'created_at'], 'audit_logs_gym_created_index');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('audit_logs');
};
