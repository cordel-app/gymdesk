/**
 * Add invitation_id column to members to track the Clerk invitation issued for
 * member-portal access. Allows revoking the Clerk invitation when a member is
 * removed (or explicitly un-invited) before they accept it.
 */

exports.up = async (knex) => {
  await knex.schema.alterTable('members', (t) => {
    t.string('invitation_id', 255).nullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('members', (t) => {
    t.dropColumn('invitation_id');
  });
};
