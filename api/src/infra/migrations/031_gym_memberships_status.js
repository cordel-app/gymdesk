/**
 * Add status column to gym_memberships to track invited vs confirmed members.
 * Allows admins to see who they've invited before they accept.
 *
 * Status values:
 * - 'invited': User was sent an invitation, not yet accepted
 * - 'active': User accepted invitation or was directly granted
 */

exports.up = async (knex) => {
  await knex.schema.alterTable('gym_memberships', (t) => {
    t.string('status', 20).notNullable().defaultTo('active');
  });

  // Add CHECK constraint for valid status values
  await knex.raw(
    "ALTER TABLE gym_memberships ADD CONSTRAINT gym_memberships_status_check CHECK (status IN ('invited','active'))",
  );
};

exports.down = async (knex) => {
  await knex.schema.alterTable('gym_memberships', (t) => {
    t.dropColumn('status');
  });

  await knex.raw(
    'ALTER TABLE gym_memberships DROP CHECK gym_memberships_status_check',
  );
};
