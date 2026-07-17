/**
 * #63: workout_templates gains created_by_membership_id so the tree-grid page
 * can show/filter by author, mirroring training_plan_templates (038). Nullable:
 * templates created before this migration have no creator on record.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('workout_templates', 'created_by_membership_id'))) {
    await knex.schema.alterTable('workout_templates', (t) => {
      t.integer('created_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('workout_templates', 'created_by_membership_id')) {
    await knex.schema.alterTable('workout_templates', (t) => {
      t.dropForeign(['created_by_membership_id']);
      t.dropColumn('created_by_membership_id');
    });
  }
};
