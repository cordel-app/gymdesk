/**
 * #59: Center — a physical-location subdivision inside a Gym tenant.
 * status is text + named CHECK, same convention as rooms/class_types/etc.
 * Soft-delete-aware uniqueness on (gym_id, name): a VIRTUAL generated
 * column collapses to NULL for deleted rows, so a deleted center's name
 * can be reused (MySQL has no partial/filtered indexes) — same technique
 * as bookings.active_booking_key (migration 014).
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('centers')) return;
  await knex.schema.createTable('centers', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.string('name', 255).notNullable();
    t.string('code', 50);
    t.string('address', 500);
    t.string('phone', 50);
    t.string('email', 255);
    t.string('status', 20).notNullable().defaultTo('active');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.datetime('modified_at');
    t.integer('modified_by_membership_id').unsigned()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');
    t.datetime('deleted_at');
  });
  await knex.raw(
    "ALTER TABLE centers ADD CONSTRAINT centers_status_check " +
    "CHECK (status IN ('active','inactive'))",
  );
  await knex.raw(
    "ALTER TABLE centers ADD COLUMN active_name_key VARCHAR(255) " +
    "GENERATED ALWAYS AS (IF(deleted_at IS NULL, name, NULL)) VIRTUAL",
  );
  await knex.raw(
    "ALTER TABLE centers ADD UNIQUE KEY centers_gym_active_name_unique (gym_id, active_name_key)",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE centers DROP CHECK centers_status_check').catch(() => {});
  await knex.schema.dropTableIfExists('centers');
};
