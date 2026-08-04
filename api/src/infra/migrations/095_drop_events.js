/**
 * @param {import('knex').Knex} knex
 */
exports.up = async (knex) => {
  await knex.schema.dropTableIfExists('event_bookings');
  await knex.schema.dropTableIfExists('events');
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async (_knex) => {
  // Down intentionally left empty — the Event entity is permanently removed (#221).
};
