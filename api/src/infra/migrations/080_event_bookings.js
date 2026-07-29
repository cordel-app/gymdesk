/**
 * #192: event_bookings — booking management for Calendar Events.
 * Separate from the existing `bookings` table which is scoped to class_sessions.
 * Uniqueness among non-cancelled (event_id, member_id) pairs is enforced at
 * the router level; MySQL has no partial unique indexes.
 */
exports.up = async (knex) => {
  if (!await knex.schema.hasTable('event_bookings')) {
    await knex.schema.createTable('event_bookings', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('center_id').unsigned().notNullable()
        .references('id').inTable('centers').onDelete('CASCADE');
      t.integer('event_id').unsigned().notNullable()
        .references('id').inTable('events').onDelete('CASCADE');
      t.integer('member_id').unsigned().notNullable()
        .references('id').inTable('members').onDelete('CASCADE');
      t.string('status', 20).notNullable().defaultTo('booked');
      t.integer('waitlist_position').unsigned();
      t.datetime('booked_at');
      t.datetime('waitlisted_at');
      t.datetime('cancelled_at');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('UTC_TIMESTAMP()'));
      t.integer('created_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('modified_at');
      t.integer('modified_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.index(['event_id', 'member_id'], 'eb_event_member_idx');
      t.index(['gym_id', 'event_id', 'status'], 'eb_gym_event_status_idx');
    });
  }

  // Independently idempotent: add the CHECK constraint only if it doesn't exist yet.
  const [[{ cnt }]] = await knex.raw(
    "SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS " +
    "WHERE CONSTRAINT_SCHEMA = DATABASE() " +
    "  AND TABLE_NAME = 'event_bookings' " +
    "  AND CONSTRAINT_NAME = 'chk_event_bookings_status'",
  );
  if (cnt === 0) {
    await knex.raw(
      "ALTER TABLE event_bookings ADD CONSTRAINT chk_event_bookings_status " +
      "CHECK (status IN ('booked','waitlisted','cancelled'))",
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE event_bookings DROP CHECK chk_event_bookings_status').catch(() => {});
  await knex.schema.dropTableIfExists('event_bookings');
};
