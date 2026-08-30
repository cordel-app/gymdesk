/**
 * #269: Add schedule_rule_id FK to calendar_events so that events generated
 * from an activity type schedule rule can be traced back to their source.
 * ON DELETE SET NULL: deleting the rule cancels its generated events at the
 * application layer first; this FK is purely for traceability.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('calendar_events', 'schedule_rule_id'))) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.integer('schedule_rule_id').unsigned().nullable()
        .references('id').inTable('activity_type_schedule_rules').onDelete('SET NULL');
    });
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('calendar_events', 'schedule_rule_id')) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.dropForeign(['schedule_rule_id']);
      t.dropColumn('schedule_rule_id');
    });
  }
};
