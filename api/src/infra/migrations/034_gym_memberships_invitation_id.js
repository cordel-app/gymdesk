/**
 * Add invitation_id column to gym_memberships to track Clerk invitation IDs.
 * Allows revoking Clerk invitations when removing invited users.
 */

exports.up = async (knex) => {
  await knex.schema.alterTable('gym_memberships', (t) => {
    t.string('invitation_id', 255).nullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('gym_memberships', (t) => {
    t.dropColumn('invitation_id');
  });
};
