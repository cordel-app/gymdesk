/**
 * #323: Shared Training Slots — phase 2: extend shared_training_requests table.
 *
 * The shared_training_requests table was created by 115_member_calendar.js (#324).
 * This migration adds:
 *   notes TEXT nullable — optional message from the requesting member.
 */

exports.up = async (knex) => {
  if (await knex.schema.hasTable('shared_training_requests')) {
    if (!(await knex.schema.hasColumn('shared_training_requests', 'notes'))) {
      await knex.schema.alterTable('shared_training_requests', (t) => {
        t.text('notes').nullable();
      });
    }
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasTable('shared_training_requests')) {
    if (await knex.schema.hasColumn('shared_training_requests', 'notes')) {
      await knex.schema.alterTable('shared_training_requests', (t) => t.dropColumn('notes'));
    }
  }
};
