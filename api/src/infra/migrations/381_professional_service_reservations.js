/**
 * #2605 stage 1: a booking reserves one Professional Service session.
 *
 * One row per booking (`UNIQUE (calendar_event_booking_id)`). The row names the
 * grant it is held against by the same `(source_kind, source_reference_id)` pair
 * the consumption ledger uses. `reserved` rows reduce what the member can still
 * book (available = remaining - reserved); they never reduce the remaining
 * balance itself, which stays derived from grants minus consumption rows.
 * `released` = event or booking cancelled in time, `consumed` = turned into a
 * consumption row. Append-only in spirit: rows are never deleted.
 */
exports.up = async (knex) => {
  await knex.schema.createTable('professional_service_reservations', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('member_id').unsigned().notNullable()
      .references('id').inTable('members').onDelete('CASCADE');
    t.integer('calendar_event_booking_id').unsigned().notNullable();
    t.foreign('calendar_event_booking_id', 'fk_psr_booking')
      .references('id').inTable('calendar_event_bookings').onDelete('CASCADE');
    t.integer('calendar_event_id').unsigned().notNullable();
    t.integer('professional_service_id').unsigned().notNullable();
    t.string('source_kind', 30).notNullable();
    t.integer('source_reference_id').unsigned().notNullable();
    t.string('status', 20).notNullable().defaultTo('reserved');
    t.timestamp('released_at').nullable();
    t.timestamp('consumed_at').nullable();
    t.string('created_by', 255).nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['calendar_event_booking_id'], { indexName: 'psr_one_per_booking' });
    t.index(['gym_id', 'member_id', 'status'], 'psr_member_status');
  });
  await knex.raw(
    "ALTER TABLE professional_service_reservations ADD CONSTRAINT chk_psr_status CHECK (status IN ('reserved','released','consumed'))",
  );
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('professional_service_reservations');
};
