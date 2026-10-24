/**
 * #1985 — the Professional Service a member chose to consume for a booking when
 * more than one of the services the event accepts has a balance. NULL (every
 * booking written before, and any booking for an event that names no service,
 * or where only one service qualified) means "spend by the default order".
 * The ledger still records what was actually spent; this only steers which
 * service the spend is taken from.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('calendar_event_bookings', 'professional_service_id'))) {
    await knex.raw('ALTER TABLE calendar_event_bookings ADD COLUMN professional_service_id INT UNSIGNED NULL');
    await knex.raw(
      'ALTER TABLE calendar_event_bookings ADD CONSTRAINT fk_ceb_professional_service FOREIGN KEY (professional_service_id) REFERENCES professional_services (id) ON DELETE SET NULL',
    );
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('calendar_event_bookings', 'professional_service_id')) {
    await knex.raw('ALTER TABLE calendar_event_bookings DROP FOREIGN KEY fk_ceb_professional_service');
    await knex.raw('ALTER TABLE calendar_event_bookings DROP COLUMN professional_service_id');
  }
};
