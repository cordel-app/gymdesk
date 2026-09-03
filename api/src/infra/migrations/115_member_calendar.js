/**
 * #324: Member Calendar — Free/Busy Availability and Booking Actions.
 *
 * 1. activity_types.is_shareable — whether this activity type can participate
 *    in shared-training bookings at all. Default false.
 *
 * 2. class_sessions.allows_shared_booking — explicit per-session flag set by
 *    a trainer or admin to authorize a second group. Default false.
 *    V1 rule: false = max 1 group; true = max 2 groups.
 *
 * 3. shared_training_requests — pending/approved/rejected/cancelled requests
 *    from members who want to join an already-occupied session as a second
 *    group. Approval creates a normal booking via the existing booking engine.
 *    The UNIQUE constraint prevents duplicate requests per member per session.
 *
 * 4. Seeds the calendar.member_calendar feature flag (enabled = 1).
 */
exports.up = async (knex) => {
  // 1. activity_types.is_shareable
  const hasShareable = await knex.schema.hasColumn('activity_types', 'is_shareable');
  if (!hasShareable) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.tinyint('is_shareable').notNullable().defaultTo(0).after('color');
    });
  }

  // 2. class_sessions.allows_shared_booking
  const hasSharedBooking = await knex.schema.hasColumn('class_sessions', 'allows_shared_booking');
  if (!hasSharedBooking) {
    await knex.schema.alterTable('class_sessions', (t) => {
      t.tinyint('allows_shared_booking').notNullable().defaultTo(0).after('cancellation_reason');
    });
  }

  // 3. shared_training_requests
  if (!(await knex.schema.hasTable('shared_training_requests'))) {
    await knex.schema.createTable('shared_training_requests', (t) => {
      t.increments('id').primary();
      t.string('gym_id', 36).notNullable().references('id').inTable('gyms');
      t.integer('class_session_id').unsigned().notNullable().references('id').inTable('class_sessions');
      t.integer('requesting_member_id').unsigned().notNullable().references('id').inTable('members');
      t.integer('activity_type_id').unsigned().notNullable().references('id').inTable('activity_types');
      t.string('status', 20).notNullable().defaultTo('pending');
      // Reviewed by a gym_membership (trainer or admin) — staff actor, not a member.
      t.integer('reviewed_by_membership_id').unsigned().nullable().references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('reviewed_at').nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['gym_id', 'class_session_id', 'requesting_member_id'], 'uq_str_gym_session_member');
    });
    await knex.raw(
      "ALTER TABLE shared_training_requests ADD CONSTRAINT chk_str_status CHECK (status IN ('pending','approved','rejected','cancelled'))",
    );
    await knex.raw(
      'ALTER TABLE shared_training_requests ADD INDEX str_gym_session_idx (gym_id, class_session_id)',
    );
    await knex.raw(
      'ALTER TABLE shared_training_requests ADD INDEX str_member_idx (gym_id, requesting_member_id)',
    );
  }

  // 4. Seed calendar.member_calendar feature flag
  await knex.raw(
    "INSERT IGNORE INTO feature_flags (feature_key, enabled, updated_at) VALUES ('calendar.member_calendar', 1, UTC_TIMESTAMP())",
  );
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('shared_training_requests');

  const hasSharedBooking = await knex.schema.hasColumn('class_sessions', 'allows_shared_booking');
  if (hasSharedBooking) {
    await knex.schema.alterTable('class_sessions', (t) => t.dropColumn('allows_shared_booking'));
  }

  const hasShareable = await knex.schema.hasColumn('activity_types', 'is_shareable');
  if (hasShareable) {
    await knex.schema.alterTable('activity_types', (t) => t.dropColumn('is_shareable'));
  }

  await knex.raw("DELETE FROM feature_flags WHERE feature_key = 'calendar.member_calendar'");
};
