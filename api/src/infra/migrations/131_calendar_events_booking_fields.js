/**
 * #360 stage 2 (schema): add the fields `calendar_events` needs to absorb
 * from `class_sessions` so it can become the canonical bookable entity.
 * See docs/architecture.md's "Planned: CalendarEvent Unification" section
 * and docs/decisions.md #10 for the agreed target shape.
 *
 * This migration is schema-only — no application code reads/writes these
 * columns yet. Booking/waitlist/attendance logic moves onto calendar_events
 * in a later stage (calendar_event_bookings, added in 132/133).
 *
 * capacity: replaces class_sessions.max_capacity_override — how many
 *   reservations this specific occurrence allows, independent of the
 *   activity type's default max_capacity.
 * allows_shared_booking: mirrors class_sessions.allows_shared_booking (#324)
 *   — per-occurrence authorization for a second group to book in.
 * effective_trainer_membership_id / effective_trainer_confirmed_at: mirror
 *   class_sessions' pair (#193) recording who actually delivered the
 *   occurrence, for attendance reporting.
 * cancellation_reason: mirrors class_sessions.cancellation_reason.
 */

exports.up = async (knex) => {
  const has = (col) => knex.schema.hasColumn('calendar_events', col);

  if (!(await has('capacity'))) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.integer('capacity').unsigned().nullable().after('activity_type_id');
    });
  }

  if (!(await has('allows_shared_booking'))) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.tinyint('allows_shared_booking').notNullable().defaultTo(0).after('capacity');
    });
  }

  if (!(await has('cancellation_reason'))) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.text('cancellation_reason').nullable().after('description');
    });
  }

  if (!(await has('effective_trainer_membership_id'))) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.integer('effective_trainer_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL')
        .after('trainer_membership_id');
    });
  }

  if (!(await has('effective_trainer_confirmed_at'))) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.datetime('effective_trainer_confirmed_at').nullable().after('effective_trainer_membership_id');
    });
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('calendar_events', 'effective_trainer_confirmed_at')) {
    await knex.schema.alterTable('calendar_events', (t) => t.dropColumn('effective_trainer_confirmed_at'));
  }
  if (await knex.schema.hasColumn('calendar_events', 'effective_trainer_membership_id')) {
    await knex.raw('ALTER TABLE calendar_events DROP FOREIGN KEY calendar_events_effective_trainer_membership_id_foreign').catch(() => {});
    await knex.schema.alterTable('calendar_events', (t) => t.dropColumn('effective_trainer_membership_id'));
  }
  if (await knex.schema.hasColumn('calendar_events', 'cancellation_reason')) {
    await knex.schema.alterTable('calendar_events', (t) => t.dropColumn('cancellation_reason'));
  }
  if (await knex.schema.hasColumn('calendar_events', 'allows_shared_booking')) {
    await knex.schema.alterTable('calendar_events', (t) => t.dropColumn('allows_shared_booking'));
  }
  if (await knex.schema.hasColumn('calendar_events', 'capacity')) {
    await knex.schema.alterTable('calendar_events', (t) => t.dropColumn('capacity'));
  }
};
