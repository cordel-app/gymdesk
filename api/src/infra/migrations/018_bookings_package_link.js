/**
 * P3.3 (#23): remember which user_class_package a booking debited (if any).
 * SET NULL on parent delete so the booking's audit trail survives even after
 * a package is cancelled.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasColumn('bookings', 'user_class_package_id')) return;
  await knex.schema.alterTable('bookings', (t) => {
    t.integer('user_class_package_id').unsigned()
      .references('id').inTable('user_class_packages').onDelete('SET NULL');
  });
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('bookings', 'user_class_package_id'))) return;
  await knex.raw('ALTER TABLE bookings DROP FOREIGN KEY bookings_user_class_package_id_foreign').catch(() => {});
  await knex.schema.alterTable('bookings', (t) => t.dropColumn('user_class_package_id'));
};
