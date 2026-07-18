/**
 * #69: Audit Log UX Improvements — add actor_name and entity_name snapshot
 * columns so each row is a self-contained historical record. Existing rows
 * are truncated (decision: clean slate, per ticket clarification).
 */
exports.up = async (knex) => {
  await knex.raw('TRUNCATE TABLE audit_logs');

  if (!(await knex.schema.hasColumn('audit_logs', 'actor_name'))) {
    await knex.schema.alterTable('audit_logs', (t) => {
      t.string('actor_name', 255).nullable().after('actor_user_id');
    });
  }
  if (!(await knex.schema.hasColumn('audit_logs', 'entity_name'))) {
    await knex.schema.alterTable('audit_logs', (t) => {
      t.string('entity_name', 255).nullable().after('entity_id');
    });
  }

  await knex.schema.alterTable('audit_logs', (t) => {
    t.index(['gym_id', 'actor_name'], 'audit_logs_actor_name_index');
    t.index(['gym_id', 'entity_name'], 'audit_logs_entity_name_index');
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('audit_logs', (t) => {
    t.dropIndex(['gym_id', 'actor_name'], 'audit_logs_actor_name_index');
    t.dropIndex(['gym_id', 'entity_name'], 'audit_logs_entity_name_index');
    t.dropColumn('actor_name');
    t.dropColumn('entity_name');
  });
};
