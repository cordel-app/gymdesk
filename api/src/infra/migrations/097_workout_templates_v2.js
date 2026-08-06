/**
 * #223: Workout Templates lifecycle management — adds missing audit columns
 * (modified_at, modified_by_membership_id, deleted_by_membership_id) and a
 * notes field so trainers can share advice with gym users.
 */
exports.up = async (knex) => {
  const add = async (col, fn) => {
    if (!(await knex.schema.hasColumn('workout_templates', col))) {
      await knex.schema.alterTable('workout_templates', fn);
    }
  };

  await add('modified_at', (t) => t.datetime('modified_at').nullable()); // NULL = never modified after creation
  await add('modified_by_membership_id', (t) =>
    t.integer('modified_by_membership_id').unsigned()
      .references('id').inTable('gym_memberships').onDelete('SET NULL'),
  );
  await add('deleted_by_membership_id', (t) =>
    t.integer('deleted_by_membership_id').unsigned()
      .references('id').inTable('gym_memberships').onDelete('SET NULL'),
  );
  await add('notes', (t) => t.text('notes'));
};

exports.down = async (knex) => {
  const drop = async (col, fk) => {
    if (await knex.schema.hasColumn('workout_templates', col)) {
      await knex.schema.alterTable('workout_templates', (t) => {
        if (fk) t.dropForeign([col]);
        t.dropColumn(col);
      });
    }
  };
  await drop('notes', false);
  await drop('deleted_by_membership_id', true);
  await drop('modified_by_membership_id', true);
  await drop('modified_at', false);
};
