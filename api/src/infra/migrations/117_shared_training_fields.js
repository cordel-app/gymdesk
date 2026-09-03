/**
 * #323: Shared Training Slots — phase 1: concurrent-group limits.
 *
 * spaces.max_concurrent_groups      — how many groups the space can host simultaneously.
 * gym_memberships.max_concurrent_groups — how many groups a trainer can coach simultaneously.
 *
 * Note: activity_types.is_shareable and class_sessions.allows_shared_booking were added by
 * migration 115_member_calendar.js (#324). This migration only adds the capacity limits.
 */

exports.up = async (knex) => {
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
};

exports.down = async (knex) => {
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
};
