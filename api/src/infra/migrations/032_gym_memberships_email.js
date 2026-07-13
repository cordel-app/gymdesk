/**
 * Add email column to gym_memberships to track invited user emails.
 * Necessary to match invited users when they accept and sign in.
 */

exports.up = async (knex) => {
  await knex.schema.alterTable('gym_memberships', (t) => {
    t.string('email', 255).nullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('gym_memberships', (t) => {
    t.dropColumn('email');
  });
};
