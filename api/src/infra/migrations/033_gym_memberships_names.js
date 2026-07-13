/**
 * Add name column to gym_memberships.
 * Allows capturing invited user names during invitation.
 */

exports.up = async (knex) => {
  await knex.schema.alterTable('gym_memberships', (t) => {
    t.string('name', 255).nullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('gym_memberships', (t) => {
    t.dropColumn('name');
  });
};
