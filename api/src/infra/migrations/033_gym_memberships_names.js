/**
 * Add first_name and last_name columns to gym_memberships.
 * Allows capturing invited user names during invitation.
 */

exports.up = async (knex) => {
  await knex.schema.alterTable('gym_memberships', (t) => {
    t.string('first_name', 255).nullable();
    t.string('last_name', 255).nullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('gym_memberships', (t) => {
    t.dropColumn('first_name');
    t.dropColumn('last_name');
  });
};
