/**
 * #323: Shared Training Slots — phase 2: shared_training_requests table.
 *
 * A request represents a member asking to use an occupied-but-shareable slot
 * with a different activity group.  Status lifecycle: pending → approved | rejected.
 *
 * resolved_class_session_id is set on approval to the newly created concurrent session.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('shared_training_requests'))) {
    await knex.schema.createTable('shared_training_requests', (t) => {
      t.increments('id').unsigned().primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('host_session_id').unsigned().notNullable()
        .references('id').inTable('class_sessions').onDelete('CASCADE');
      t.integer('requested_activity_type_id').unsigned().notNullable()
        .references('id').inTable('activity_types').onDelete('CASCADE');
      t.integer('requesting_member_id').unsigned().notNullable()
        .references('id').inTable('members').onDelete('CASCADE');
      t.string('status', 20).notNullable().defaultTo('pending');
      t.integer('resolved_class_session_id').unsigned().nullable()
        .references('id').inTable('class_sessions').onDelete('SET NULL');
      t.integer('resolved_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('resolved_at').nullable();
      t.text('notes').nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    });

    await knex.raw(
      "ALTER TABLE shared_training_requests " +
      "ADD CONSTRAINT chk_shared_training_requests_status " +
      "CHECK (status IN ('pending','approved','rejected'))"
    );
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasTable('shared_training_requests')) {
    await knex.raw("ALTER TABLE shared_training_requests DROP CONSTRAINT chk_shared_training_requests_status");
    await knex.schema.dropTable('shared_training_requests');
  }
};
