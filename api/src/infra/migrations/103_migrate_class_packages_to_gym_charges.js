/**
 * #271: Migrate class_packages rows into gym_charges as custom Sellable Items.
 *
 * - Adds class_package_id FK on gym_charges for traceability.
 * - Copies all class_packages (incl. soft-deleted) as type='sessions' custom items.
 * - validity_days and price are carried over; package_information from notes.
 */
exports.up = async (knex) => {
  // Add traceability FK
  const hasRef = await knex.schema.hasColumn('gym_charges', 'class_package_id');
  if (!hasRef) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.integer('class_package_id').unsigned().nullable()
        .references('id').inTable('class_packages').onDelete('SET NULL');
    });
  }

  // Migrate class_packages rows that haven't already been migrated.
  // charge_type_id is omitted (NULL) — made nullable by migration 102.
  // availability kept in sync with status for backward compat with legacy API callers.
  // currency: class_packages have no currency field; all existing packages are EUR.
  await knex.raw(`
    INSERT INTO gym_charges
      (gym_id, name, type, units, amount, currency, billing_frequency,
       status, availability, is_system, description, notes, package_information, validity_days,
       created_at, created_by_membership_id,
       modified_at, modified_by_membership_id,
       deleted_at, deleted_by_membership_id, deleted_by_name,
       class_package_id)
    SELECT
      cp.gym_id,
      cp.name,
      'sessions',
      cp.number_of_sessions,
      cp.price,
      'EUR',
      NULL,
      CASE WHEN cp.deleted_at IS NOT NULL THEN 'inactive'
           WHEN cp.status = 'active' THEN 'active'
           ELSE 'inactive' END,
      CASE WHEN cp.deleted_at IS NOT NULL THEN 'unavailable'
           WHEN cp.status = 'active' THEN 'available'
           ELSE 'unavailable' END,
      0,
      cp.description,
      cp.notes,
      NULL,
      cp.validity_days,
      cp.created_at,
      cp.created_by_membership_id,
      cp.modified_at,
      cp.modified_by_membership_id,
      cp.deleted_at,
      cp.deleted_by_membership_id,
      NULL,
      cp.id
    FROM class_packages cp
    WHERE NOT EXISTS (
      SELECT 1 FROM gym_charges gc WHERE gc.class_package_id = cp.id
    )
  `);
};

exports.down = async (knex) => {
  // Remove migrated class package rows
  await knex('gym_charges').whereNotNull('class_package_id').delete();

  const hasRef = await knex.schema.hasColumn('gym_charges', 'class_package_id');
  if (hasRef) {
    await knex.schema.alterTable('gym_charges', (t) => t.dropColumn('class_package_id'));
  }
};
