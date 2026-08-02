/**
 * #190: Add calendar-default columns to activity_types so the Calendar module
 * can auto-populate space, trainer, and colour when creating an event.
 */
exports.up = async (knex) => {
  const hasSpace = await knex.schema.hasColumn('activity_types', 'default_space_id');
  if (!hasSpace) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.integer('default_space_id').unsigned().nullable()
        .references('id').inTable('spaces').onDelete('SET NULL');
    });
  }

  const hasTrainer = await knex.schema.hasColumn('activity_types', 'default_trainer_membership_id');
  if (!hasTrainer) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.integer('default_trainer_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }

  const hasColor = await knex.schema.hasColumn('activity_types', 'color');
  if (!hasColor) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.string('color', 7).nullable();
    });
  }
};

exports.down = async (knex) => {
  const hasColor = await knex.schema.hasColumn('activity_types', 'color');
  if (hasColor) {
    await knex.schema.alterTable('activity_types', (t) => { t.dropColumn('color'); });
  }

  const hasTrainer = await knex.schema.hasColumn('activity_types', 'default_trainer_membership_id');
  if (hasTrainer) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.dropForeign(['default_trainer_membership_id']);
      t.dropColumn('default_trainer_membership_id');
    });
  }

  const hasSpace = await knex.schema.hasColumn('activity_types', 'default_space_id');
  if (hasSpace) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.dropForeign(['default_space_id']);
      t.dropColumn('default_space_id');
    });
  }
};
