/**
 * #323: Shared Training Slots — phase 1: column additions.
 *
 * activity_types.shareable     — whether an activity can participate in shared slots.
 * spaces.max_concurrent_groups — how many groups the space can host simultaneously.
 * gym_memberships.max_concurrent_groups — how many groups a trainer can coach simultaneously.
 * class_sessions.sharing_authorized    — whether a second group is allowed to join this slot.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('activity_types', 'shareable'))) {
    await knex.schema.alterTable('activity_types', (t) =>
      t.boolean('shareable').notNullable().defaultTo(false),
    );
  }

  if (!(await knex.schema.hasColumn('spaces', 'max_concurrent_groups'))) {
    await knex.schema.alterTable('spaces', (t) =>
      t.specificType('max_concurrent_groups', 'TINYINT UNSIGNED').notNullable().defaultTo(1),
    );
  }

  if (!(await knex.schema.hasColumn('gym_memberships', 'max_concurrent_groups'))) {
    await knex.schema.alterTable('gym_memberships', (t) =>
      t.specificType('max_concurrent_groups', 'TINYINT UNSIGNED').notNullable().defaultTo(1),
    );
  }

  if (!(await knex.schema.hasColumn('class_sessions', 'sharing_authorized'))) {
    await knex.schema.alterTable('class_sessions', (t) =>
      t.boolean('sharing_authorized').notNullable().defaultTo(false),
    );
  }
};

exports.down = async (knex) => {
  for (const col of ['sharing_authorized']) {
    if (await knex.schema.hasColumn('class_sessions', col)) {
      await knex.schema.alterTable('class_sessions', (t) => t.dropColumn(col));
    }
  }
  for (const col of ['max_concurrent_groups']) {
    if (await knex.schema.hasColumn('gym_memberships', col)) {
      await knex.schema.alterTable('gym_memberships', (t) => t.dropColumn(col));
    }
  }
  for (const col of ['max_concurrent_groups']) {
    if (await knex.schema.hasColumn('spaces', col)) {
      await knex.schema.alterTable('spaces', (t) => t.dropColumn(col));
    }
  }
  for (const col of ['shareable']) {
    if (await knex.schema.hasColumn('activity_types', col)) {
      await knex.schema.alterTable('activity_types', (t) => t.dropColumn(col));
    }
  }
};
